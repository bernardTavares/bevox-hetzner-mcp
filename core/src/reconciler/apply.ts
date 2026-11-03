/**
 * core/src/reconciler/apply.ts
 *
 * Pure orchestration: execute an already-topo-ordered PlanItem[] against an
 * injected Provider, verifying each applied action, and report what happened
 * with FAIL-SAFE partial semantics. This is the "Apply" step of the
 * Observe→Plan→Gate→Apply→Record cycle; the Gate, StateEvent recording and the
 * per-scope advisory lock are wired in Task 2.7 — NOT here (YAGNI).
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; §"sem rollback automático destrutivo"):
 *
 *   - NO DESTRUCTIVE ROLLBACK, EVER. On a partial failure this function NEVER
 *     undoes, deletes or compensates an already-applied resource. It records
 *     what was applied, what failed (with its ErrorClass) and what was skipped
 *     (the transitive dependents of a failed item), and returns a structured,
 *     reportable ApplyReport. A partial outcome leaves reality CONSISTENT (no
 *     half-cleanup) and fully described.
 *
 *   - ERROR-CLASS-DRIVEN CONTROL FLOW (errors.ts). A failed item never aborts
 *     INDEPENDENT items. The class only changes the *recorded* classification;
 *     the propagation rule is uniform: a failed item ⇒ its transitive
 *     dependents are SKIPPED (reason: an upstream item failed), independent
 *     items CONTINUE. We deliberately do NOT special-case `fatal` into a
 *     whole-run abort: per the fail-safe principle the most informative,
 *     least-destructive outcome is to apply every independent item we still
 *     can and report the fatal one — a global abort would withhold progress
 *     and information without preventing any harm (we never roll back anyway).
 *     `transient` is treated as a terminal failure HERE: the provider/HTTP
 *     client already owns retry/backoff (Task 2.2); a second retry layer here
 *     would be a double-retry (YAGNI). `conflict` is recorded as needing
 *     attention and NEVER auto-corrected/deleted.
 *
 *   - POST-APPLY VERIFY. A successful apply() is followed by provider.verify().
 *     If verify() is false the resource did NOT converge: it is recorded as a
 *     FAILED item (class `conflict` — reality diverged from desired). This is a
 *     report, NOT a rollback.
 *
 *   - IDEMPOTENT NO-OP. Applying a plan whose items are already converged
 *     performs no writes (provider.apply ⇒ changed:false) and verify() stays
 *     true: apply over an already-applied plan is a no-op. (This underpins the
 *     Task 2.8 idempotency property test.)
 *
 *   - PURE. Drives only the injected Provider. No direct I/O, DB or network.
 *     Deterministic given a deterministic Provider.
 *
 * Exported API (ONLY these):
 *   applyPlan(provider, items, ctx?) → Promise<ApplyReport>
 *   interface ApplyReport / ApplyContext / AppliedItem / FailedItem / SkippedItem
 *
 * Task 3.3: ApplyContext gains an OPTIONAL `applyContext` (secrets.ts token).
 * applyPlan() is the apply boundary; it forwards that token ONLY onto items
 * that reach provider.apply(), enabling apply-only, gate-guarded secret
 * resolution in secret-aware providers. plan/dry_run never mint it.
 */

import { classify, ReconcileError } from "../domain/errors.js";
import type { ErrorClass } from "../domain/errors.js";
import type { PlanItem } from "../domain/entities.js";
import type { ApplyContext as SecretApplyContext } from "../store/secrets.js";
import type {
  Provider,
  PlanAction,
  PlanOp,
} from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Report shapes — enumerate every item's outcome, minimally (YAGNI).
// ---------------------------------------------------------------------------

/** An item whose apply() converged (or was a no-op) AND verified true. */
export interface AppliedItem {
  readonly entity: string;
  readonly op: PlanOp;
  /** false ⇒ already converged (idempotent no-op); true ⇒ this run mutated reality. */
  readonly changed: boolean;
  /**
   * Provider-surfaced StateEvents (additive, optional) forwarded verbatim from
   * ApplyResult.events. The reconciler Record step persists each with the cycle
   * actor+scope+after (spec 2026-05-28-manifest-schema-gaps.md rev b §1.5).
   */
  readonly events?: ReadonlyArray<{
    readonly op: string;
    readonly after?: Record<string, unknown>;
  }>;
}

/** An item that failed (apply threw, or post-apply verify() was false). */
export interface FailedItem {
  readonly entity: string;
  readonly op: PlanOp;
  readonly errorClass: ErrorClass;
  readonly message: string;
}

/** An item not attempted because a transitive dependency failed. */
export interface SkippedItem {
  readonly entity: string;
  readonly op: PlanOp;
  /** Human-readable cause (names the upstream failed entity). */
  readonly reason: string;
}

/** An observed-side drift item (plan op "drift"): reported only, never touched. */
export interface DriftItem {
  readonly entity: string;
  readonly op: PlanOp;
}

