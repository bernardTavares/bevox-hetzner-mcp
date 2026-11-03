/**
 * core/src/reconciler/idempotency-load-balancer.property.test.ts
 *
 * Task F4.5 — central idempotency guarantee for the v2
 * HetznerLoadBalancerProvider. Mirrors F1.5 (firewall), F2.5 (primary-ip), and
 * F3.6 (certificate) verbatim (hand-rolled deterministic fuzz — no
 * fast-check dependency).
 *
 * Property under test, for EVERY random sample in the LoadBalancer input
 * space:
 *
 *   applying any LoadBalancer manifest N times converges, and cycles 2..N
 *   are a strict no-op (provider returns `changed:false` AND the wrapped
 *   Hetzner fake records ZERO additional non-GET HTTP calls, AND
 *   `verify()` is true).
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, fixed seed). ~10 random
 * LoadBalancers per run, each with a random algorithm / location /
 * health_check across all three protocol branches (http / https / tcp) and
 * a non-empty deterministic `targets` selector.
 *
 * Both `servicesProvider` and `serversProvider` return `[]`, so for every
 * fuzz sample the desired target set resolves to ∅ — the strict-equality
 * boundary the F4.3 provider walks as a no-op on cycle ≥2 (same posture as
 * F2.5 PrimaryIP with empty `serversProvider`).
 *
 * This sits in `core/src/reconciler/` (per the Bloco-A plan) but it is a
 * PROVIDER-level idempotency property — Bloco-A's v2 reconciler integration
 * lands later. The cycle ≥2 no-op guarantee IS the canonical idempotency
 * invariant the future reconciler builds on (spec-mãe §"idempotência por
 * design").
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerLoadBalancerProvider } from "../providers/v2/hetzner-load-balancer.js";
import type { LoadBalancer } from "../domain/entities-v2.js";
import { LoadBalancerSchema } from "../domain/entities-v2.js";

const BASE = "https://api.hetzner.cloud/v1";

// ---------------------------------------------------------------------------
// Deterministic RNG — Mulberry32 (32-bit, seedable, no extra dependency).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

// ---------------------------------------------------------------------------
// Random LoadBalancer generator. Produces shapes that PASS LoadBalancerSchema
// (we re-parse to be safe; any sample that fails parsing is skipped — never
// false-fails the property on a syntactically invalid sample).
//
// `targets` carries ONE deterministic selector clause `{ label: <pick> }`
// (non-empty as the schema requires). Under empty servicesProvider this
// resolves to ∅ — the F4.3 strict-equality boundary.
// ---------------------------------------------------------------------------

const LOCATIONS = ["fsn1", "nbg1", "hel1", "ash"] as const;
const ALGORITHMS = ["round_robin", "least_connections"] as const;
const HC_PROTOCOLS = ["http", "https", "tcp"] as const;
const SELECTOR_LABELS = ["lb-backend", "edge", "tier-web", "tier-api"] as const;
const HC_PATHS = ["/health", "/healthz", "/_status", "/readyz"] as const;
const HC_PORTS = [80, 443, 8080, 5432] as const;

function genHealthCheck(rng: () => number): Record<string, unknown> {
  const protocol = pick(rng, HC_PROTOCOLS);
  const base: Record<string, unknown> = {
    port: pick(rng, HC_PORTS),
    interval: 5 + Math.floor(rng() * 30), // 5..34
    timeout: 1 + Math.floor(rng() * 10), // 1..10
    retries: Math.floor(rng() * 5), // 0..4
    protocol,
  };
  if (protocol === "http" || protocol === "https") {
    base.path = pick(rng, HC_PATHS);
  }
  return base;
}

function genLoadBalancer(rng: () => number, ordinal: number): LoadBalancer {
  return {
    name: `fuzz-lb-${ordinal}`,
    location: pick(rng, LOCATIONS),
    algorithm: pick(rng, ALGORITHMS),
    targets: { label: pick(rng, SELECTOR_LABELS) },
    health_check: genHealthCheck(rng),
  } as LoadBalancer;
}

// ---------------------------------------------------------------------------
// The property: cycles 2..N per random LoadBalancer are a strict no-op.
// ---------------------------------------------------------------------------

const SEED = 0xd10539; // fixed seed — reproducible failures (distinct from F1.5 / F2.5 / F3.6)
const SAMPLES = 10;
const CYCLES = 4;

describe("LoadBalancer idempotency property (F4.5 — CENTRAL GUARANTEE)", () => {
  it(`applies ${SAMPLES} random LoadBalancers ${CYCLES}× each; cycles 2..${CYCLES} are a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    const fake = createHetznerHttpFake();

    // Track non-GET HTTP calls into the fake; cycles ≥2 must add ZERO writes.
    const writeCalls: { url: string; method: string }[] = [];
    const wrappedFetch: typeof fake.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        writeCalls.push({ url: String(url), method });
      }
      return fake.fetch(url, init);
    };
    const v2http = createHetznerV2HttpClient({
      token: "secret-token",
      baseUrl: BASE,
      fetchImpl: wrappedFetch,
    });

    const provider = createHetznerLoadBalancerProvider({
      http: v2http,
      // Empty service AND server snapshots → desired target set resolves to ∅
      // for every fuzz sample, which is the strict-equality boundary the F4.3
      // provider walks as a no-op on cycle ≥2 (same posture as F2.5).
      servicesProvider: async () => [],
      serversProvider: async () => [],
    });

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genLoadBalancer(rng, i);
      // Re-parse through the FROZEN schema; skip rare unparseable samples.
      const parsed = LoadBalancerSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const lb = parsed.data;
      const entityKey = `load_balancer:${lb.name}`;

      // Cycle 1: observe → null (fresh), apply must converge & report changed.
      const obs1 = await provider.observe(lb.name);
      expect(obs1, `${lb.name}: observed is null on cycle 1`).toBeNull();
      const writesBefore1 = writeCalls.length;
      const res1 = await provider.apply(lb, obs1);
      expect(res1.entity, `${lb.name}: entity key`).toBe(entityKey);
      expect(res1.changed, `${lb.name}: cycle 1 changed===true`).toBe(true);
      expect(
        writeCalls.length,
        `${lb.name}: cycle 1 made at least one write`,
      ).toBeGreaterThan(writesBefore1);
      // verify() must report converged after cycle 1.
      expect(
        await provider.verify(lb),
        `${lb.name}: verify() true after cycle 1`,
      ).toBe(true);

      // Cycles 2..N: observed reflects desired; apply must be a strict no-op.
      for (let c = 2; c <= CYCLES; c++) {
        const writesBefore = writeCalls.length;
        const obs = await provider.observe(lb.name);
        expect(obs, `${lb.name}: observed non-null on cycle ${c}`).not.toBeNull();
        const res = await provider.apply(lb, obs);
        expect(
          res.changed,
          `${lb.name}: cycle ${c} strict no-op (changed===false)`,
        ).toBe(false);
        expect(
          writeCalls.length - writesBefore,
          `${lb.name}: cycle ${c} issued ZERO HTTP writes`,
        ).toBe(0);
        expect(
          await provider.verify(lb),
          `${lb.name}: verify() true on cycle ${c}`,
        ).toBe(true);
      }
    }
  });
});
