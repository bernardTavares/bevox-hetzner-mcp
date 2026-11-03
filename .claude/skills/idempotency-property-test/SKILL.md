---
name: idempotency-property-test
description: |
  How to write a property-based test that asserts the central
  guarantee of bevox-hetzner-mcp: "applying any desired-state
  manifest N times converges, and cycle 2..N is a strict no-op."
  Pattern uses Vitest with a deterministic hand-rolled RNG
  (no fast-check dependency — none is declared in core/package.json).
  Sequence per sample: (observe -> plan -> apply -> observe-again ->
  plan-again-must-be-empty). Use BEFORE adding or extending a
  property test for a new provider / entity kind.
when_to_invoke: |
  - A new provider lands and the `provider-author` plan calls for a
    property test.
  - A new entity kind / PlanOp surface is added to an existing
    provider and the current property test does not cover it.
  - A bug in idempotency was found by hand and a regression property
    is needed.
  DO NOT use to "improve" a passing existing property test — the
  existing 7 property tests are the canonical contract teeth.
inputs:
  - Provider under test (factory + in-memory fake).
  - Entity space to generate samples from (Zod schema in
    `core/src/domain/entities.ts` or `entities-v2.ts`).
  - Whether the test runs at PROVIDER level (no DB, no reconciler,
    just `apply()` twice) or at RECONCILER level (full Observe -> Plan
    -> Gate -> Apply -> Record via the pg harness).
outputs:
  - File `core/src/reconciler/idempotency-<kind>.property.test.ts`.
  - Deterministic RNG seed documented at the top of the file.
  - Reference to the canonical conformance harness when applicable.
references:
  - references/property-pattern.md
---

# Skill: idempotency-property-test

## The invariant — write this at the top of your file

> Applying any desired-state manifest in the entity space N times
> converges, and cycle 2..N is a strict no-op:
> - every `applied` item has `changed === false`, AND
> - `failed` is empty, AND
> - observed reality is byte-identical to the post-cycle-1 snapshot.

This is the central guarantee. It is not "few mutations" or
"eventually stable". Converged ⇒ ZERO further writes, forever.

## When to use which level

### Provider-level property (no DB, no reconciler)

Cheaper. Uses `conformanceHarness(makeProvider, action, scope?)` from
`core/src/providers/provider.ts` for ONE action, or a hand-rolled
"apply -> apply -> assert no second write" loop for N random samples.

Canonical example: `core/src/reconciler/idempotency-firewall.property.test.ts`.

Use when:
- The provider has self-contained state (no cross-provider routing).
- You want fast feedback (a few hundred ms per sample).

### Reconciler-level property (pg harness, full cycle)

Authoritative. Drives `reconcile(deps)(input)` end-to-end with a
real Postgres (the pg harness in `core/test/fakes/pg-harness.ts`) and
a fake provider. Catches advisory-lock, StateEvent, and gate
interactions a provider-level test cannot.

Canonical example: `core/src/reconciler/idempotency.property.test.ts`.

Use when:
- The change affects multiple providers or the composite-provider /
  v2-wrap routing.
- A bug surfaced in reconcile.ts and the property test must reproduce
  it.

## Procedure

### 1. Preparatory reading

- `core/src/providers/provider.ts` (the port + `conformanceHarness`).
- `core/src/reconciler/idempotency.property.test.ts` (the canonical
  reconciler-level pattern).
- `core/src/reconciler/idempotency-firewall.property.test.ts` (the
  canonical provider-level pattern with deterministic RNG).
- `references/property-pattern.md` in this skill — the annotated
  template you will adapt.
- The Zod schema for the entity you are generating, in
  `core/src/domain/entities.ts` or `entities-v2.ts`.

### 2. Design decisions