/**
 * The structured, reportable outcome of applying a plan. The four buckets are
 * disjoint and together account for every input item. A non-empty `failed`
 * (or `skipped`) means a PARTIAL apply — reality is left consistent and fully
 * described; NOTHING was rolled back.
 */
export interface ApplyReport {
  readonly applied: AppliedItem[];
  readonly failed: FailedItem[];
  readonly skipped: SkippedItem[];
  /** Fail-safe: orphan/divergence items surfaced for review, never modified. */
  readonly drift: DriftItem[];
}

/**
 * Optional orchestration context.
 *
 * `dependencies` is the reference-derived edge map from plan.ts's
 * `dependencyEdges(desired)` — entity key → the keys it depends on. It is the
 * SINGLE authoritative source for dependent-skip propagation: when an item
 * fails, every item whose transitive dependency chain includes it is skipped.
 *
 * If omitted, apply CANNOT prove which items are dependents, so it skips NONE
 * (fail-safe: never silently mis-skip an item that might be independent — we
 * would rather attempt an independent item than wrongly withhold it).
 *
 * ⚠ DEGRADED / TEST-ONLY MODE. The map-less path is fail-safe ONLY w.r.t. the
 * no-rollback principle: with no edge map apply does NOT prefer independents —
 * it has no way to know an item is a dependent, so the transitive dependents of
 * a failed item are STILL attempted on an unmet precondition (they will simply
 * fail or no-op on their own). That is acceptable for unit tests exercising a
 * single provider in isolation, but it is NOT the production contract.
 *
 * CONTRACT — Task 2.7 (reconcile wiring) MUST ALWAYS pass
 * `dependencies: dependencyEdges(desired)`. The production Observe→Plan→Gate→
 * Apply→Record path must never run map-less; map-less is reserved for tests and
 * degraded diagnostics. Downstream tasks (2.7/2.8) MUST NOT rely on map-less
 * dependent-skip behaviour — there is none.
 */
export interface ApplyContext {
  readonly dependencies?: ReadonlyMap<string, readonly string[]>;
  /**
   * Per-entity desired payload (plan.ts's `desiredPayloads(desired)`): entity
   * key → the concrete declared entity object. Used to populate
   * `PlanAction.desired` so a real Provider can converge toward the actual
   * desired entity. ADDITIVE & backward-compatible: when omitted (unit tests
   * exercising a single provider in isolation), `desired` falls back to `{}`
   * exactly as before — no prior behaviour changes. The production
   * Observe→Plan→Gate→Apply→Record path (Task 2.7) MUST pass this alongside
   * `dependencies` so the applied action carries the real payload.
   */
  readonly desiredPayloads?: ReadonlyMap<string, unknown>;

  /**
   * 3.3 APPLY-BOUNDARY SECRET TOKEN (OPTIONAL — additive, backward-compat).
   *
   * The unforgeable secrets.ts `ApplyContext`. THIS function is THE apply
   * boundary, so this is the correct (and only sanctioned) place for the
   * token to enter the per-action path: applyPlan() forwards it onto each
   * real action as `PlanAction.applyContext`, so a secret-aware provider can
   * resolve `secret:<ref>` env bindings at apply.
   *
   * SECURITY: it is forwarded ONLY onto items that actually reach
   * provider.apply() (op create/add/update/scale/…). It is NEVER attached to
   * a "drift"/"noop" item (those never call apply) and NEVER consulted by
   * plan.ts/dry_run (which never construct an ApplyContext). When omitted
   * (unit tests / no secrets), behaviour is byte-identical to before — no
   * action carries a token, no provider can resolve. Minting MUST happen at
   * the genuine apply step (reconcile, Task 2.7/4) — never in plan/dry_run.
   */
  readonly applyContext?: SecretApplyContext;
}

// ---------------------------------------------------------------------------
// applyPlan
// ---------------------------------------------------------------------------

/**
 * Execute `items` (assumed already topo-ordered by plan.ts) against
 * `provider`, verifying each applied action, with fail-safe partial semantics.
 *
 * Never throws for a per-item failure — every failure is captured in the
 * returned ApplyReport. (It only rejects if the Provider itself violates its
 * contract in a way we cannot classify, which classify() folds into `fatal`
 * and records, so in practice this resolves.)
 */
