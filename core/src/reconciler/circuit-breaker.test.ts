/**
 * core/src/reconciler/circuit-breaker.test.ts
 *
 * Task 6.2 — per-provider circuit breaker + dependent blocking.
 *
 * Teeth (each pins one non-negotiable):
 *   - 3-state machine via the INJECTED clock: closed → (N consecutive
 *     failures) → open → (short-circuit, NO inner call) → (cooldown elapsed)
 *     → half-open probe → closed (success) | open (failure, cooldown restarts);
 *   - breaker-open is a classified `transient` ReconcileError (retryable next
 *     cycle; NEVER fatal/destructive — no rollback, no delete);
 *   - dependent blocking REUSES apply.ts's existing dependencyEdges/skip
 *     propagation: provider X open ⇒ X's action + transitive dependents
 *     blocked, an INDEPENDENT provider Y action still applied, NOTHING deleted;
 *   - contract-shaped snapshot parses against a faithful BY-VALUE MIRROR of the
 *     LIVE HealthReportSchema circuit-breaker element (name/state/failures/
 *     max_failures/last_failure) — rest.test.ts mirror precedent;
 *   - a CLOSED breaker is a transparent pass-through (observe/apply/verify
 *     byte-identical to the unwrapped provider — idempotency/3.5 unaffected);
 *   - fail-safe + no-leak: snapshot/error expose only name + counts + timestamp.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { CircuitBreaker, wrapWithBreaker } from "./circuit-breaker.js";
import type { Clock } from "./circuit-breaker.js";
import { applyPlan } from "./apply.js";
import { ReconcileError } from "../domain/errors.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { PlanItem } from "../domain/entities.js";

// ---------------------------------------------------------------------------
// BY-VALUE MIRROR of the LIVE console HealthReportSchema circuit-breaker
// element (console/src/api/contract.ts CircuitBreakerSchema). Mirror precedent
// = rest.test.ts. Task 6.4 + the live 4.6 oracle do the cross-package parse;
// this proves the breaker's serialized state conforms to the FROZEN shape.
// ---------------------------------------------------------------------------
const CircuitBreakerElementMirror = z.object({
  name: z.string(),
  state: z.string(),
  failures: z.number().optional(),
  max_failures: z.number().optional(),
  last_failure: z.string().optional(),
});

// ---------------------------------------------------------------------------
// A controllable fake provider + an injectable fake clock.
// ---------------------------------------------------------------------------

interface FakeProvider extends Provider {
  applyCalls: string[];
  observeCalls: string[];
  verifyCalls: string[];
  /** When set, the NEXT apply() throws this; cleared after it fires once. */
  failNext: ReconcileError | undefined;
}

function makeFakeProvider(name = "hetzner-cloud"): FakeProvider {
  const reality = new Set<string>();
  const fake: FakeProvider = {
    name,
    applyCalls: [],
    observeCalls: [],
    verifyCalls: [],
    failNext: undefined,

    async observe(scope: string): Promise<ObservedSlice> {
      fake.observeCalls.push(scope);
      return {
        scope,
        entities: [...reality].map((k) => ({
          key: k,
          payload: { name: k.slice(k.lastIndexOf(":") + 1) },
        })),
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      fake.verifyCalls.push(action.entity);
      return reality.has(action.entity);
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      fake.applyCalls.push(action.entity);
      if (fake.failNext) {
        const e = fake.failNext;
        fake.failNext = undefined;
        throw e;
      }
      const changed = !reality.has(action.entity);
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed };
    },
  };
  return fake;
}

/** A fake clock the test advances by hand — zero real timers. */
function makeClock(startMs = 0): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

const transientErr = (entity: string) =>
  new ReconcileError("transient", "upstream 503", { entity });

const ACT = (entity: string): PlanAction => ({
  op: "create",
  entity,
  desired: {},
});

// ===========================================================================
// State machine
// ===========================================================================

describe("CircuitBreaker — closed → open after N consecutive failures", () => {
  it("opens only after maxFailures CONSECUTIVE failures; a success resets the run", async () => {
    const inner = makeFakeProvider();
    const clock = makeClock();
    const cb = new CircuitBreaker(inner, {
      maxFailures: 3,
      cooldownMs: 1000,
      clock,
    });

    // 2 failures, then a success ⇒ run resets (breaker stays closed).
    inner.failNext = transientErr("server:a");
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow("upstream 503");
    inner.failNext = transientErr("server:a");
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow("upstream 503");
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().failures).toBe(2);

    await cb.apply(ACT("server:a")); // success ⇒ resets
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);

    // Now 3 CONSECUTIVE failures ⇒ open.
    for (let i = 0; i < 3; i++) {
      inner.failNext = transientErr("server:a");
      await expect(cb.apply(ACT("server:a"))).rejects.toThrow();
    }
    expect(cb.snapshot().state).toBe("open");
    expect(cb.snapshot().failures).toBe(3);
  });
});

