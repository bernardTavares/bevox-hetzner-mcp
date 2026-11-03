# Property-Test Pattern

Annotated template + a worked excerpt from a real test in this repo.

## Template (provider-level, hand-rolled deterministic RNG)

Copy this scaffold into
`core/src/reconciler/idempotency-<kind>.property.test.ts` and adapt
the generator + provider wiring.

```typescript
/**
 * core/src/reconciler/idempotency-<kind>.property.test.ts
 *
 * Property under test, for EVERY random sample in the <kind> input
 * space:
 *
 *   applying any <kind> manifest N times converges, and cycle 2..N
 *   is a strict no-op (provider returns `changed:false` AND the
 *   in-memory fake records ZERO additional mutations).
 *
 * Hand-rolled deterministic fuzz — no fast-check dependency. RNG is
 * Mulberry32 seeded with a fixed value (reproducible).
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
// Import the provider factory + its v2/v1 HTTP client if needed
import { createXProvider } from "../providers/<path>/<name>.js";
import { XSchema, type X } from "../domain/entities[-v2].js";

const BASE = "https://api.hetzner.cloud/v1";
const SEED = 0xC0FFEE;          // fixed: change ONLY when the
                                 // generator changes intentionally.
const SAMPLES = 12;              // established norm in this repo.

// ---------- deterministic RNG -----------------------------------
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

// ---------- generator -------------------------------------------
function genSample(rng: () => number, idx: number): X {
  // Build a SAMPLE that passes XSchema. Re-parse defensively below.
  const sample: unknown = {
    name: `x-${idx}`,
    // ... fields specific to <kind>
  };
  return XSchema.parse(sample); // throws on invalid generator output
}

// ---------- property --------------------------------------------
describe("idempotency property: <kind>", () => {
  it("two-cycle apply is a strict no-op for every sample", async () => {
    const rng = mulberry32(SEED);

    for (let i = 0; i < SAMPLES; i++) {
      // Fresh fake + provider per sample — no state bleed.
      const fake = createHetznerHttpFake({ baseUrl: BASE });
      const provider = createXProvider({ /* opts wired to fake */ });

      let sample: X;
      try {
        sample = genSample(rng, i);
      } catch {
        continue; // skip invalid samples — never false-fail.
      }

      const action = {
        op: "upsert" as const,           // use a PlanOp that the
                                          // provider actually accepts
        entity: `x:${sample.name}`,
        desired: sample,
      };

      // CYCLE 1 — may converge (changed:true) or no-op already.
      const first = await provider.apply(action);
      expect(typeof first.changed).toBe("boolean");

      // After cycle 1, verify reality matches.
      expect(await provider.verify(action)).toBe(true);

      const writesBefore = fake.recordedMutations.length;

      // CYCLE 2 — MUST be a strict no-op.
      const second = await provider.apply(action);
      expect(second.changed).toBe(false);
      expect(fake.recordedMutations.length).toBe(writesBefore);
      expect(await provider.verify(action)).toBe(true);

      // observe() round-trips the entity.
      const obs = await provider.observe("<kind>");
      expect(obs.entities).toContain(action.entity);
    }
  });
});
```

### What the template guarantees

- Determinism: fixed `SEED` + Mulberry32 ⇒ identical samples every
  run.
- Independence: fresh fake + provider per iteration ⇒ no cross-sample
  state.
- Safety: re-parse via the Zod schema; skip invalid samples instead
  of false-failing.
- The two-cycle assertion is explicit and brittle on purpose:
  `changed === false` AND `fake.recordedMutations.length` unchanged.

## Worked example — Firewall provider

Real file:
`core/src/reconciler/idempotency-firewall.property.test.ts`

This test fuzzes random `Firewall` manifests with 1-5 rules each,
respecting the protocol-aware port emission (ICMP forbids port, TCP /
UDP / ESP / GRE allow one), and avoiding the SSH-from-0.0.0.0/0 guard
in the v2 firewall provider. It applies each sample twice against
`createHetznerFirewallProvider(...)` backed by
`createHetznerHttpFake(...)`, and asserts both `changed:false` on the
second cycle and zero new mutations recorded by the fake.

Key excerpts (paraphrased — see the real file for full code):

```typescript
const PROTOS_WITH_PORT = ["tcp", "udp", "esp", "gre"] as const;
// "icmp" forbids a port — handled separately.

function genRule(rng: () => number, idx: number): FirewallRule {
  const direction: "in" | "out" = rng() < 0.6 ? "in" : "out";
  const useIcmp = rng() < 0.15;
  const protocol = useIcmp ? "icmp" : pick(rng, PROTOS_WITH_PORT);
  const port = useIcmp ? undefined : pick(rng, ["80", "443", "8080", "1000-2000"]);
  // CIDR set fixed per-rule for determinism; allow set-semantics to dedup.
  // ...
}
```

The test is hand-rolled (no `fast-check`), deterministic (single
`SEED`), and runs in milliseconds per sample.

## Worked example — full reconciler cycle

Real file:
`core/src/reconciler/idempotency.property.test.ts`

This is the END-TO-END variant: it drives the real `reconcile(deps)
(input)` cycle under the per-scope advisory lock, with a fresh fake
in-memory provider per sample, `resetSchema + runMigrations` per
sample (via `core/test/fakes/pg-harness.ts`), and a pass-through
gate (`passThroughGate`). It asserts that cycle ≥ 2 yields:

- every `applied` item has `changed === false`,
- `failed` is empty,
- `recordFailures` is empty,
- observed reality is byte-identical to the post-cycle-1 snapshot.

Use this style only when the change crosses provider boundaries
(composite-provider routing, v2-wrap, advisory-lock semantics, gate
interaction). For single-provider changes, prefer the provider-level
template at the top of this document — it is an order of magnitude
faster and equally rigorous per the conformance harness in
`core/src/providers/provider.ts`.

## Anti-patterns to reject in code review

- `Math.random()` anywhere in the test (non-deterministic).
- `fast-check` import (not a dependency, do not add one).
- `setTimeout` or `await new Promise(r => setTimeout(r, ...))`
  (introduces real-clock flakiness).
- "Retry the assertion up to 3 times" — convergence is one cycle
  away after the first, always.
- Asserting `expect(second.changed).toBeFalsy()` (truthy/falsy is too
  loose — assert strict `false`).
- Asserting "fake.recordedMutations.length <= writesBefore + 1" — the
  contract is `===`, not `<=`.
- Sample count reduced to 1 or 2 to "make the test fast" — the
  established norm is 12.
