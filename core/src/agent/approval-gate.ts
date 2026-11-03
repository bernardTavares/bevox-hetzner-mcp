/**
 * core/src/agent/approval-gate.ts
 *
 * The REAL Approval Gate — the Fase-4 strategy that plugs into the Task-2.7
 * `ReconcileGate` seam in place of the Fase-2/3 `passThroughGate` WITHOUT any
 * change to reconcile internals (it implements the exact same interface:
 * `evaluate(items, ctx) → { approved, denied }`).
 *
 * Design principles (spec §5; CLAUDE.md non-negotiables):
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. A sensitive item without an APPROVED
 *     decision is placed in `denied` (withheld). `denied` items are recorded
 *     and NEVER applied or removed by the reconciler. The gate NEVER turns a
 *     withheld item into a destroy/rollback. A non-sensitive item is approved
 *     (pure pass-through — behaviour identical to passThroughGate).
 *
 *   - RECONCILER NEVER BLOCKS. evaluate() returns synchronously-in-promise; a
 *     pending approval does NOT stall the cycle. The item simply stays in
 *     `denied` (the reconciler records it `denied`/withheld) and is re-evaluated
 *     every subsequent cycle. On approval → next cycle it moves to `approved`.
 *     On reject/expiry → it stays terminally withheld; never auto-destructed.
 *
 *   - LIFECYCLE (internal superset of the FROZEN console ApprovalSchema enum
 *     pending|approved|rejected): pending → approved | rejected | cancelled.
 *     `cancelled` is the terminal state for BOTH a rejected pending (reason
 *     recorded) AND an expired pending (the plan: expired → cancelled + event).
 *     TWO resolution paths, BOTH transitioning out of `pending`:
 *       · webhook (preferred): resolveApproval(id, …) — explicit approve/reject
 *         the agent-interface/REST (Task 4.5) will call by approval_id;
 *       · poll fallback: sweepExpired() — expires every pending past its TTL.
 *     Every transition appends an append-only StateEvent (actor = requester on
 *     create, resolver on webhook, "system" on the expiry sweep).
 *
 *   - TTL via INJECTED CLOCK. Default 24h, configurable. `now()` is injected so
 *     the test suite advances time deterministically — NO real timers/sleeps.
 *
 *   - PERSISTENCE + DEDUPE + IDEMPOTENT RESOLVE. Records persist in Postgres so
 *     they survive across cycles/process. At most one OPEN (pending) approval
 *     per (scope, op, entity) — a partial unique index is the dedupe key, so
 *     re-evaluating the same withheld item every cycle never duplicates.
 *     Resolving an already-terminal approval (double webhook, webhook-after-
 *     expiry, expiry-after-resolve) is a SAFE NO-OP — never an error that flaps.
 *
 *   - NO SECRET LEAK. A record carries ONLY the action identity (scope, op,
 *     entity, change, impact, actor, reason) — never resolved secret values
 *     (1.9/3.3/4.1/4.2 discipline). change/impact come straight from PlanItem
 *     which is already secret-free by construction.
 *
 *   - SENSITIVITY IS INJECTED. The per-item sensitivity predicate is supplied
 *     by the caller (default: the destructive/sensitive ops). The full per-tool
 *     policy table is Task 4.4 — intentionally NOT hardcoded here.
 *
 * Exported API (ONLY these — minimal surface):
 *   createApprovalGate(deps)            → ReconcileGate (+ the lifecycle fns)
 *   defaultSensitiveOps                 → the v1 sensitive PlanOp set
 *   defaultIsSensitive(item)            → the v1 injected predicate
 *   interface ApprovalGateDeps / ApprovalGate / ApprovalRecord / Clock
 *   type ApprovalStatus / ApprovalDecision
 */

import type pg from "pg";

