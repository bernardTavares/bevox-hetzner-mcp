/**
 * core/src/reconciler/reconcile.ts
 *
 * The reconcile cycle: Observe → Plan → Gate → Apply → Record, per scope,
 * inside the per-scope advisory lock. This is the Fase-2 INTEGRATION seam
 * wiring the Fase-1 stores (working/observed/state-events/advisory-lock) to
 * the Fase-2 plan()/applyPlan()/Provider — it adds NO new domain logic.
 *
 * Design principles (spec §5):
 *
 *   - FIXED ORDER. Observe → Plan → Gate → Apply → Record, always, per scope.
 *     Observe reads the provider and persists the observed snapshot; Plan
 *     diffs the desired manifest against observed; Gate filters the plan; Apply
 *     drives the provider for the APPROVED items only; Record appends a
 *     StateEvent per outcome carrying the acting actor + scope.
 *
 *   - PER-SCOPE ADVISORY LOCK. The whole cycle runs inside
 *     withScopeLock(pool, scope, …). A second concurrent reconcile on the SAME
 *     scope is WITHHELD (acquired:false) — never run concurrently. A different
 *     scope is independent (different lock key) and is NOT blocked. A withheld
 *     cycle is itself recorded as an observable StateEvent (contention is not
 *     silent — see advisory-lock.ts consumer note).
 *
 *   - ACTOR IS MANDATORY & RECORDED. Every StateEvent records which agent
 *     triggered the cycle. A missing/blank actor is a precondition failure
 *     (ReconcileError("precondition")) raised BEFORE any side effect — never
 *     silently defaulted (spec: "todo StateEvent registra o agente ator").
 *
 *   - FAIL-SAFE, NO ROLLBACK. Nothing here deletes, undoes or compensates.
 *     Gate-denied items are WITHHELD (recorded result:"denied", never
 *     applied/removed). Observed drift is recorded informationally. Partial
 *     apply is reported as-is (apply.ts already guarantees no rollback; this
 *     module adds none).
 *
 *   - GATE IS AN INJECTED STRATEGY. The Approval Gate is a Fase-4 concern; the
 *     SEAM exists here (ReconcileGate) so Fase 4 drops in the real gate without
 *     touching reconcile internals. Fase-2 default = a pass-through that
 *     approves everything.
 *
 *   - IDEMPOTENT END-TO-END. A second reconcile of an already-converged scope
 *     performs zero provider mutations and records no spurious mutating event
 *     (a converged apply ⇒ changed:false ⇒ recorded result:"noop"). This
 *     underpins the Task 2.8 idempotency property.
 *
 * Exported API (ONLY these):
 *   reconcile(deps) → (input) → Promise<ReconcileResult>   — on-demand trigger
 *   schedulePeriodicReconcile(run, input, ms, timer?)       — periodic trigger
 *   interface ReconcileGate / GateContext / GateDecision / ReconcileDeps /
 *             ReconcileInput / ReconcileResult / WithheldItem / RecordFailure /
 *             TimerLike / PeriodicHandle / GitDriftSource / DriftSweepResult
 *   plus: runDriftSweep(deps) and DEFAULT_DRIFT_SWEEP_MS (Task 6.1).
 *
 * NOTE: a webhook/event-driven trigger is explicitly DEFERRED (out of Fase-2
 * scope — YAGNI); only on-demand + a minimal periodic timer hook exist here.
 * Task 6.1 adds a PERIODIC DRIFT SWEEP that REUSES this exact periodic timer
 * seam (NO second scheduler) and the proven reconcile()/detectDrift +
 * diffManifest detectors — it only OBSERVES and REPORTS drift, never corrects.
 */

import type pg from "pg";

import { plan, dependencyEdges, desiredPayloads } from "./plan.js";
import { applyPlan } from "./apply.js";
import type { AppliedItem, FailedItem } from "./apply.js";
import type { Provider, ObservedSlice } from "../providers/provider.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State, PlanItem } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";
import { withScopeLock } from "../store/advisory-lock.js";
import {
  getState as getObservedState,
  putState as putObservedState,
} from "../store/observed-store.js";
import { appendEvent } from "../store/state-events.js";
import { createApplyContext } from "../store/secrets.js";
import {
  detectDrift,
  detectObservedShrinkage,
  driftEventSpecs,
} from "./drift.js";
import type { DriftItem } from "./drift.js";
import { diffManifest } from "../store/manifest-repo.js";
import type { ManifestDriftItem } from "../store/manifest-repo.js";
import { noopLogger } from "../observability/logger.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Task 6.3 — cycle-level timeout hardening
// ---------------------------------------------------------------------------