export async function applyPlan(
  provider: Provider,
  items: readonly PlanItem[],
  ctx?: ApplyContext,
): Promise<ApplyReport> {
  const applied: AppliedItem[] = [];
  const failed: FailedItem[] = [];
  const skipped: SkippedItem[] = [];
  const drift: DriftItem[] = [];

  // Build dependent-closure resolver from the authoritative edge map.
  // edges: entity → deps it needs. We invert to: failed entity → its
  // transitive dependents (the items to skip).
  const dependentsOf = buildDependentsResolver(ctx?.dependencies);

  // Entities that failed or were skipped: any item depending (transitively)
  // on one of these must itself be skipped, not attempted.
  const blocked = new Set<string>();
  const blockReason = new Map<string, string>();

  for (const item of items) {
    const op = item.op;

    // --- drift: fail-safe report ONLY; never apply/correct/delete. ---
    if (op === "drift") {
      drift.push({ entity: item.entity, op });
      continue;
    }

    // --- noop: nothing to do; record as a no-op applied item. ---
    if (op === "noop") {
      applied.push({ entity: item.entity, op, changed: false });
      continue;
    }

    // --- skip if a transitive dependency already failed/was skipped. ---
    if (blocked.has(item.entity)) {
      const reason =
        blockReason.get(item.entity) ??
        "skipped: an upstream dependency did not apply";
      skipped.push({ entity: item.entity, op, reason });
      continue;
    }

    const action: PlanAction = {
      op,
      entity: item.entity,
      // Real desired payload from plan.ts's authoritative desiredPayloads()
      // when the production path supplies it; `{}` only in the map-less
      // unit-test path (backward compatible — see ApplyContext docs).
      desired: ctx?.desiredPayloads?.get(item.entity) ?? {},
      // 3.3: forward the apply-boundary secret token ONLY onto items that
      // actually reach provider.apply() (we are past the drift/noop guards).
      // Undefined when secrets are not enabled ⇒ behaviour unchanged.
      applyContext: ctx?.applyContext,
    };

    let failure: { errorClass: ErrorClass; message: string } | undefined;
    // The idempotency signal of THIS run's single apply() call. A converged
    // provider that already matched returns changed:false ⇒ no-op. apply() is
    // invoked exactly once per item (calling it twice would defeat the no-op
    // accounting that underpins Task 2.8).
    let changed = false;
    let events: AppliedItem["events"];

    try {
      const result = await provider.apply(action);
      changed = result.changed;
      events = result.events;
      // POST-APPLY VERIFY: reality must now match desired.
      const ok = await provider.verify(action);
      if (!ok) {
        // Applied but did NOT converge — a post-apply inconsistency. This is a
        // divergence to REPORT (class conflict), NOT a trigger to roll back.
        failure = {
          errorClass: "conflict",
          message: `post-apply verify() returned false for ${item.entity} — applied but did not converge`,
        };
      }
    } catch (err) {
      failure = toFailure(err, item.entity);
    }

    if (failure === undefined) {
      // verify() true ⇒ converged. `changed` is the contract-honest signal
      // from this run's single apply() (false ⇒ idempotent no-op). events ride
      // verbatim (additive) for the Record step to persist with the actor.
      applied.push({
        entity: item.entity,
        op,
        changed,
        ...(events !== undefined ? { events } : {}),
      });
      continue;
    }

    // FAIL-SAFE: record the failure, do NOT roll back anything already done.
    failed.push({
      entity: item.entity,
      op,
      errorClass: failure.errorClass,
      message: failure.message,
    });

    // Propagate: every transitive dependent of this entity is now skipped.
    for (const dep of dependentsOf(item.entity)) {
      blocked.add(dep);
      if (!blockReason.has(dep)) {
        blockReason.set(
          dep,
          `skipped: upstream item "${item.entity}" failed ` +
            `(${failure.errorClass}) — its dependents are not attempted ` +
            `(no rollback; fail-safe)`,
        );
      }
    }
  }

  return { applied, failed, skipped, drift };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a thrown error into the recorded failure. A ReconcileError carries
 * its own class; anything else is run through classify() (default ⇒ fatal —
 * see errors.ts rationale: an unrecognised failure must not silently retry).
 */
function toFailure(
  err: unknown,
  entity: string,
): { errorClass: ErrorClass; message: string } {
  if (err instanceof ReconcileError) {
    return { errorClass: err.errorClass, message: err.message };
  }
  // Non-ReconcileError: no HTTP/code signal we can read here → classify({})
  // deterministically yields "fatal" (the safe stop default).
  const errorClass = classify({});
  const message =
    err instanceof Error
      ? `${entity}: ${err.message}`
      : `${entity}: ${String(err)}`;
  return { errorClass, message };
}

/**
 * Build a resolver: failed entity → its transitive dependents (entities that
 * must be skipped). Derived ONLY from the authoritative edge map produced by
 * plan.ts's dependencyEdges(); when absent, the resolver returns nothing so
 * NO item is mis-skipped (fail-safe).
 */
function buildDependentsResolver(
  edges?: ReadonlyMap<string, readonly string[]>,
): (entity: string) => string[] {
  if (edges === undefined) {
    return () => [];
  }
  // Invert deps → direct dependents.
  const directDependents = new Map<string, string[]>();
  for (const [entity, deps] of edges) {
    for (const dep of deps) {
      const list = directDependents.get(dep) ?? [];
      list.push(entity);
      directDependents.set(dep, list);
    }
  }
  return (entity: string): string[] => {
    // BFS the dependent closure (transitive).
    const out = new Set<string>();
    const queue = [...(directDependents.get(entity) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (out.has(next)) continue;
      out.add(next);
      for (const d of directDependents.get(next) ?? []) {
        if (!out.has(d)) queue.push(d);
      }
    }
    return [...out];
  };
}