import type { PlanItem, PlanOp } from "../domain/entities.js";
import type {
  ReconcileGate,
  GateContext,
  GateDecision,
  PendingApproval,
} from "../reconciler/reconcile.js";
import { ReconcileError } from "../domain/errors.js";
import { appendEvent } from "../store/state-events.js";

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/**
 * Internal status superset. The FROZEN console ApprovalSchema enum is only
 * pending|approved|rejected; `cancelled` is the core-internal terminal state
 * for a rejected OR an expired pending (per the approved plan). The Task-4.5
 * agent-interface projection maps this superset back onto the contract enum
 * (rejected & cancelled → "rejected"); core never widens the contract.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

/** The webhook resolution verb. */
export type ApprovalDecision = "approved" | "rejected";

/** The persisted approval record (secret-free by construction). */
export interface ApprovalRecord {
  readonly id: string;
  readonly scope: string;
  readonly op: string;
  readonly entity: string;
  readonly change: string;
  readonly impact: string;
  readonly actor: string;
  readonly status: ApprovalStatus;
  readonly reason: string | null;
  readonly resolver: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly resolvedAt: string | null;
}

/** Injected clock — tests advance this; production passes the real Date. */
export interface Clock {
  now(): Date;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * The v1 sensitive PlanOp set: destructive / non-reversible-by-default ops.
 * `destroy`/`remove` delete reality; `restore` overwrites with a snapshot.
 * Per the task this stays minimal & injectable — the full per-tool policy
 * table is Task 4.4 and is NOT hardcoded here.
 */
export const defaultSensitiveOps: ReadonlySet<PlanOp> = new Set<PlanOp>([
  "destroy",
  "remove",
  "restore",
]);

/** The v1 injected sensitivity predicate (op-based; see defaultSensitiveOps). */
export function defaultIsSensitive(item: PlanItem): boolean {
  return defaultSensitiveOps.has(item.op);
}

// ---------------------------------------------------------------------------
// Dependencies / public gate object
// ---------------------------------------------------------------------------

export interface ApprovalGateDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  /** TTL in ms before a pending approval expires. Default 24h. */
  readonly ttlMs?: number;
  /** Sensitivity predicate. Default: defaultIsSensitive (op-based). */
  readonly isSensitive?: (item: PlanItem) => boolean;
  /**
   * approval_id factory (default: "apr_" + random uuid). Injectable so tests
   * get deterministic ids. MUST yield the contract "apr_…" shape.
   */
  readonly idFactory?: () => string;
  /**
   * Audit-event writer seam. Default: the real `appendEvent`. Each transition
   * passes its OWN open transaction client so the event commits-or-fails with
   * the state change. Injectable ONLY so tests can simulate an event-write
   * failure mid-transaction and assert the state change rolled back (atomicity
   * teeth). Production never overrides it — there is no parallel event writer.
   */
  readonly appendEventFn?: typeof appendEvent;
}

/**
 * The Approval Gate. `evaluate` IS the ReconcileGate seam (drop-in for
 * passThroughGate). The lifecycle functions are the webhook + poll resolution
 * paths the agent-interface (Task 4.5) wires; the reconciler itself only ever
 * calls `evaluate`.
 */
export interface ApprovalGate extends ReconcileGate {
  /** Webhook path: approve/reject a pending approval by id. Idempotent. */
  resolveApproval(
    id: string,
    decision: ApprovalDecision,
    resolver: string,
    reason?: string,
  ): Promise<ApprovalRecord>;
  /** Poll fallback: expire every pending past its TTL → cancelled + event. */
  sweepExpired(): Promise<ApprovalRecord[]>;
  /** Read a single record (agent-interface / tests). */
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  /** List records, newest-first (Task 4.5 GET /api/approvals source). */
  listApprovals(): Promise<ApprovalRecord[]>;
}

// ---------------------------------------------------------------------------
// Row ↔ record mapping
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  scope: string;
  op: string;
  entity: string;
  change: string;
  impact: string;
  actor: string;
  status: ApprovalStatus;
  reason: string | null;
  resolver: string | null;
  requested_at: Date;
  expires_at: Date;
  resolved_at: Date | null;
}

