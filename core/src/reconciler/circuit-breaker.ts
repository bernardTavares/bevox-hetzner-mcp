/**
 * core/src/reconciler/circuit-breaker.ts
 *
 * Task 6.2 — a per-provider, classic 3-state circuit breaker that WRAPS a
 * `Provider` (decorator) so the unchanged Observe→Plan→Gate→Apply→Record cycle
 * stops hammering a backend that is consistently failing, WITHOUT ever
 * deleting, rolling back or correcting anything (fail-safe absolute).
 *
 * Design principles (spec §5 — "fail-safe, nunca fail-deleting"; "sem rollback
 * automático destrutivo"; "idempotência por design"; YAGNI):
 *
 *   - CLASSIC 3-STATE MACHINE, PER PROVIDER, INJECTED CLOCK.
 *       closed   → calls pass through to the wrapped provider. A failed apply()
 *                  increments a CONSECUTIVE-failure count; a successful apply()
 *                  resets it to 0. After `maxFailures` CONSECUTIVE failures the
 *                  breaker → open.
 *       open     → calls SHORT-CIRCUIT: the wrapped provider is NOT called.
 *                  apply() throws a classified `transient` ReconcileError so
 *                  apply.ts records it like any retryable per-item failure and
 *                  the NEXT reconcile cycle re-evaluates after cooldown — it is
 *                  NEVER a fail-deleting / destructive outcome.
 *       half-open→ after `cooldownMs` measured via the INJECTED clock
 *                  (`lastFailure + cooldownMs <= now`), the next apply() is
 *                  allowed through as a single PROBE: success → closed (counts
 *                  reset); failure → back to open (cooldown restarts from the
 *                  new failure instant).
 *     All time flows through the injected clock — zero real timers/sleeps;
 *     tests advance a fake clock and the machine is fully deterministic.
 *
 *   - DEPENDENT BLOCKING REUSES THE EXISTING apply.ts MODEL. A breaker-open
 *     short-circuit is surfaced as a thrown classified ReconcileError from
 *     apply(). apply.ts already turns ANY per-item failure into: record the
 *     item failed + SKIP its transitive dependents via the authoritative
 *     `dependencyEdges` map. So the short-circuited provider's action AND its
 *     transitive dependents become blocked through the SAME proven
 *     dependency-edge/skip-propagation path — this module forks NOTHING and
 *     touches neither apply.ts nor reconcile.ts. Independent actions (other
 *     providers, or this provider once closed) continue untouched.
 *
 *   - CONTRACT-SHAPED STATE. {@link CircuitBreaker.snapshot} projects the
 *     breaker as EXACTLY the frozen `HealthReportSchema.circuit_breakers`
 *     element shape (console/src/api/contract.ts):
 *       { name:string, state:string, failures?:number,
 *         max_failures?:number, last_failure?:string }
 *     `state` uses the literal vocabulary "closed" | "open" | "half-open";
 *     `last_failure` is an ISO-8601 string from the INJECTED clock. The schema
 *     is FROZEN: this module conforms to it, never the reverse. Task 6.4 wires
 *     /api/health and the live 4.6 oracle parses this projection.
 *
 *   - FAIL-SAFE ABSOLUTE & NO LEAK. A breaker-open NEVER deletes / destroys /
 *     rolls back / silently corrects — it only WITHHOLDS the call and lets
 *     apply.ts block dependents, all recoverable on the next cycle after
 *     cooldown. The state/error expose ONLY provider name + counts + timestamp
 *     — no secret/sensitive material.
 *
 *   - CLOSED BREAKER IS TRANSPARENT. On an all-success path a closed breaker is
 *     a pure pass-through: observe/apply/verify results are byte-identical to
 *     the unwrapped provider, so the Fase-2 idempotency property and Task 3.5
 *     stay green (wrapping a Provider in a closed breaker changes no behaviour).
 *
 * Exported API (ONLY these):
 *   class CircuitBreaker implements Provider
 *   interface CircuitBreakerOptions / Clock
 *   type CircuitBreakerState
 *   interface CircuitBreakerSnapshot
 *   wrapWithBreaker(provider, options) → CircuitBreaker   (thin ergonomic ctor)
 */