describe("CircuitBreaker — open short-circuits without calling inner", () => {
  it("an open breaker throws a classified transient ReconcileError and does NOT call the provider (fail-safe, retryable)", async () => {
    const inner = makeFakeProvider();
    const clock = makeClock();
    const cb = new CircuitBreaker(inner, {
      maxFailures: 2,
      cooldownMs: 5000,
      clock,
    });

    for (let i = 0; i < 2; i++) {
      inner.failNext = transientErr("server:a");
      await expect(cb.apply(ACT("server:a"))).rejects.toThrow();
    }
    expect(cb.snapshot().state).toBe("open");

    const callsBefore = inner.applyCalls.length;
    let caught: unknown;
    try {
      await cb.apply(ACT("server:a"));
    } catch (e) {
      caught = e;
    }
    // SHORT-CIRCUIT: inner.apply() NOT invoked.
    expect(inner.applyCalls.length).toBe(callsBefore);
    // Classified `transient` ⇒ retryable next cycle, NEVER fatal/destructive.
    expect(caught).toBeInstanceOf(ReconcileError);
    expect((caught as ReconcileError).errorClass).toBe("transient");
    expect((caught as ReconcileError).retryable).toBe(true);
  });
});

describe("CircuitBreaker — half-open probe after cooldown (injected clock)", () => {
  it("after cooldown the next call is a half-open probe; success → closed (counts reset)", async () => {
    const inner = makeFakeProvider();
    const clock = makeClock();
    const cb = new CircuitBreaker(inner, {
      maxFailures: 1,
      cooldownMs: 1000,
      clock,
    });

    inner.failNext = transientErr("server:a");
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow();
    expect(cb.snapshot().state).toBe("open");

    // Not yet elapsed ⇒ still short-circuits.
    clock.advance(999);
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow(/circuit breaker OPEN/);

    // Cooldown elapsed ⇒ probe allowed; success closes the breaker + resets.
    clock.advance(1);
    const r = await cb.apply(ACT("server:a"));
    expect(r.changed).toBe(true);
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);
  });

  it("a failed half-open probe re-opens the breaker and restarts the cooldown", async () => {
    const inner = makeFakeProvider();
    const clock = makeClock();
    const cb = new CircuitBreaker(inner, {
      maxFailures: 1,
      cooldownMs: 1000,
      clock,
    });

    inner.failNext = transientErr("server:a");
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow();
    expect(cb.snapshot().state).toBe("open");

    clock.advance(1000); // cooldown elapsed → probe allowed
    inner.failNext = transientErr("server:a");
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow("upstream 503");
    // Failed probe ⇒ back to open; cooldown restarts from the new failure.
    expect(cb.snapshot().state).toBe("open");

    // Only 999ms since the probe failure ⇒ still short-circuits (restarted).
    clock.advance(999);
    await expect(cb.apply(ACT("server:a"))).rejects.toThrow(/circuit breaker OPEN/);
    clock.advance(1);
    await cb.apply(ACT("server:a")); // now elapsed ⇒ probe succeeds → closed
    expect(cb.snapshot().state).toBe("closed");
  });
});

// ===========================================================================
// Dependent blocking — REUSES apply.ts's existing dependencyEdges propagation
// ===========================================================================

describe("CircuitBreaker — open provider blocks its action + dependents; independent provider proceeds; NOTHING deleted", () => {
  it("X open ⇒ X action + transitive dependents blocked; Y (independent) applied; no rollback/delete", async () => {
    // Provider X is already OPEN (pre-tripped). Provider Y is healthy.
    const x = makeFakeProvider("provider-x");
    const y = makeFakeProvider("provider-y");
    const clock = makeClock();
    const cbX = new CircuitBreaker(x, {
      maxFailures: 1,
      cooldownMs: 60_000,
      clock,
    });
    // Trip X open.
    x.failNext = transientErr("server:x1");
    await expect(cbX.apply(ACT("server:x1"))).rejects.toThrow();
    expect(cbX.snapshot().state).toBe("open");
    const xCallsAtOpen = x.applyCalls.length;

    // A composite-style provider: route server:x* / volume:x* to the OPEN
    // breaker, everything else to healthy Y. (Minimal inline router — proves
    // the breaker integrates via the SAME apply.ts edge model, no fork.)
    const routed: Provider = {
      name: "routed",
      observe: (s) => y.observe(s),
      verify: (a) => (a.entity.includes(":x") ? cbX.verify(a) : y.verify(a)),
      apply: (a) => (a.entity.includes(":x") ? cbX.apply(a) : y.apply(a)),
    };

    // Plan: X1 (open provider) → VOLX depends on X1 → Y1 independent.
    const X1 = "server:x1";
    const VOLX = "volume:xdata"; // depends on server:x1
    const Y1 = "server:y1"; // independent (healthy Y)
    const items: PlanItem[] = [
      { op: "create", entity: X1, change: "c", impact: "i" },
      { op: "create", entity: VOLX, change: "c", impact: "i" },
      { op: "create", entity: Y1, change: "c", impact: "i" },
    ];
    // The EXISTING apply.ts edge map: VOLX depends on X1 (X1 has no deps; Y1
    // independent). Reusing apply.ts's dependencyEdges/skip propagation.
    const dependencies = new Map<string, readonly string[]>([
      [X1, []],
      [VOLX, [X1]],
      [Y1, []],
    ]);

    const report = await applyPlan(routed, items, { dependencies });

    // X1 short-circuited (open) ⇒ recorded failed, classified transient.
    expect(report.failed.map((f) => f.entity)).toEqual([X1]);
    expect(report.failed[0]?.errorClass).toBe("transient");
    // Its transitive dependent VOLX is BLOCKED via the EXISTING edge model.
    expect(report.skipped.map((s) => s.entity)).toEqual([VOLX]);
    // The INDEPENDENT healthy-provider action still applied.
    expect(report.applied.map((a) => a.entity)).toEqual([Y1]);

    // FAIL-SAFE: the open breaker NEVER called X's provider again (no inner
    // apply for X1/VOLX) — nothing deleted, nothing rolled back.
    expect(x.applyCalls.length).toBe(xCallsAtOpen);
    expect(report.drift).toEqual([]);
  });
});

