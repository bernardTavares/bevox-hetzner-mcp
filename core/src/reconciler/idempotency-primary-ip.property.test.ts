/**
 * core/src/reconciler/idempotency-primary-ip.property.test.ts
 *
 * Task F2.5 — central idempotency guarantee for the v2
 * HetznerPrimaryIPProvider. Mirrors the F1.5 firewall property test verbatim
 * (hand-rolled deterministic fuzz — no fast-check dependency).
 *
 * Property under test, for EVERY random sample in the PrimaryIP input space:
 *
 *   applying any PrimaryIP manifest N times converges, and cycle 2..N is a
 *   strict no-op (provider returns `changed:false` AND the in-memory Hetzner
 *   fake records ZERO additional mutations, and `verify()` is true).
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, fixed seed). 12 random
 * PrimaryIPs per run with random `name`/`type`/`location`/optional selector.
 * `serversProvider` returns `[]` so any `assignee_selector` resolves to ∅ —
 * which is exactly the strict-equality boundary the F2.3 provider walks as
 * a no-op on cycle ≥2 (matching the F1.5 fuzz posture).
 *
 * This sits in `core/src/reconciler/` (per the Bloco-A plan) but it is a
 * PROVIDER-level idempotency property — Bloco-A's v2 reconciler integration
 * lands later. The 2-cycle guarantee per sample IS the canonical idempotency
 * invariant the future reconciler builds on (spec-mãe §"idempotência por
 * design").
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerPrimaryIPProvider } from "../providers/v2/hetzner-primary-ip.js";
import type { PrimaryIP } from "../domain/entities-v2.js";
import { PrimaryIPSchema } from "../domain/entities-v2.js";

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
// Random PrimaryIP generator. Generates ONLY shapes that pass PrimaryIPSchema
// (we re-parse to be safe; any sample that fails parsing is skipped — never
// false-fails the property on a syntactically invalid sample).
// ---------------------------------------------------------------------------

const LOCATIONS = ["fsn1", "nbg1", "hel1", "ash"] as const;
const TYPES = ["ipv4", "ipv6"] as const;
const SELECTOR_LABELS = ["web", "api", "db", "edge"] as const;

function genPrimaryIp(rng: () => number, ordinal: number): PrimaryIP {
  const type = pick(rng, TYPES);
  const location = pick(rng, LOCATIONS);
  // ~70% have a selector (which under empty serversProvider resolves to ∅);
  // ~30% omit the selector entirely (the explicit "no assignee" path).
  const withSelector = rng() < 0.7;
  const base: Record<string, unknown> = {
    name: `fuzz-pip-${ordinal}`,
    type,
    location,
  };
  if (withSelector) {
    base.assignee_selector = { label: pick(rng, SELECTOR_LABELS) };
  }
  return base as PrimaryIP;
}

// ---------------------------------------------------------------------------
// The property: 2nd apply per random PrimaryIP is a strict no-op.
// ---------------------------------------------------------------------------

const SEED = 0x2c39d29; // fixed seed → reproducible failures (distinct from F1.5)
const SAMPLES = 12;
const CYCLES = 4;

describe("PrimaryIP idempotency property (F2.5 — CENTRAL GUARANTEE)", () => {
  it(`applies ${SAMPLES} random PrimaryIPs ${CYCLES}× each; cycle 2..${CYCLES} is a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    const fake = createHetznerHttpFake();

    // Track HTTP calls into the fake; cycle ≥2 must add ZERO write calls.
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
    const provider = createHetznerPrimaryIPProvider({
      http: v2http,
      // Empty server set → assignee_selector resolves to ∅ for every fuzz
      // selector, which is the strict-equality boundary the provider's
      // apply() walks as a no-op on cycle ≥2.
      serversProvider: async () => [],
    });

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genPrimaryIp(rng, i);
      // Re-parse through the FROZEN schema; skip any (rare) sample that fails
      // parsing — the property is about valid input.
      const parsed = PrimaryIPSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const pip = parsed.data;

      // Cycle 1: observe → null (fresh), apply must converge & report changed.
      const obs1 = await provider.observe(pip.name);
      expect(obs1, `${pip.name}: observed is null on cycle 1`).toBeNull();
      const writesBefore1 = writeCalls.length;
      const res1 = await provider.apply(pip, obs1);
      expect(res1.entity, `${pip.name}: entity key`).toBe(`primary_ip:${pip.name}`);
      expect(res1.changed, `${pip.name}: cycle 1 changed===true`).toBe(true);
      const writesAfter1 = writeCalls.length;
      expect(
        writesAfter1,
        `${pip.name}: cycle 1 made at least one write`,
      ).toBeGreaterThan(writesBefore1);
      // verify() must report converged after cycle 1.
      expect(
        await provider.verify(pip),
        `${pip.name}: verify() true after cycle 1`,
      ).toBe(true);

      // Cycles 2..N: observed reflects desired; apply must be a strict no-op.
      for (let c = 2; c <= CYCLES; c++) {
        const writesBefore = writeCalls.length;
        const obs = await provider.observe(pip.name);
        expect(obs, `${pip.name}: observed non-null on cycle ${c}`).not.toBeNull();
        const res = await provider.apply(pip, obs);
        expect(
          res.changed,
          `${pip.name}: cycle ${c} strict no-op (changed===false)`,
        ).toBe(false);
        expect(
          writeCalls.length - writesBefore,
          `${pip.name}: cycle ${c} issued ZERO HTTP writes`,
        ).toBe(0);
        expect(
          await provider.verify(pip),
          `${pip.name}: verify() true on cycle ${c}`,
        ).toBe(true);
      }
    }
  });
});
