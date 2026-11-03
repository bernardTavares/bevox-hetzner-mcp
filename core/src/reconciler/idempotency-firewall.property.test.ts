/**
 * core/src/reconciler/idempotency-firewall.property.test.ts
 *
 * Task F1.5 — central idempotency guarantee for the v2 HetznerFirewallProvider.
 *
 * Property under test, for EVERY random sample in the Firewall input space:
 *
 *   applying any Firewall manifest N times converges, and cycle 2..N is a
 *   strict no-op (provider returns `changed:false` AND the in-memory Hetzner
 *   fake records ZERO additional mutations).
 *
 * Hand-rolled deterministic fuzz (no fast-check dependency — none is declared
 * in `core/package.json` and we are NOT introducing a new runtime dep):
 *
 *   - Linear-congruential RNG seeded with a fixed value (reproducible).
 *   - 12 random firewalls per run, each with 1-5 random rules (in/out,
 *     protocol-aware port emission).
 *   - applied_to selectors only ever produce the empty server-id set for
 *     this provider-level property (we pass an empty serversProvider), which
 *     is the strict-equality boundary the v2 provider's `apply()` ALSO walks
 *     (set-semantics no-op on the empty intersection).
 *
 * This sits in `core/src/reconciler/` (per Task F1.5 plan) but it is a
 * PROVIDER-level idempotency property — Bloco-A's v2 reconciler integration
 * lands later (F5.4). The 2-cycle guarantee per sample IS the canonical
 * idempotency invariant the future reconciler builds on (spec-mãe
 * §"idempotência por design").
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerFirewallProvider } from "../providers/v2/hetzner-firewall.js";
import type { Firewall, FirewallRule } from "../domain/entities-v2.js";
import { FirewallSchema } from "../domain/entities-v2.js";

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

function randInt(rng: () => number, loInclusive: number, hiInclusive: number): number {
  return Math.floor(rng() * (hiInclusive - loInclusive + 1)) + loInclusive;
}

// ---------------------------------------------------------------------------
// Random Firewall generator. Generates ONLY shapes that pass FirewallSchema
// (we re-parse to be safe; any sample that fails parsing is skipped — never
// false-fails the property on a syntactically invalid sample).
// ---------------------------------------------------------------------------

const PROTOS_WITH_PORT = ["tcp", "udp", "esp", "gre"] as const;
// "icmp" forbids a port — handled separately.

function genRule(rng: () => number, idx: number): FirewallRule {
  const direction: "in" | "out" = rng() < 0.6 ? "in" : "out";
  const useIcmp = rng() < 0.15;
  const protocol = useIcmp ? "icmp" : pick(rng, PROTOS_WITH_PORT);
  // Pull a few non-SSH ports to avoid the SSH-from-0.0.0.0/0 guard tripping.
  const port = useIcmp ? undefined : pick(rng, ["80", "443", "8080", "1000-2000"]);
  // CIDR set fixed per-rule for determinism; allow set-semantics to dedup.
  const sourceIps = ["10.0.0.0/8", "192.168.0.0/16"];
  const destIps = ["10.0.0.0/8"];
  if (direction === "in") {
    return {
      direction: "in",
      protocol,
      ...(port !== undefined ? { port } : {}),
      source_ips: sourceIps,
    } as FirewallRule;
  }
  return {
    direction: "out",
    protocol,
    ...(port !== undefined ? { port } : {}),
    destination_ips: destIps,
  } as FirewallRule;
}

function genFirewall(rng: () => number, ordinal: number): Firewall {
  const n = randInt(rng, 1, 5);
  const rules: FirewallRule[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const r = genRule(rng, i);
    // Dedup under set semantics so we don't generate redundant equivalents
    // (the provider's rule equality is set-based; duplicates would still be
    // valid but inflate the cycle-1 mutation count meaninglessly).
    const k = `${r.direction}|${r.protocol}|${(r as { port?: string }).port ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rules.push(r);
  }
  // ensure at least one rule survives dedup
  if (rules.length === 0) {
    rules.push({
      direction: "in",
      protocol: "tcp",
      port: "443",
      source_ips: ["0.0.0.0/0"],
    });
  }
  return {
    name: `fuzz-fw-${ordinal}`,
    rules,
    applied_to: { label: `fuzz-${ordinal}` },
  } as Firewall;
}

// ---------------------------------------------------------------------------
// The property: 2nd apply per random firewall is a strict no-op.
// ---------------------------------------------------------------------------

const SEED = 0x1f5_5eed; // fixed seed → reproducible failures
const SAMPLES = 12;

describe("Firewall idempotency property (F1.5 — CENTRAL GUARANTEE)", () => {
  it(`applies ${SAMPLES} random firewalls N times; cycle 2..N is a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    const fake = createHetznerHttpFake();
    const v2http = createHetznerV2HttpClient({
      token: "secret-token",
      baseUrl: BASE,
      fetchImpl: fake.fetch,
    });
    const provider = createHetznerFirewallProvider({
      http: v2http,
      // Empty server set → applied_to resolves to ∅ for every fuzz selector,
      // which is the strict-equality boundary the provider's apply() walks
      // as a no-op on cycle ≥2.
      serversProvider: async () => [],
    });

    // Track HTTP calls into the fake; cycle ≥2 must add ZERO write calls.
    const writeCalls: { url: string; method: string }[] = [];
    const wrappedFetch: typeof fake.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        writeCalls.push({ url: String(url), method });
      }
      return fake.fetch(url, init);
    };
    // Rebuild the http client around the wrapping fetch so we measure
    // EVERY write the provider issues (POST/PUT for firewalls).
    const v2httpTracked = createHetznerV2HttpClient({
      token: "secret-token",
      baseUrl: BASE,
      fetchImpl: wrappedFetch,
    });
    const providerTracked = createHetznerFirewallProvider({
      http: v2httpTracked,
      serversProvider: async () => [],
    });

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genFirewall(rng, i);
      // Re-parse through the FROZEN schema; skip any (rare) sample that fails
      // the SSH guard or other invariants — the property is about valid input.
      const parsed = FirewallSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const fw = parsed.data;

      // Cycle 1: observe → null (fresh), apply must converge & report changed.
      const obs1 = await providerTracked.observe(fw.name);
      expect(obs1, `${fw.name}: observed is null on cycle 1`).toBeNull();
      const writesBefore1 = writeCalls.length;
      const res1 = await providerTracked.apply(fw, obs1);
      expect(res1.entity, `${fw.name}: entity key`).toBe(`firewall:${fw.name}`);
      expect(res1.changed, `${fw.name}: cycle 1 changed===true`).toBe(true);
      const writesAfter1 = writeCalls.length;
      expect(
        writesAfter1,
        `${fw.name}: cycle 1 made at least one write`,
      ).toBeGreaterThan(writesBefore1);

      // Cycles 2..4: observed reflects desired; apply must be a strict no-op.
      for (let c = 2; c <= 4; c++) {
        const writesBefore = writeCalls.length;
        const obs = await providerTracked.observe(fw.name);
        expect(obs, `${fw.name}: observed non-null on cycle ${c}`).not.toBeNull();
        const res = await providerTracked.apply(fw, obs);
        expect(
          res.changed,
          `${fw.name}: cycle ${c} strict no-op (changed===false)`,
        ).toBe(false);
        expect(
          writeCalls.length - writesBefore,
          `${fw.name}: cycle ${c} issued ZERO HTTP writes`,
        ).toBe(0);
        // verify() must report converged.
        expect(
          await providerTracked.verify(fw),
          `${fw.name}: verify() true on cycle ${c}`,
        ).toBe(true);
      }
    }
  });
});