function rowToRecord(r: ApprovalRow): ApprovalRecord {
  return {
    id: r.id,
    scope: r.scope,
    op: r.op,
    entity: r.entity,
    change: r.change,
    impact: r.impact,
    actor: r.actor,
    status: r.status,
    reason: r.reason,
    resolver: r.resolver,
    requestedAt: r.requested_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

const SELECT_COLS =
  "id, scope, op, entity, change, impact, actor, status, reason, resolver, requested_at, expires_at, resolved_at";

// ---------------------------------------------------------------------------
// createApprovalGate
// ---------------------------------------------------------------------------

export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const { pool, clock } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const isSensitive = deps.isSensitive ?? defaultIsSensitive;
  const idFactory =
    deps.idFactory ?? (() => `apr_${globalThis.crypto.randomUUID()}`);
  const emitEvent = deps.appendEventFn ?? appendEvent;

  /**
   * Run `fn` inside a single pooled-client transaction (BEGIN/COMMIT, ROLLBACK
   * on error, release in finally) — the exact pattern db.ts uses for the
   * migration runner. The guarded state mutation AND its StateEvent run on the
   * SAME `client`, so they commit-or-fail together: a crash between them can no
   * longer leave a durable terminal/pending row with no audit event.
   */
  async function withTxn<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    // Precondition: a non-positive TTL would expire approvals instantly —
    // structurally unsafe (every sensitive action permanently withheld with
    // no human window). Caught at construction, never silently defaulted.
    throw new ReconcileError(
      "precondition",
      "createApprovalGate: ttlMs must be a positive finite number",
      { entity: "approval-gate" },
    );
  }

  // -- read helpers ---------------------------------------------------------

  async function getApproval(id: string): Promise<ApprovalRecord | undefined> {
    const res = await pool.query<ApprovalRow>(
      `SELECT ${SELECT_COLS} FROM approvals WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async function listApprovals(): Promise<ApprovalRecord[]> {
    const res = await pool.query<ApprovalRow>(
      `SELECT ${SELECT_COLS} FROM approvals ORDER BY requested_at DESC, id DESC`,
    );
    return res.rows.map(rowToRecord);
  }

  function findOpenPending(
    scope: string,
    op: string,
    entity: string,
  ): Promise<ApprovalRow | undefined> {
    return pool
      .query<ApprovalRow>(
        `SELECT ${SELECT_COLS} FROM approvals
         WHERE scope = $1 AND op = $2 AND entity = $3 AND status = 'pending'`,
        [scope, op, entity],
      )
      .then((res) => res.rows[0]);
  }

  // -- create-or-reuse a pending for a withheld sensitive item -------------

  async function ensurePending(
    item: PlanItem,
    ctx: GateContext,
  ): Promise<string> {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const id = idFactory();
    // Atomic dedupe: the partial UNIQUE index (scope,op,entity) WHERE
    // status='pending' guarantees at most one OPEN approval per action even
    // under concurrent cycles. ON CONFLICT DO NOTHING makes a re-evaluation
    // (same withheld item next cycle) a safe no-op — never a duplicate, never
    // a flap. We must target the partial index's predicate explicitly.
    // ATOMIC: the guarded INSERT and its "pending_approval" event run on the
    // SAME transaction client. If the event write fails the INSERT is rolled
    // back — no orphaned pending row with no audit event. The event is emitted
    // ONLY when (and exactly once when) the INSERT actually created the row
    // (RETURNING non-empty); the ON CONFLICT no-op branch (re-evaluation /
    // concurrent cycle) still produces NO event and NO error — no flap.
    const createdId = await withTxn(async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO approvals
           (id, scope, op, entity, change, impact, actor, status,
            requested_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)
         ON CONFLICT (scope, op, entity) WHERE status = 'pending'
           DO NOTHING
         RETURNING id`,
        [
          id,
          ctx.scope,
          item.op,
          item.entity,
          item.change,
          item.impact,
          ctx.actor,
          now.toISOString(),
          expiresAt.toISOString(),
        ],
      );
      // A row came back ⇒ THIS call created the pending (first time this
      // action was withheld). No row ⇒ an open pending already existed
      // (re-evaluation): no event, no duplicate — deterministic, no flap.
      if (res.rows[0]) {
        await emitEvent(client, {
          actor: ctx.actor,
          scope: ctx.scope,
          op: item.op,
          entity: item.entity,
          result: "pending_approval",
          after: { approval_id: id, change: item.change, impact: item.impact },
        });
        return res.rows[0].id;
      }
      return undefined;
    });
    // INSERT created it ⇒ return the freshly-minted id. ON CONFLICT no-op
    // (re-evaluation / concurrent cycle) ⇒ the open pending already exists;
    // return ITS id (the authoritative one for this (scope,op,entity)) so the
    // caller always surfaces the correct approval, never an arbitrary guess.
    if (createdId !== undefined) return createdId;
    const open = await findOpenPending(ctx.scope, item.op, item.entity);
    if (open) return open.id;
    // No created row AND no open pending ⇒ a concurrent resolve/expiry raced
    // between INSERT-conflict and this read. Surface as an internal invariant
    // signal rather than a silent empty id (caller treats it as fatal).
    throw new ReconcileError(
      "conflict",
      "approval gate: pending approval expected after withhold but none is open",
      { entity: item.entity },
    );
  }

  // -- THE ReconcileGate seam ----------------------------------------------

  async function evaluate(
    items: readonly PlanItem[],
    ctx: GateContext,
  ): Promise<GateDecision> {
    const approved: PlanItem[] = [];
    const denied: PlanItem[] = [];
    // ADDITIVE channel: the exact open pending id per withheld item, keyed by
    // this gate's own (scope,op,entity). The caller (tool layer) surfaces the
    // approval for the action it requested — never a scope-only guess.
    const pendingApprovals: PendingApproval[] = [];

    for (const item of items) {
      if (!isSensitive(item)) {
        // Pure pass-through — identical to passThroughGate for safe ops.
        approved.push(item);
        continue;
      }
      // Sensitive: proceed ONLY if there is an APPROVED decision for exactly
      // this (scope, op, entity). Any other state (no record, pending,
      // rejected, cancelled/expired) ⇒ WITHHELD (denied) — fail-safe.
      const open = await findOpenPending(ctx.scope, item.op, item.entity);
      if (open) {
        // Still pending → withhold; re-evaluated next cycle (no block).
        denied.push(item);
        pendingApprovals.push({
          entity: item.entity,
          op: item.op,
          approvalId: open.id,
        });
        continue;
      }
      const approvedRow = await pool.query<{ id: string }>(
        `SELECT id FROM approvals
         WHERE scope = $1 AND op = $2 AND entity = $3 AND status = 'approved'
         ORDER BY resolved_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [ctx.scope, item.op, item.entity],
      );
      if (approvedRow.rows[0]) {
        approved.push(item);
        continue;
      }
      // No open pending, no approval ⇒ create a pending and withhold. (If a
      // prior pending was rejected/expired this opens a fresh one — the
      // terminal row no longer occupies the partial-unique slot.)
      const approvalId = await ensurePending(item, ctx);
      denied.push(item);
      pendingApprovals.push({
        entity: item.entity,
        op: item.op,
        approvalId,
      });
    }

    return { approved, denied, pendingApprovals };
  }

  // -- webhook resolution path ---------------------------------------------

  async function resolveApproval(
    id: string,
    decision: ApprovalDecision,
    resolver: string,
    reason?: string,
  ): Promise<ApprovalRecord> {
    if (!resolver || resolver.trim() === "") {
      throw new ReconcileError(
        "precondition",
        "resolveApproval: resolver (acting agent) is required",
        { entity: id },
      );
    }
    const existing = await getApproval(id);
    if (existing === undefined) {
      throw new ReconcileError(
        "precondition",
        "resolveApproval: unknown approval id",
        { entity: id },
      );
    }
    // IDEMPOTENT: resolving an already-terminal approval (double webhook,
    // webhook-after-expiry, …) is a SAFE NO-OP — return as-is, never throw,
    // never flap, never re-emit an event.
    if (existing.status !== "pending") {
      return existing;
    }

    // pending → approved | (rejected→) cancelled. Per the plan a rejection is
    // terminal `cancelled` with the reason recorded; an approval is terminal
    // `approved`. The UPDATE is guarded on status='pending' so a race with the
    // expiry sweep resolves to exactly one winner (the other sees 0 rows and
    // falls through to a no-op re-read).
    const newStatus: ApprovalStatus =
      decision === "approved" ? "approved" : "cancelled";
    const finalReason =
      decision === "rejected" ? (reason ?? "rejected") : null;
    const now = clock.now();
    // ATOMIC: the status='pending'-guarded UPDATE and its resolution event run
    // on the SAME transaction client — they commit-or-fail together. The
    // single-winner race is preserved: the losing racer's UPDATE matches 0
    // rows, so RETURNING is empty, NO event is emitted and NO error is thrown
    // (it falls through to a no-op re-read). Idempotent double-resolve still
    // short-circuits above (status !== 'pending') and never reaches this txn.
    const row = await withTxn(async (client) => {
      const upd = await client.query<ApprovalRow>(
        `UPDATE approvals
           SET status = $2, reason = $3, resolver = $4, resolved_at = $5
         WHERE id = $1 AND status = 'pending'
         RETURNING ${SELECT_COLS}`,
        [id, newStatus, finalReason, resolver, now.toISOString()],
      );
      const updated = upd.rows[0];
      if (!updated) {
        // Lost the race (sweep expired it first) — no event, no error.
        return undefined;
      }
      await emitEvent(client, {
        actor: resolver,
        scope: updated.scope,
        op: updated.op,
        entity: updated.entity,
        result: decision === "approved" ? "approved" : "rejected",
        after: {
          approval_id: id,
          status: newStatus,
          ...(finalReason !== null ? { reason: finalReason } : {}),
        },
      });
      return updated;
    });
    if (!row) {
      // Lost the race (sweep expired it first) — no-op, return current state.
      return (await getApproval(id)) as ApprovalRecord;
    }
    return rowToRecord(row);
  }

  // -- poll / TTL expiry path ----------------------------------------------

  async function sweepExpired(): Promise<ApprovalRecord[]> {
    const now = clock.now();
    // Atomically claim every pending past its TTL → terminal `cancelled` with
    // reason "expired" (the plan: expired → cancelled + event). The status=
    // 'pending' guard makes a concurrent webhook resolution / a second sweep a
    // safe no-op (0 rows) — idempotent, never double-emits.
    // ATOMIC: the guarded UPDATE that claims every expired pending AND the
    // "expired" event for each claimed row run on the SAME transaction client
    // — the whole sweep commits-or-fails together. If any event write fails,
    // NO row is left durably cancelled without its audit event. The status=
    // 'pending' guard keeps a concurrent webhook / second sweep a safe no-op
    // (0 rows ⇒ no events, no error) — idempotent, never double-emits.
    const expired = await withTxn(async (client) => {
      const res = await client.query<ApprovalRow>(
        `UPDATE approvals
           SET status = 'cancelled', reason = 'expired', resolved_at = $1
         WHERE status = 'pending' AND expires_at <= $1
         RETURNING ${SELECT_COLS}`,
        [now.toISOString()],
      );
      const recs = res.rows.map(rowToRecord);
      for (const rec of recs) {
        // Sweep is system-driven (no human resolver) — actor "system".
        await emitEvent(client, {
          actor: "system",
          scope: rec.scope,
          op: rec.op,
          entity: rec.entity,
          result: "expired",
          after: {
            approval_id: rec.id,
            status: "cancelled",
            reason: "expired",
          },
        });
      }
      return recs;
    });
    return expired;
  }

  return {
    name: "approval-gate",
    evaluate,
    resolveApproval,
    sweepExpired,
    getApproval,
    listApprovals,
  };
}