| Question | Default |
|---|---|
| RNG | Hand-rolled Mulberry32 with a FIXED seed (no `Math.random`, no flaky retries). |
| Sample count | 12 samples per run is the established norm. Increase only if entity space is large. |
| Sample shape | Generate ONLY shapes that pass the Zod schema. Re-parse defensively; skip (do not fail) any sample that fails parsing. |
| State isolation | Fresh provider + fresh fake state per sample. For reconciler level: `resetSchema + runMigrations` per sample (see `pg-harness.ts`). |
| Network | NONE. In-memory fake only (or `core/test/fakes/*-http.ts` for HTTP backends). |
| Timers | NONE. No `setTimeout`, no `vi.useFakeTimers` unless the reconciler under test uses one (then control it explicitly). |
| Gate | Pass-through (`passThroughGate` from `reconcile.ts`) at reconciler level. The gate has its own tests; idempotency is about provider convergence, not gate decisions. |

### 3. File scaffold

Create exactly one file:

`core/src/reconciler/idempotency-<kind>.property.test.ts`

Open with a JSDoc header following the style of
`idempotency-firewall.property.test.ts`:

- Task reference (if any).
- Property under test (the invariant block above, written out).
- Generation strategy + seed.
- Scope boundary (what this property covers vs out-of-scope).

### 4. The two-cycle assertion — non-negotiable

For each sample:

```
cycle 1: apply(action)   ⇒ may change (changed:true) OR be a no-op (changed:false)
cycle 2: apply(action)   ⇒ MUST be changed:false AND zero new writes in the fake
verify(action)           ⇒ true throughout
observe(scope)           ⇒ includes the converged entity
```

For reconciler-level:

```
cycle 1: reconcile(...)  ⇒ records any convergence StateEvents
cycle 2: reconcile(...)  ⇒ applied items all changed:false; failed empty;
                            no spurious "mutating" StateEvent recorded
observed snapshot        ⇒ byte-identical to post-cycle-1 snapshot
```

### 5. Counting writes in the fake

The HTTP fakes under `core/test/fakes/` record every request. To
assert "the second cycle wrote nothing", capture the request count
BEFORE cycle 2 and assert EQUALITY after:

```typescript
const writesBefore = fake.recordedMutations.length;
await provider.apply(action);
expect(fake.recordedMutations.length).toBe(writesBefore);
```

If your fake doesn't expose this counter, add it (mutating endpoint
pushes; idempotency tests read).

### 6. Verification

```
npm --prefix core run typecheck
npm --prefix core test -- reconciler/idempotency-<kind>
npm --prefix core test                    # full suite must stay green
```

The property test must be deterministic: running it 10 times
produces identical pass/fail outcomes. If you see flakes, your RNG
seed is leaking, your fake retains state across samples, or your
schema generator emits invalid samples. Fix the test infra, not the
property.

## Checklist before declaring done

- [ ] File path is `core/src/reconciler/idempotency-<kind>.property.test.ts`.
- [ ] JSDoc header restates the invariant.
- [ ] Deterministic RNG (Mulberry32 or equivalent) with a fixed seed.
- [ ] Samples re-parse via Zod; invalid samples skipped (not failed).
- [ ] Two-cycle assertion present.
- [ ] Second cycle: `changed === false` for every applied item.
- [ ] Second cycle: zero new writes recorded in the fake.
- [ ] `observe()` round-trips reality faithfully (reconciler-level).
- [ ] No real network, no real timers, no `Math.random`.
- [ ] No new runtime dependency (especially: no `fast-check`).
- [ ] Test runs 10 times in a row with identical outcomes.

## Limits

- Do NOT relax the assertion to "few mutations" or "stabilises within
  K cycles". The contract is ZERO further writes after convergence.
- Do NOT introduce `fast-check` or any property-test framework.
  Hand-rolled deterministic RNG is the established pattern.
- Do NOT modify the existing property tests to "make them faster" or
  "cover more". They are the canonical contract teeth.
- Do NOT silence a property-test failure by reducing sample count or
  narrowing the generator. Investigate the provider.

## Language

JSDoc, comments, commit messages: ENGLISH.