// ===========================================================================
// Contract-shaped snapshot — parses against the LIVE-mirrored schema element
// ===========================================================================

describe("CircuitBreaker — snapshot conforms to HealthReportSchema.circuit_breakers element", () => {
  it("serialized state parses against the by-value mirror; no extra/secret fields", async () => {
    const inner = makeFakeProvider("hetzner-dns");
    const clock = makeClock(1_700_000_000_000); // fixed instant
    const cb = new CircuitBreaker(inner, {
      maxFailures: 2,
      cooldownMs: 1000,
      clock,
    });

    // Before any failure: last_failure absent (schema .optional()).
    const fresh = cb.snapshot();
    expect(() => CircuitBreakerElementMirror.parse(fresh)).not.toThrow();
    expect(fresh).toEqual({
      name: "hetzner-dns",
      state: "closed",
      failures: 0,
      max_failures: 2,
    });
    expect("last_failure" in fresh).toBe(false);

    // Trip it open; last_failure now a string timestamp from the clock.
    for (let i = 0; i < 2; i++) {
      inner.failNext = transientErr("dns:rec");
      await expect(cb.apply(ACT("dns:rec"))).rejects.toThrow();
    }
    const open = cb.snapshot();
    expect(() => CircuitBreakerElementMirror.parse(open)).not.toThrow();
    expect(open.state).toBe("open");
    expect(open.max_failures).toBe(2);
    expect(open.failures).toBe(2);
    expect(typeof open.last_failure).toBe("string");
    expect(open.last_failure).toBe(new Date(1_700_000_000_000).toISOString());
    // NO-LEAK: only the 5 contract fields, nothing sensitive.
    expect(Object.keys(open).sort()).toEqual(
      ["failures", "last_failure", "max_failures", "name", "state"].sort(),
    );

    // state vocabulary is exactly closed|open|half-open.
    expect(["closed", "open", "half-open"]).toContain(open.state);
  });
});

// ===========================================================================
// Closed breaker is transparent (idempotency / 3.5 unaffected)
// ===========================================================================

describe("CircuitBreaker — a closed breaker is a transparent pass-through", () => {
  it("observe/apply/verify are byte-identical to the unwrapped provider on an all-success path", async () => {
    const raw = makeFakeProvider("p");
    const wrappedInner = makeFakeProvider("p");
    const clock = makeClock();
    const cb = wrapWithBreaker(wrappedInner, {
      maxFailures: 3,
      cooldownMs: 1000,
      clock,
    });

    const a = ACT("server:s1");

    // First apply: converges (changed:true) on BOTH.
    expect(await raw.apply(a)).toEqual(await cb.apply(a));
    // Second apply: idempotent no-op (changed:false) on BOTH — closed breaker
    // adds zero behaviour; the Fase-2 idempotency property stays green.
    const rawSecond = await raw.apply(a);
    const cbSecond = await cb.apply(a);
    expect(cbSecond).toEqual(rawSecond);
    expect(cbSecond.changed).toBe(false);

    expect(await cb.verify(a)).toBe(await raw.verify(a));
    expect([...(await cb.observe("server")).entities].sort()).toEqual(
      [...(await raw.observe("server")).entities].sort(),
    );
    // Never tripped: still closed, zero failures.
    expect(cb.snapshot().state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);
  });
});

// ===========================================================================
// Constructor guards (fail-safe config)
// ===========================================================================

describe("CircuitBreaker — config guards", () => {
  it("rejects maxFailures < 1 and cooldownMs <= 0 with a precondition error", () => {
    const inner = makeFakeProvider();
    const clock = makeClock();
    expect(
      () => new CircuitBreaker(inner, { maxFailures: 0, cooldownMs: 1, clock }),
    ).toThrow(ReconcileError);
    expect(
      () => new CircuitBreaker(inner, { maxFailures: 1, cooldownMs: 0, clock }),
    ).toThrow(ReconcileError);
  });
});