import { ReconcileError } from "../domain/errors.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Injected clock — tests advance this; production passes the real Date.
// (Same shape/precedent as approval-gate.ts's Clock — no real timers/sleeps.)
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------
// State vocabulary — the contract's `state` literals (HealthReportSchema's
// circuit-breaker element types `state` as a free `z.string()`; we pin a
// stable, conventional 3-state vocabulary and never invent beyond it).
// ---------------------------------------------------------------------------

export type CircuitBreakerState = "closed" | "open" | "half-open";

/**
 * The contract-shaped projection: EXACTLY the frozen
 * `HealthReportSchema.circuit_breakers` element (console/src/api/contract.ts):
 *   name: string
 *   state: string
 *   failures?: number
 *   max_failures?: number
 *   last_failure?: string   (ISO-8601, from the injected clock)
 *
 * The optional fields are ALWAYS populated here (the schema makes them
 * optional; a faithful breaker can always report them) EXCEPT `last_failure`,
 * which is omitted until the first failure (no failure ⇒ no timestamp; the
 * schema's `.optional()` permits its absence).
 */
export interface CircuitBreakerSnapshot {
  readonly name: string;
  readonly state: string;
  readonly failures?: number;
  readonly max_failures?: number;
  readonly last_failure?: string;
}

export interface CircuitBreakerOptions {
  /** Consecutive apply() failures that trip closed → open. Must be >= 1. */
  readonly maxFailures: number;
  /** Cooldown before an open breaker allows a half-open probe (ms, > 0). */
  readonly cooldownMs: number;
  /** Injected clock — production: { now: () => new Date() }. */
  readonly clock: Clock;
}

// ---------------------------------------------------------------------------
// CircuitBreaker — a Provider decorator (one breaker wraps one provider)
// ---------------------------------------------------------------------------

/**
 * Wrap a single `Provider` in a per-provider circuit breaker. `observe()` and
 * `verify()` are READ-ONLY and ALWAYS pass straight through (a breaker must
 * never blind the reconciler's observation of reality — fail-safe: we still
 * want to SEE the world even when we WITHHOLD writes). Only `apply()` — the
 * mutating call apply.ts drives — feeds and is gated by the state machine.
 *
 * `name` mirrors the wrapped provider's name so the breaker snapshot keys by
 * `provider.name` (the unit a breaker wraps) and the composite cycle stays
 * provider-agnostic.
 */
export class CircuitBreaker implements Provider {
  readonly name: string;

  readonly #inner: Provider;
  readonly #maxFailures: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;

  #state: CircuitBreakerState = "closed";
  /** Consecutive failures since the last success (reset to 0 on success). */
  #failures = 0;
  /** Epoch ms of the most recent failure; undefined until the first one. */
  #lastFailureMs: number | undefined = undefined;

