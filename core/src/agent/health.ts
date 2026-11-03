/**
 * core/src/agent/health.ts
 *
 * Task 6.4 — the `GET /api/health` AGGREGATOR. A small, focused, PURE module
 * that folds the signals Tasks 6.1/6.2/6.3 ALREADY produce into EXACTLY the
 * frozen `HealthReportSchema` shape (console/src/api/contract.ts). rest.ts is
 * the thin adapter; ALL the fold lives here (matching the rest.ts thin-adapter
 * + 4.5b/5.4 read-seam discipline).
 *
 * Design principles (CLAUDE.md non-negotiables; contract.ts is FROZEN):
 *
 *   - AGGREGATE REAL SIGNALS, NO NEW TRACKING. The aggregator reads what the
 *     hardening tasks emit and NOTHING else:
 *       · 6.2 `CircuitBreaker.snapshot()`  → `circuit_breakers` (verbatim — the
 *         snapshot is ALREADY the exact frozen element shape) + `degraded`
 *         (every breaker NOT closed: open / half-open / a non-zero failure run);
 *       · 6.2/6.3 apply.ts buckets (a breaker-open short-circuit blocks the
 *         action AND its transitive dependents through the EXISTING
 *         dependency-edge skip path) → `blocked` (skipped + withheld items);
 *       · 6.1 periodic drift sweep + the last cycle's observed-side drift →
 *         `drift`;
 *       · the periodic reconciler state (last cycle instant/result, next-in,
 *         total cycles, current state) → `reconciler`.
 *     There is NO new persistent table / counter / tracker — the daemon (6.6)
 *     wires a read-only `HealthSource` over the live breaker registry + the
 *     last reconcile/drift snapshot it already holds.
 *
 *   - CONTRACT-EXACT, DOWNSTREAM TRUTH. The returned object MUST parse against
 *     the LIVE `HealthReportSchema` (the 4.6 oracle proves it with the REAL
 *     imported schema, under a genuine fault so the arrays are non-empty). If
 *     a real signal cannot be made contract-shaped the fix is HERE, never the
 *     contract. `reconciler` sub-fields are stringified to the schema's exact
 *     types (`last_cycle`/`last_result`/`next_cycle_in` are strings;
 *     `total_cycles` a number) — an absent timestamp/result is the empty
 *     string (NOT a fabricated value), exactly the placeholder's prior shape.
 *
 *   - NO LEAK. Only names / states / counts / ISO timestamps / entity-keys are
 *     surfaced — NEVER a secret value/token/password/resolved secret (1.9/3.3
 *     discipline). The breaker snapshot is already name+counts only; the apply
 *     buckets carry entity-keys + a safe class/reason; drift carries an
 *     entity-key + a safe detail. This module adds NO field that could carry
 *     secret material.
 *
 *   - BACKWARD-COMPAT, NO FLAP. A HEALTHY snapshot (no breakers, or all closed;
 *     no skipped/withheld/drift; reconciler idle/never-run) folds to the SAME
 *     all-clear contract-valid body the Task 4.4/4.5 placeholder returned
 *     (empty arrays; reconciler `{state, "", "", "", 0}`). Steady state ⇒
 *     identical output every call (pure function of the snapshot) — no flap.
 *
 * Exported API (ONLY these — minimal surface):
 *   interface HealthSnapshot / HealthSource   — the read-only injected seam
 *   function aggregateHealth(snapshot) → HealthReport-shaped object
 */

import type { CircuitBreakerSnapshot } from "../reconciler/circuit-breaker.js";

// ---------------------------------------------------------------------------
// The contract-shaped result (a structural mirror of the FROZEN
// HealthReportSchema element types — console/src/api/contract.ts is the
// authority; the 4.6 oracle parses this against the LIVE schema).
// ---------------------------------------------------------------------------

export interface HealthReportShape {
  readonly circuit_breakers: readonly CircuitBreakerSnapshot[];
  readonly degraded: readonly { entity: string; detail: string }[];
  readonly blocked: readonly { entity: string; reason: string }[];
  readonly drift: readonly { entity: string; detail: string }[];
  readonly reconciler: {
    readonly state: string;
    readonly last_cycle: string;
    readonly last_result: string;
    readonly next_cycle_in: string;
    readonly total_cycles: number;
  };
}

// ---------------------------------------------------------------------------
// The injected read-only seam — what the 6.6 daemon already holds. NONE of
// this is new tracking: it is a view over the live breaker registry + the
// last reconcile/drift result the periodic scheduler already produced.
// ---------------------------------------------------------------------------

/** A single entity blocked from applying (dependent-blocking / withheld). */
export interface BlockedSignal {
  readonly entity: string;
  /** Safe human-readable cause (names the upstream / breaker; no secret). */
  readonly reason: string;
}

/** A single observed/working×git divergence (6.1 sweep / last cycle). */
export interface DriftSignal {
  readonly entity: string;
  /** Safe detail (kind + entity-kind); never a secret value. */
  readonly detail: string;
}