/**
 * Default reconcile-cycle deadline (ms). A NAMED constant (single source of
 * truth). 5 minutes is deliberately GENEROUS: a normal converged cycle is
 * one provider observe + a pure plan + a bounded apply (each provider HTTP
 * call is itself capped by http-client's per-call timeout), completing in
 * well under a second. This ceiling therefore NEVER trips a healthy cycle
 * (no flap; the Fase-2 idempotency property, 3.5, 6.1, 6.2 and the 4.6 oracle
 * stay green) — it only bounds a genuinely stuck cycle so the per-scope lock
 * is not held indefinitely and the cycle stays recoverable next tick.
 */
export const DEFAULT_CYCLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Injectable cycle-timeout timer seam (test determinism — mirrors the
 * http-client `startTimeout` seam and the existing clock/timer discipline):
 * schedules `onElapsed` after `ms`, returns an idempotent cancel fn. Default =
 * a real (unref'd) setTimeout. Tests inject a deterministic controllable timer
 * so the suite uses NO real timers.
 */
export type StartTimeout = (ms: number, onElapsed: () => void) => () => void;

function defaultStartTimeout(ms: number, onElapsed: () => void): () => void {
  const t = setTimeout(onElapsed, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
}

// ---------------------------------------------------------------------------
// Gate seam — the Fase-4 Approval Gate plugs in HERE without touching internals
// ---------------------------------------------------------------------------

/**
 * The per-withheld-item open pending approval identity. ADDITIVE, optional
 * channel: a gate that mints/reuses a pending approval per withheld item
 * (Fase-4 Approval Gate) reports the EXACT approval id keyed by its own
 * `(scope, op, entity)` here, so a caller (the tool layer) surfaces the
 * approval that corresponds to the action it requested — never a scope-only
 * heuristic guess. `passThroughGate` and any non-approval gate omit it.
 */
export interface PendingApproval {
  readonly entity: string;
  readonly op: string;
  /** The exact `approvals.id` the gate opened/reused for this withheld item. */
  readonly approvalId: string;
}

/** The outcome of evaluating a plan: which items proceed, which are withheld. */
export interface GateDecision {
  /** Items approved to apply (a subset/all of the input, same shape). */
  readonly approved: readonly PlanItem[];
  /** Items withheld — recorded, NEVER applied or deleted (fail-safe). */
  readonly denied: readonly PlanItem[];
  /**
   * ADDITIVE & OPTIONAL (backward-compatible): for each withheld item the gate
   * opened/reused a pending approval for, its exact `(entity, op, approvalId)`.
   * Omitted/empty for the pass-through gate (nothing is gated). Existing
   * consumers that only read `approved`/`denied` are unaffected.
   */
  readonly pendingApprovals?: readonly PendingApproval[];
}

/**
 * The context passed to the gate for every evaluation: the scope being
 * reconciled and the acting agent. A NAMED, exported type (not an inline
 * anonymous shape) so the Fase-4 real Approval Gate can extend it (capability
 * scope, async human decision, per-item impact) without touching reconcile
 * internals.
 */
export interface GateContext {
  readonly scope: string;
  readonly actor: string;
}

/**
 * The Approval Gate strategy. Fase-2 default is a pass-through that approves
 * everything; Fase-4 drops in the real gate implementing this same interface.
 * The reconciler never inspects the concrete gate — only this contract.
 */
export interface ReconcileGate {
  readonly name: string;
  evaluate(
    items: readonly PlanItem[],
    ctx: GateContext,
  ): Promise<GateDecision>;
}

/** The Fase-2 default: approve every plan item (no human/policy gate yet). */
export const passThroughGate: ReconcileGate = {
  name: "pass-through",
  async evaluate(items) {
    return { approved: [...items], denied: [] };
  },
};

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/**
 * Injected dependencies. `observedAdapter` turns a provider ObservedSlice into
 * a typed State for the observed-store + plan() (the concrete provider→State
 * adapter is a later task; the seam is injectable so it stays testable and the
 * reconciler stays provider-agnostic). `loadDesired` is the desired-state
 * source for a scope (working-store / parsed manifest — supplied by the
 * caller; reconcile does not own manifest parsing — YAGNI).
 */
export interface ReconcileDeps {
  readonly pool: pg.Pool;
  readonly provider: Provider;
  readonly gate: ReconcileGate;
  readonly observedAdapter: (slice: ObservedSlice) => State;
  readonly loadDesired: (scope: string) => Promise<DesiredState>;
  /**
   * ADDITIVE & OPTIONAL (Task 6.3). Structured logger seam. Default
   * `noopLogger` ⇒ every existing caller/test is byte-identical (zero stdout
   * noise, no behaviour change). The Task-6.6 daemon wires `createPinoLogger()`
   * (the ratified pino); tests inject a capturing fake. Reconcile/apply/error
   * log lines carry `actor`+`scope`+`entity` (+ result/error class) and, by
   * call-site contract, NEVER a resolved secret value (1.9/3.3 — refs only).
   */
  readonly logger?: Logger;
  /**
   * ADDITIVE & OPTIONAL (Task 6.3). Cycle-level deadline (ms). If a whole
   * reconcile cycle exceeds this, it aborts CLEANLY (no fail-deleting, no
   * partial destructive rollback, the advisory lock released) and records a
   * `timeout`/`transient` outcome (recoverable next cycle). Default
   * DEFAULT_CYCLE_TIMEOUT_MS — generous; a healthy cycle is never tripped.
   */
  readonly cycleTimeoutMs?: number;
  /**
   * ADDITIVE & OPTIONAL (Task 6.3). Injectable cycle-timeout timer (test
   * determinism). Default = real unref'd setTimeout. Tests inject a controllable
   * timer so the suite uses no real timers.
   */
  readonly startTimeout?: StartTimeout;
}

export interface ReconcileInput {
  readonly scope: string;
  /** The acting agent id. Mandatory — blank ⇒ ReconcileError("precondition"). */
  readonly actor: string;
}

/** An item the gate withheld: recorded, never applied, never deleted. */
export interface WithheldItem {
  readonly entity: string;
  readonly op: string;
}

/**
 * A Record step that failed to persist. Apply ALREADY committed reality (and is
 * never rolled back — fail-safe), so a failed StateEvent append is pure
 * audit-trail information loss, NOT an apply failure. It is surfaced HERE as an
 * additive, non-fatal signal instead of throwing away the whole
 * ReconcileResult. Empty ⇒ every event recorded.
 */
export interface RecordFailure {
  readonly entity: string;
  readonly op: string;
  readonly message: string;
}

/**
 * The structured outcome of a reconcile cycle. `acquired:false` ⇒ the cycle
 * was WITHHELD by the per-scope advisory lock (a concurrent reconcile on the
 * same scope holds it) and nothing was observed/planned/applied.
 */
export interface ReconcileResult {
  readonly acquired: boolean;
  readonly applied: AppliedItem[];
  readonly failed: FailedItem[];
  readonly withheld: WithheldItem[];
  readonly drift: { entity: string }[];
  /**
   * Record-step failures (additive, backward-compatible). Empty ⇒ every
   * StateEvent was persisted. Non-empty ⇒ apply still happened and is reflected
   * in the other buckets; only the audit-trail append failed for these.
   */
  readonly recordFailures: RecordFailure[];
  /**
   * ADDITIVE, backward-compatible (Task 6.3). `true` ⇒ the cycle exceeded its
   * deadline and aborted CLEANLY: it stopped initiating further work, NOTHING
   * already applied was undone/deleted (fail-safe; apply.ts no-rollback), the
   * advisory lock was released, and the outcome was recorded as a
   * `timeout`/transient StateEvent (recoverable next cycle). Absent/false on
   * every normal cycle ⇒ existing consumers/tests are byte-unchanged.
   */
  readonly timedOut?: boolean;
  /**
   * ADDITIVE, backward-compatible parallel channel: for each withheld item the
   * gate opened/reused a pending approval for, its exact `(entity, op,
   * approvalId)`. `withheld` itself stays byte-identical `{entity,op}` (all
   * prior strict-equality tests stay green); a caller that needs the precise
   * approval id for the action it requested joins by `(op, entity)` HERE
   * instead of a scope-only requery. Empty for the pass-through gate.
   */
  readonly pendingApprovals: PendingApproval[];
}

// ---------------------------------------------------------------------------
// reconcile — Observe → Plan → Gate → Apply → Record (on-demand trigger)
// ---------------------------------------------------------------------------

/**
 * Build the on-demand reconcile trigger. `deps` is injected once; the returned
 * function runs ONE cycle per call for the given scope/actor.
 *
 * Throws ReconcileError("precondition") synchronously-in-promise if `actor` is
 * blank — BEFORE acquiring the lock or any side effect.
 */
export function reconcile(
  deps: ReconcileDeps,
): (input: ReconcileInput) => Promise<ReconcileResult> {
  const { pool, provider, gate, observedAdapter, loadDesired } = deps;
  const logger: Logger = deps.logger ?? noopLogger;
  const cycleTimeoutMs = deps.cycleTimeoutMs ?? DEFAULT_CYCLE_TIMEOUT_MS;
  const startTimeout = deps.startTimeout ?? defaultStartTimeout;

  return async function run(input: ReconcileInput): Promise<ReconcileResult> {
    const { scope } = input;
    const actor = input.actor;

    // --- precondition: actor is mandatory, never silently defaulted. ---
    if (!actor || actor.trim() === "") {
      throw new ReconcileError(
        "precondition",
        "reconcile: actor is required and must not be empty " +
          "(every StateEvent must record the acting agent)",
        { entity: scope },
      );
    }

    // Sentinel for a clean, fail-safe cycle abort (raised ONLY by the
    // phase-boundary deadline check below). It is caught INSIDE the locked
    // section so withScopeLock's finally still releases the advisory lock +
    // dedicated client (no leak) and the outcome is recorded — it NEVER
    // escapes as an unhandled throw and NEVER triggers any rollback.
    class CycleTimeout {}

    // The whole cycle runs inside the per-scope advisory lock.
    const outcome = await withScopeLock(pool, scope, async () => {
      // Arm the cycle deadline the instant we hold the lock. It only flips a
      // flag — it NEVER interrupts an in-flight provider call mid-flight (that
      // could orphan a half-applied resource); instead the cycle checks the
      // flag at PHASE BOUNDARIES and stops INITIATING further work. Anything
      // already applied stays applied (apply.ts no-rollback — fail-safe).
      let timedOut = false;
      const cancelDeadline = startTimeout(cycleTimeoutMs, () => {
        timedOut = true;
      });
      // If the deadline already fired, abort BEFORE starting more work.
      const checkDeadline = (): void => {
        if (timedOut) throw new CycleTimeout();
      };

      try {
        // === 1. OBSERVE — read the provider, persist observed snapshot. ===
        //
        // Task 5.1 (spec `2026-05-26-server-scope-transport-decoupling.md`
        // §4.3 / I3): BEFORE overwriting the observed-store with the new
        // snapshot, read the PRIOR snapshot for this scope and compute the
        // SHRINKAGE — entities that were observed last cycle and no longer
        // are. The canonical trigger is the `MANAGED_MESH=on→off` flip
        // shrinking `routes.server` from `[hetznerCloud, wireguard]` to
        // `[hetznerCloud]`: peer-derived `server:<name>` entities the
        // WireGuard provider used to surface vanish from the new observe.
        // Without this hook the operator would lose the audit trail of
        // those peers (full-replace `putState` drops their rows silently).
        //
        // FAIL-SAFE ABSOLUTE: shrinkage is REPORTED via a `result:"drift"`
        // StateEvent (recorded below in the Record phase). The reconciler
        // NEVER deletes the underlying resource (e.g. the WG peer remains
        // on the device); cleanup, if desired, is operator-driven and
        // out-of-band. The detection path here is PURE (`detectObservedShrinkage`).
        //
        // DEGRADE-SAFE READ: `getObservedState` strict-validates the persisted
        // snapshot via StateSchema.parse. If the prior rows fail validation
        // (legacy data written under a looser/older schema; the scope has
        // never been observed; a partial snapshot from a previous cycle that
        // crashed) we fall back to an EMPTY State for the comparison — the
        // new snapshot is still written, plan/apply still run; we simply
        // emit no shrinkage drift events this cycle. Fail-safe by
        // construction: a degraded read can ONLY suppress an informational
        // event — it cannot produce a destructive op.
        let previousObserved: State;
        try {
          previousObserved = await getObservedState(pool, scope);
        } catch {
          previousObserved = {
            servers: [],
            networks: [],
            volumes: [],
            services: [],
            dns: [],
            backups: [],
          };
        }
        const slice = await provider.observe(scope);
        const observed: State = observedAdapter(slice);
        // SPEC docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.2 (A3):
        // when reconcile runs for the synthetic meta-scope "manifest",
        // partition the State produced by the adapter into per-kind rows so
        // that get_state(scope=<kind>) and the periodic drift sweep see the
        // entities apply_manifest declared. The synthetic "manifest" scope
        // is NOT a valid observed_state.scope value going forward — its
        // rows are silently never written.
        if (scope === "manifest") {
          // Empty collections still call putObservedState — that lets the
          // full-replace semantics drain rows from a prior cycle where the
          // manifest had entities of that kind and now does not (still
          // fail-safe: a row in observed_state is a *snapshot of reality*;
          // absence reflects reality).
          const emptyState: State = { servers: [], networks: [], volumes: [], services: [], dns: [], backups: [] };
          await putObservedState(pool, "server",  { ...emptyState, servers:  observed.servers  });
          await putObservedState(pool, "network", { ...emptyState, networks: observed.networks });
          await putObservedState(pool, "volume",  { ...emptyState, volumes:  observed.volumes  });
          await putObservedState(pool, "service", { ...emptyState, services: observed.services });
          await putObservedState(pool, "dns",     { ...emptyState, dns:      observed.dns      });
          await putObservedState(pool, "backup",  { ...emptyState, backups:  observed.backups  });
        } else {
          await putObservedState(pool, scope, observed);
        }
        const shrinkage: DriftItem[] = detectObservedShrinkage(
          previousObserved,
          observed,
        );
        checkDeadline();

        // === 2. PLAN — diff desired manifest against observed. ===
        const desired = await loadDesired(scope);
        const items = plan(desired, observed);
        checkDeadline();

        // === 3. GATE — injected strategy decides what proceeds. ===
        const gateCtx: GateContext = { scope, actor };
        const decision = await gate.evaluate(items, gateCtx);
        checkDeadline();

        // === 4. APPLY — drive the provider for APPROVED items only. ===
        //  ALWAYS pass dependencies + desiredPayloads (production contract).
        //
        //  THIS IS THE GENUINE APPLY BOUNDARY (spec §5; secrets.ts; apply.ts):
        //  reconcile() is the sole sanctioned place to MINT the unforgeable
        //  secrets.ts ApplyContext. We mint it HERE — never in plan/Observe/
        //  Gate — and hand it to applyPlan(), which forwards it ONLY onto items
        //  that actually reach provider.apply() (drift/noop items never get it).
        //  A secret-aware provider (DockerProvider) then resolves `secret:<ref>`
        //  env bindings behind secrets.ts's gate AT APPLY. The token is opaque
        //  and carries NO secret material; absent a secret-aware provider it is
        //  inert (byte-identical behaviour). Minting it per cycle rebinds the
        //  capability to THIS apply boundary, keeping resolution structurally
        //  unreachable from plan/dry_run (Task 3.3 invariant, end-to-end 3.5).
        const report = await applyPlan(provider, decision.approved, {
          dependencies: dependencyEdges(desired),
          desiredPayloads: desiredPayloads(desired),
          applyContext: createApplyContext(),
        });

      // === 5. RECORD — a StateEvent per outcome, carrying actor + scope. ===
      //
      // FAIL-SAFE / NEVER MASK THE APPLY OUTCOME. applyPlan() above ALREADY
      // committed reality and is NEVER rolled back (spec §5). Record is the
      // audit trail, not part of the mutation. So a failed appendEvent (a DB
      // hiccup / pool error on a well-formed event) must NOT throw the whole
      // ReconcileResult away — that would be pure information loss: the apply
      // happened but the caller never learns. Therefore Record is BEST-EFFORT:
      // every append is attempted (one failure does NOT abort the rest), and
      // any failure is surfaced additively in `recordFailures` (NOT swallowed
      // into the void) while the result still reflects exactly what apply did.
      //
      // appendEvent's OWN precondition guards (blank actor/scope/result) are
      // programming errors and may still throw before/inside this loop — those
      // are not what we tolerate; only the runtime failure of a well-formed
      // append is caught here.
      const recordFailures: RecordFailure[] = [];
      const record = async (
        entity: string,
        op: string,
        result: string,
        after?: Record<string, unknown>,
      ): Promise<void> => {
        // STRUCTURED LOG (Task 6.3). actor+scope+entity (+op+result class)
        // ONLY — refs/classes, NEVER a resolved secret value (1.9/3.3). An
        // "error" outcome logs at error level; everything else at info.
        const fields = { actor, scope, entity, op, result };
        if (result === "error") logger.error(fields, "reconcile apply item");
        else logger.info(fields, "reconcile apply item");
        try {
          await appendEvent(pool, { actor, scope, op, entity, result, after });
        } catch (err) {
          recordFailures.push({
            entity,
            op,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };

      for (const a of report.applied) {
        // changed ⇒ this run mutated reality ("ok"); else idempotent no-op.
        await record(a.entity, a.op, a.changed ? "ok" : "noop");
        // Provider-surfaced events (additive, rev b §1.5): persist each with
        // the cycle actor+scope+after. They are outcomes (result:"ok"), not
        // failures — the apply item above already carries the mutation signal.
        for (const ev of a.events ?? []) {
          await record(a.entity, ev.op, "ok", ev.after);
        }
      }
      for (const f of report.failed) {
        await record(f.entity, f.op, "error");
      }
      // Gate-denied items: withheld, recorded, NEVER applied/deleted.
      for (const d of decision.denied) {
        await record(d.entity, d.op, "denied");
      }
      // Observed drift: informational only (fail-safe; never corrected here).
      for (const dr of report.drift) {
        await record(dr.entity, dr.op, "drift");
      }
      // Task 5.1 (spec `2026-05-26-server-scope-transport-decoupling.md`
      // §4.3 / I3): observed-surface shrinkage — entities present in the
      // PRIOR observed-state for this scope but absent from THIS cycle's
      // observe. The canonical trigger is the `MANAGED_MESH=on→off` flip:
      // peer-derived `server:<name>` entities the WireGuard provider used
      // to surface vanish when WG leaves `routes.server`. Recorded ONLY as
      // an informational `result:"drift"` StateEvent (no value, no mutating
      // op) — the underlying resource is NEVER deleted (fail-safe). The
      // event names the disappeared entity's stable key so the operator
      // can correlate with the underlying resource (e.g. `wgpub:<name>`
      // peer on the WG device) and clean up out-of-band if desired.
      for (const sh of shrinkage) {
        await record(sh.key, "drift", "drift");
      }

      const result: ReconcileResult = {
        acquired: true,
        applied: report.applied,
        failed: report.failed,
        // UNCHANGED shape: strictly `{entity,op}` (prior toEqual tests green).
        withheld: decision.denied.map((d) => ({
          entity: d.entity,
          op: d.op,
        })),
        drift: report.drift.map((d) => ({ entity: d.entity })),
        recordFailures,
        // ADDITIVE parallel channel: the gate's exact per-item approval ids
        // (empty for the pass-through gate). Caller joins by (op,entity).
        pendingApprovals: [...(decision.pendingApprovals ?? [])],
      };
        logger.info(
          {
            actor,
            scope,
            entity: scope,
            result: "ok",
            applied: report.applied.length,
            failed: report.failed.length,
          },
          "reconcile cycle complete",
        );
        return result;
      } catch (err) {
        if (err instanceof CycleTimeout) {
          // CLEAN, FAIL-SAFE CYCLE ABORT (spec §5 — "fail-safe, nunca
          // fail-deleting"; "sem rollback automático destrutivo"). We reached a
          // phase boundary AFTER the deadline elapsed and stopped initiating
          // further work. NOTHING is rolled back/deleted/undone: anything
          // applied before the boundary stays applied (apply.ts no-rollback);
          // unstarted work is simply not started. The advisory lock + client
          // are still released by withScopeLock's finally (we return normally
          // from fn — no leak). The cycle is recorded as a `timeout`/transient
          // outcome (recoverable: the NEXT clean cycle converges idempotently).
          const recordFailures: RecordFailure[] = [];
          try {
            await appendEvent(pool, {
              actor,
              scope,
              op: "noop",
              entity: scope,
              result: "timeout",
            });
          } catch (e) {
            recordFailures.push({
              entity: scope,
              op: "noop",
              message: e instanceof Error ? e.message : String(e),
            });
          }
          logger.error(
            {
              actor,
              scope,
              entity: scope,
              result: "timeout",
              errorClass: "transient",
              cycleTimeoutMs,
            },
            `reconcile cycle timeout after ${cycleTimeoutMs}ms ` +
              `(aborted cleanly; nothing rolled back; recoverable next cycle)`,
          );
          const timeoutResult: ReconcileResult = {
            acquired: true,
            applied: [],
            failed: [],
            withheld: [],
            drift: [],
            recordFailures,
            timedOut: true,
            pendingApprovals: [],
          };
          return timeoutResult;
        }
        // Any other error propagates UNCHANGED (withScopeLock's finally still
        // releases lock+client; no behaviour change vs before Task 6.3).
        throw err;
      } finally {
        // Disarm the deadline timer (cancel is idempotent) — a completed cycle
        // never leaks a pending timeout handle (no flap, no leaked timer).
        cancelDeadline();
      }
    });

    if (!outcome.acquired) {
      // Contention is observable, not silent (advisory-lock.ts consumer note).
      // Same best-effort rule as the Record loop, lower severity: no apply
      // happened here, but a failed contention-event must STILL not throw away
      // the { acquired:false } outcome — the caller must learn the cycle was
      // withheld. Surface the append failure additively in recordFailures.
      const recordFailures: RecordFailure[] = [];
      logger.info(
        { actor, scope, entity: scope, result: "withheld" },
        "reconcile cycle withheld (scope contention)",
      );
      try {
        await appendEvent(pool, {
          actor,
          scope,
          op: "noop",
          entity: scope,
          result: "withheld",
        });
      } catch (err) {
        recordFailures.push({
          entity: scope,
          op: "noop",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        acquired: false,
        applied: [],
        failed: [],
        withheld: [],
        drift: [],
        recordFailures,
        pendingApprovals: [],
      };
    }

    return outcome.result;
  };
}

// ---------------------------------------------------------------------------
// schedulePeriodicReconcile — minimal periodic trigger (injectable timer)
// ---------------------------------------------------------------------------

/** The slice of the timer API used here — injectable so tests use no real timer. */
export interface TimerLike {
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface PeriodicHandle {
  /** Stop the periodic trigger (clears the interval). */
  stop(): void;
  /** Await the most recent in-flight tick (test determinism helper). */
  flush(): Promise<void>;
}

/**
 * Register a periodic reconcile: every `ms` the injected timer fires one
 * reconcile(input) cycle. The timer is injectable (defaults to global timers)
 * so the test suite never starts a real interval. Overlapping ticks are
 * harmless — the per-scope advisory lock already serializes same-scope cycles
 * (a tick landing while one is in flight is simply withheld).
 *
 * Deliberately minimal (YAGNI): no backoff, no jitter, no drift detection in
 * the SCHEDULER itself. Webhook/event-driven triggers are explicitly DEFERRED.
 *
 * Task 6.1 REUSES this EXACT seam (it is generic over the run's result type —
 * a backward-compatible widening; the default type param keeps every existing
 * `ReconcileResult` caller byte-identical) to schedule the periodic DRIFT
 * SWEEP. No second scheduler is introduced.
 */
export function schedulePeriodicReconcile<R = ReconcileResult>(
  run: (input: ReconcileInput) => Promise<R>,
  input: ReconcileInput,
  ms: number,
  timer: TimerLike = globalThis as unknown as TimerLike,
): PeriodicHandle {
  let inFlight: Promise<unknown> = Promise.resolve();
  const handle = timer.setInterval(() => {
    // Swallow per-tick rejection: a failed cycle must not crash the scheduler;
    // the failure is already recorded as a StateEvent inside run().
    inFlight = run(input).catch(() => undefined);
  }, ms);

  return {
    stop() {
      timer.clearInterval(handle);
    },
    async flush() {
      await inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Task 6.1 — periodic DRIFT SWEEP (observe-only; NEVER corrects; fail-safe)
// ---------------------------------------------------------------------------

/**
 * Default periodic drift-sweep interval: 5 minutes. A named constant (not a
 * magic literal) so the daemon (Task 6.6) and tests reference ONE source of
 * truth. The sweep is cheap (one provider observe + two pure diffs) so a
 * 5-minute cadence reports drift promptly without hammering the provider.
 */
export const DEFAULT_DRIFT_SWEEP_MS = 5 * 60 * 1000;

/**
 * The working×git drift source for a scope (Task 6.1, the SECOND detector).
 * It loads the WORKING DesiredState and the GIT (canonical) DesiredState so
 * the sweep can run `diffManifest(working, git)` (manifest-repo.ts — the SAME
 * pure detector Task 1.8/4.8 use; no orphan/diff logic is duplicated).
 *
 * It is OPTIONAL on the sweep deps: when absent (no git repo configured /
 * unavailable) the sweep DEGRADES SAFELY — it skips ONLY this half, sets
 * `gitDriftSkipped:true`, and still runs the observed-side half. A loader that
 * THROWS at runtime (unreadable repo) is treated identically (non-fatal):
 * fail-safe — a missing git source must never crash the periodic daemon.
 */
export interface GitDriftSource {
  loadWorking(scope: string): Promise<DesiredState>;
  loadGit(scope: string): Promise<DesiredState>;
}

/**
 * Sweep deps = the reconcile deps (so it shares the SAME injected pool /
 * provider / observedAdapter / loadDesired) plus the OPTIONAL git-drift
 * source. The sweep deliberately reuses ReconcileDeps verbatim — it is the
 * same Observe input; it just stops BEFORE Plan/Gate/Apply (it never mutates).
 */
export interface DriftSweepDeps extends ReconcileDeps {
  readonly gitDriftSource?: GitDriftSource;
}

/**
 * The structured outcome of ONE periodic drift sweep. `acquired:false` ⇒ the
 * per-scope advisory lock was held by a concurrent reconcile and the sweep was
 * WITHHELD this tick (Task 2.7 contention semantics) — nothing observed, the
 * tick recorded as `withheld`, NOT blocked forever, NOT a crash.
 *
 * There is NO `applied`/`failed`/`withheld`-items channel BY DESIGN: a drift
 * sweep has no apply phase. It can ONLY report.
 */
export interface DriftSweepResult {
  readonly acquired: boolean;
  /** Observed-side orphans (detectDrift) — reported, never corrected. */
  readonly observedDrift: { entity: string; kind: string }[];
  /** Working×git divergences (diffManifest) — reported, never promoted. */
  readonly gitDrift: ManifestDriftItem[];
  /** true ⇒ the git-drift half was skipped (no/failed source) — non-fatal. */
  readonly gitDriftSkipped: boolean;
  /** Audit-append failures (same best-effort semantics as reconcile()). */
  readonly recordFailures: RecordFailure[];
}

/**
 * Build the periodic drift sweep trigger. The returned function runs ONE sweep
 * per call for the given scope/actor and is what {@link schedulePeriodicReconcile}
 * fires every {@link DEFAULT_DRIFT_SWEEP_MS} (reusing the Task-2.7 timer seam —
 * NO second scheduler).
 *
 * FAIL-SAFE ABSOLUTE (spec §5 — "drift reportado, nunca corrigido em
 * silêncio"; "fail-safe, nunca fail-deleting"). ONE sweep:
 *
 *   1. Acquires the per-scope advisory lock (REUSED Task-2.7 discipline) so it
 *      neither deadlocks nor races an on-demand reconcile. Cannot acquire ⇒
 *      WITHHELD this tick, recorded `result:"withheld"`, returns
 *      `acquired:false`. It is NEVER blocked forever and NEVER crashes.
 *   2. Observe-ONLY: reads the provider and persists the observed snapshot
 *      (identical to reconcile's Observe step — a read, not a mutation).
 *   3. Runs BOTH pure detectors: `detectDrift(desired, observed)` (observed
 *      orphans) AND, if a git-drift source is configured/available,
 *      `diffManifest(working, git)` (working×git). NO Plan, NO Gate, NO Apply
 *      — there is structurally no path to mutate desired/observed, delete a
 *      resource, or auto-promote working→git.
 *   4. Records each divergence as an APPEND-ONLY informational StateEvent via
 *      the SHARED `driftEventSpecs` projection: `op:"drift"`, `result:"drift"`,
 *      entity/scope/kind ONLY — never a value (no-leak), never a mutating op.
 *      Append is BEST-EFFORT (a failed append is surfaced in `recordFailures`,
 *      never thrown away — same rule as reconcile()).
 *
 * Throws ReconcileError("precondition") if `actor` is blank — BEFORE the lock
 * or any side effect (every StateEvent must record the acting agent).
 */
export function runDriftSweep(
  deps: DriftSweepDeps,
): (input: ReconcileInput) => Promise<DriftSweepResult> {
  const { pool, provider, observedAdapter, loadDesired, gitDriftSource } = deps;

  return async function sweep(
    input: ReconcileInput,
  ): Promise<DriftSweepResult> {
    const { scope } = input;
    const actor = input.actor;

    // --- precondition: actor mandatory, never silently defaulted. ---
    if (!actor || actor.trim() === "") {
      throw new ReconcileError(
        "precondition",
        "runDriftSweep: actor is required and must not be empty " +
          "(every StateEvent must record the acting agent)",
        { entity: scope },
      );
    }

    const outcome = await withScopeLock(pool, scope, async () => {
      // === OBSERVE (read-only) — same as reconcile's Observe step. ===
      const slice = await provider.observe(scope);
      const observed: State = observedAdapter(slice);
      await putObservedState(pool, scope, observed);

      // === DETECTOR A — observed-side orphans (pure; never corrects). ===
      const desired = await loadDesired(scope);
      const observedDriftItems: DriftItem[] = detectDrift(desired, observed);

      // === DETECTOR B — working×git (pure; never promotes). DEGRADE SAFE. ===
      let gitDriftItems: ManifestDriftItem[] = [];
      let gitDriftSkipped = true;
      if (gitDriftSource) {
        try {
          const [working, git] = await Promise.all([
            gitDriftSource.loadWorking(scope),
            gitDriftSource.loadGit(scope),
          ]);
          gitDriftItems = diffManifest(working, git);
          gitDriftSkipped = false;
        } catch {
          // Fail-safe: an unreadable/absent git source must NOT crash the
          // periodic daemon. Skip ONLY this half; the observed half stands.
          gitDriftItems = [];
          gitDriftSkipped = true;
        }
      }

      // === RECORD — append-only informational events (BEST-EFFORT). ===
      // ONE shared, value-free projection (drift.ts) — no per-call-site path
      // can emit a mutating op or leak a value. The sweep applies NOTHING.
      const recordFailures: RecordFailure[] = [];
      const specs = driftEventSpecs(observedDriftItems, gitDriftItems);
      for (const s of specs) {
        try {
          await appendEvent(pool, {
            actor,
            scope,
            op: s.op,
            entity: s.entity,
            result: s.result,
          });
        } catch (err) {
          recordFailures.push({
            entity: s.entity,
            op: s.op,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const result: DriftSweepResult = {
        acquired: true,
        observedDrift: observedDriftItems.map((d) => ({
          entity: d.key,
          kind: d.kind,
        })),
        gitDrift: gitDriftItems,
        gitDriftSkipped,
        recordFailures,
      };
      return result;
    });

    if (!outcome.acquired) {
      // Contention is observable, not silent (same rule as reconcile()):
      // a withheld tick is recorded; a failed append is surfaced, not thrown.
      const recordFailures: RecordFailure[] = [];
      try {
        await appendEvent(pool, {
          actor,
          scope,
          op: "noop",
          entity: scope,
          result: "withheld",
        });
      } catch (err) {
        recordFailures.push({
          entity: scope,
          op: "noop",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        acquired: false,
        observedDrift: [],
        gitDrift: [],
        gitDriftSkipped: true,
        recordFailures,
      };
    }

    return outcome.result;
  };
}