  constructor(inner: Provider, options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.maxFailures) || options.maxFailures < 1) {
      throw new ReconcileError(
        "precondition",
        `CircuitBreaker: maxFailures must be an integer >= 1 ` +
          `(got ${options.maxFailures})`,
        { entity: inner.name },
      );
    }
    if (!(options.cooldownMs > 0)) {
      throw new ReconcileError(
        "precondition",
        `CircuitBreaker: cooldownMs must be > 0 (got ${options.cooldownMs})`,
        { entity: inner.name },
      );
    }
    this.#inner = inner;
    this.name = inner.name;
    this.#maxFailures = options.maxFailures;
    this.#cooldownMs = options.cooldownMs;
    this.#clock = options.clock;
  }

  /**
   * READ-ONLY pass-through. The breaker never withholds observation: even an
   * open breaker must let the reconciler SEE reality (it only withholds
   * mutating apply() calls). Idempotency/transparency: identical to inner.
   */
  observe(scope: string): Promise<ObservedSlice> {
    return this.#inner.observe(scope);
  }

  /**
   * READ-ONLY pass-through (same rationale as observe()). verify() never
   * mutates and must stay truthful so apply.ts's post-apply verify keeps
   * working unchanged when the breaker is closed (transparency).
   */
  verify(action: PlanAction): Promise<boolean> {
    return this.#inner.verify(action);
  }

  /**
   * The single state-machine-gated call.
   *
   *  - open & cooldown NOT elapsed ⇒ SHORT-CIRCUIT: do NOT call inner; throw a
   *    classified `transient` ReconcileError. apply.ts records the item failed
   *    and SKIPS its transitive dependents via the existing dependencyEdges
   *    map (dependent-blocking, REUSED — not forked). transient ⇒ the next
   *    cycle retries after cooldown; NEVER a fail-deleting outcome.
   *  - open & cooldown elapsed ⇒ enter half-open and let ONE probe through.
   *  - closed / half-open ⇒ call inner; success resets (and closes a half-open
   *    probe); failure increments (and may trip → open / reopen).
   */
  async apply(action: PlanAction): Promise<ApplyResult> {
    if (this.#state === "open") {
      if (!this.#cooldownElapsed()) {
        // SHORT-CIRCUIT: withhold the call entirely (no inner.apply()).
        throw this.#openError(action);
      }
      // Cooldown elapsed — allow exactly ONE half-open probe.
      this.#state = "half-open";
    }

    try {
      const result = await this.#inner.apply(action);
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure();
      // Re-throw the ORIGINAL error untouched: apply.ts already classifies a
      // ReconcileError by its own class and records the failure + blocks
      // dependents. The breaker only counts; it never reclassifies the
      // provider's own failure (no information loss, no behaviour change vs
      // unwrapped on a closed breaker).
      throw err;
    }
  }

  /**
   * The contract-shaped state projection — EXACTLY the frozen
   * `HealthReportSchema.circuit_breakers` element. `last_failure` is an
   * ISO-8601 string (the schema types it `z.string().optional()`); it is
   * omitted until the first failure. No secret/sensitive material — only
   * provider name + counts + timestamp.
   */
  snapshot(): CircuitBreakerSnapshot {
    const base = {
      name: this.name,
      state: this.#state as string,
      failures: this.#failures,
      max_failures: this.#maxFailures,
    };
    return this.#lastFailureMs === undefined
      ? base
      : {
          ...base,
          last_failure: new Date(this.#lastFailureMs).toISOString(),
        };
  }

  // --- internal state transitions -----------------------------------------

  #cooldownElapsed(): boolean {
    if (this.#lastFailureMs === undefined) return true;
    return this.#lastFailureMs + this.#cooldownMs <= this.#clock.now().getTime();
  }

  #onSuccess(): void {
    // closed: a success resets the consecutive-failure run.
    // half-open: a successful probe CLOSES the breaker (full recovery).
    this.#state = "closed";
    this.#failures = 0;
  }

  #onFailure(): void {
    this.#failures += 1;
    this.#lastFailureMs = this.#clock.now().getTime();
    if (this.#state === "half-open") {
      // A failed probe re-opens the breaker; cooldown restarts from this
      // new failure instant (lastFailure just updated above).
      this.#state = "open";
      return;
    }
    if (this.#failures >= this.#maxFailures) {
      this.#state = "open";
    }
  }

  #openError(action: PlanAction): ReconcileError {
    // `transient` so apply.ts treats it like a retryable per-item failure:
    // the item is recorded failed, its transitive dependents are blocked via
    // the EXISTING dependencyEdges propagation, and the NEXT cycle re-tries
    // after cooldown. NEVER fatal/destructive. Message carries ONLY the
    // provider name + counts (no secret/sensitive material — no leak).
    return new ReconcileError(
      "transient",
      `circuit breaker OPEN for provider "${this.name}" ` +
        `(${this.#failures}/${this.#maxFailures} consecutive failures) — ` +
        `call short-circuited, withheld; will retry after cooldown ` +
        `(no rollback; fail-safe)`,
      { entity: action.entity, retryAfterMs: this.#cooldownMs },
    );
  }
}

// ---------------------------------------------------------------------------
// wrapWithBreaker — thin ergonomic constructor (DRY at call sites)
// ---------------------------------------------------------------------------

/**
 * Wrap `provider` in a {@link CircuitBreaker}. Identical to `new
 * CircuitBreaker(provider, options)` — a named helper so call sites (Task 6.4
 * health wiring / 6.6 bootstrap) read intent-first and a registry can map
 * `provider.name → CircuitBreaker` uniformly.
 */
export function wrapWithBreaker(
  provider: Provider,
  options: CircuitBreakerOptions,
): CircuitBreaker {
  return new CircuitBreaker(provider, options);
}