/**
 * The periodic reconciler's last-known state. Times are passed as `Date`
 * (the injected-clock instants the daemon already holds) and stringified to
 * the contract's exact ISO string here; absent ⇒ the empty string (NOT a
 * fabricated value), matching the placeholder's prior shape.
 */
export interface ReconcilerSnapshot {
  /** e.g. "idle" | "running" | "withheld" | "timed-out" — a stable string. */
  readonly state: string;
  /** When the last cycle ran (undefined ⇒ never run yet). */
  readonly lastCycleAt?: Date;
  /** A stable summary of the last cycle's outcome (undefined ⇒ never run). */
  readonly lastResult?: string;
  /** Milliseconds until the next scheduled cycle (undefined ⇒ unknown). */
  readonly nextCycleInMs?: number;
  /** Total cycles run so far (0 ⇒ never run). */
  readonly totalCycles: number;
}

/**
 * The full read-only snapshot the aggregator folds. Every field is OPTIONAL /
 * defaultable so a missing source (existing callers / no-fault path) folds to
 * the all-clear contract-valid body (backward-compat, no flap).
 */
export interface HealthSnapshot {
  /** Live circuit-breaker registry snapshots (6.2). Default: none. */
  readonly breakers?: readonly CircuitBreakerSnapshot[];
  /** Entities blocked by an open breaker / dependent-blocking (6.2/6.3). */
  readonly blocked?: readonly BlockedSignal[];
  /** Observed/working×git drift from the 6.1 sweep / last cycle. */
  readonly drift?: readonly DriftSignal[];
  /** The periodic reconciler state (6.1/6.3). Default: never-run idle. */
  readonly reconciler?: ReconcilerSnapshot;
}

/** The injected read-only seam (the 6.6 daemon supplies the live view). */
export interface HealthSource {
  /**
   * A point-in-time read of the live signals. MUST be side-effect-free (it is
   * called from the authn-gated read route — no mutation, no StateEvent).
   */
  snapshot(): HealthSnapshot | Promise<HealthSnapshot>;
}

// ---------------------------------------------------------------------------
// aggregateHealth — the pure fold
// ---------------------------------------------------------------------------

/** ISO-8601 string for a Date, or "" when absent (no fabricated value). */
function isoOrEmpty(d: Date | undefined): string {
  return d === undefined ? "" : d.toISOString();
}

/**
 * A non-closed breaker (open / half-open) OR a closed breaker mid-failure-run
 * is a DEGRADED provider. `failures`/`max_failures` are optional in the frozen
 * element; treat an absent count as 0 (the snapshot always populates them, but
 * we stay defensive against the schema's optionality).
 */
function isDegraded(b: CircuitBreakerSnapshot): boolean {
  if (b.state !== "closed") return true;
  return (b.failures ?? 0) > 0;
}

/** A safe one-line detail for a degraded breaker (counts only — no secret). */
function degradedDetail(b: CircuitBreakerSnapshot): string {
  const f = b.failures ?? 0;
  const m = b.max_failures;
  const run = m === undefined ? `${f} failures` : `${f}/${m} failures`;
  return `breaker ${b.state} (${run})`;
}

/**
 * Fold a read-only {@link HealthSnapshot} into the FROZEN
 * `HealthReportSchema` shape. PURE: identical input ⇒ identical output (no
 * flap). An empty/healthy snapshot ⇒ the all-clear placeholder-shaped body
 * (backward-compatible). NO secret material can appear by construction.
 */
export function aggregateHealth(snapshot: HealthSnapshot): HealthReportShape {
  const breakers = snapshot.breakers ?? [];
  const blocked = snapshot.blocked ?? [];
  const drift = snapshot.drift ?? [];
  const rec: ReconcilerSnapshot = snapshot.reconciler ?? {
    state: "idle",
    totalCycles: 0,
  };

  return {
    // 6.2 snapshot is ALREADY the exact frozen element shape — verbatim.
    circuit_breakers: breakers.map((b) => ({ ...b })),
    degraded: breakers
      .filter(isDegraded)
      .map((b) => ({ entity: b.name, detail: degradedDetail(b) })),
    // 6.2/6.3: a breaker-open short-circuit blocks the action + its transitive
    // dependents via the EXISTING apply.ts dependency-edge skip path.
    blocked: blocked.map((x) => ({ entity: x.entity, reason: x.reason })),
    // 6.1 periodic sweep + last-cycle observed-side drift.
    drift: drift.map((x) => ({ entity: x.entity, detail: x.detail })),
    reconciler: {
      state: rec.state,
      last_cycle: isoOrEmpty(rec.lastCycleAt),
      last_result: rec.lastResult ?? "",
      next_cycle_in:
        rec.nextCycleInMs === undefined
          ? ""
          : `${Math.max(0, Math.floor(rec.nextCycleInMs / 1000))}s`,
      total_cycles: rec.totalCycles,
    },
  };
}
