/**
 * core/src/store/state-events.ts
 *
 * Append-only ordered StateEvents store.
 *
 * Design principles (spec §5 — every StateEvent records the actor; trail is
 * append-only):
 *   - appendEvent is the ONLY write path; there is NO update or delete API.
 *   - actor, scope, and result are REQUIRED fields (precondition error if
 *     missing/empty).
 *   - Events are stored with a BIGSERIAL primary key (seq) that guarantees
 *     monotonically increasing insertion order; queryEvents defaults to
 *     seq DESC (newest-first) to match /api/events console screen semantics.
 *   - Every row is validated via StateEventSchema.parse on read.
 *   - Parametrized SQL throughout — no string interpolation of user data.
 *
 * Exported API (ONLY these two — no mutation):
 *   appendEvent(db, event)    → Promise<{ seq: number }>
 *   queryEvents(pool, filter?) → Promise<StateEvent[]>
 *
 * `appendEvent` accepts ANY pg queryable — a `pg.Pool` OR a `pg.PoolClient`
 * (transaction-scoped). This lets a caller enlist the append in the SAME
 * transaction as a guarded state change so the row and its audit event
 * commit-or-fail together (see Queryable below). Passing a Pool keeps the
 * historical pool-per-call behaviour unchanged for every existing caller.
 */

import type pg from "pg";
import { StateEventSchema, type StateEvent } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Queryable — the minimal surface appendEvent needs. Both pg.Pool and
// pg.PoolClient satisfy this (each exposes `query`), so a caller can pass a
// transaction client to enlist the append in an outer BEGIN/COMMIT without
// forking a parallel event writer.
// ---------------------------------------------------------------------------

export type Queryable = Pick<pg.Pool, "query">;

// ---------------------------------------------------------------------------
// Input type for appendEvent (StateEvent minus ts which defaults to now())
// ---------------------------------------------------------------------------

// NOTE — scope required/optional asymmetry: scope is REQUIRED on write (throws
// precondition if empty) but StateEventSchema.scope is `.optional()` (console-
// contract constraint: core-valid ⇒ console-valid).  Downstream readers of
// queryEvents MUST treat the returned `scope` field as possibly-undefined per
// the schema, even though every row persisted by this module carries it.

export interface AppendEventInput {
  /** Agent id / "system". Required — throws precondition if empty. */
  actor: string;
  /** Capability scope of the acting agent. Required — throws precondition if empty. */
  scope: string;
  /** Operation: "create" | "update" | "delete" | "drift" | "noop" etc. */
  op: string;
  /** Resource name / identifier, e.g. "server:app-1". */
  entity: string;
  /** Outcome: "ok" | "error" | "skipped" etc. Required — throws precondition if empty. */
  result: string;
  /** ISO timestamp; defaults to now() on the Postgres side when omitted. */
  ts?: string;
  /** State snapshot before the operation (null for creates). */
  before?: unknown;
  /** State snapshot after the operation (null for deletes). */
  after?: unknown;
}

// ---------------------------------------------------------------------------
// Filter type for queryEvents
// ---------------------------------------------------------------------------

export interface QueryEventsFilter {
  /** Exact-match filter on actor column. */
  actor?: string;
  /** Exact-match filter on entity column. */
  entity?: string;
  /** Exact-match filter on result column. */
  result?: string;
  /** Maximum number of rows to return. Defaults to 200 (audit trail can grow unbounded). */
  limit?: number;
  /**
   * Sort order by seq. Defaults to "desc" (newest-first) — matches the
   * /api/events console screen semantics. Pass "asc" for chronological order.
   */
  order?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Row type returned by Postgres for state_events
// ---------------------------------------------------------------------------

interface StateEventRow {
  seq: string; // BIGSERIAL comes back as string in node-postgres
  ts: Date;
  actor: string;
  scope: string;
  op: string;
  entity: string;
  before: unknown;
  after: unknown;
  result: string;
}

// ---------------------------------------------------------------------------
// appendEvent
// ---------------------------------------------------------------------------

/**
 * Append a new StateEvent to the append-only log.
 *
 * Requires:
 *   - event.actor  — non-empty, non-whitespace; throws ReconcileError("precondition")
 *   - event.scope  — non-empty, non-whitespace; throws ReconcileError("precondition")
 *   - event.result — non-empty, non-whitespace; throws ReconcileError("precondition")
 *
 * ts defaults to now() on the Postgres side when not provided.
 * Returns the assigned monotonic sequence number.
 *
 * `db` is any pg Queryable: a `pg.Pool` (historical behaviour — pool picks a
 * connection per call) OR a transaction-scoped `pg.PoolClient` (the INSERT is
 * then part of that client's open transaction and commits/rolls back with it).
 */
export async function appendEvent(
  db: Queryable,
  event: AppendEventInput
): Promise<{ seq: number }> {
  // --- precondition guards ---
  if (!event.actor || event.actor.trim() === "") {
    throw new ReconcileError(
      "precondition",
      "appendEvent: actor is required and must not be empty",
      { entity: event.entity ?? "" }
    );
  }
  if (!event.scope || event.scope.trim() === "") {
    throw new ReconcileError(
      "precondition",
      "appendEvent: scope is required and must not be empty",
      { entity: event.entity ?? "" }
    );
  }
  if (!event.result || event.result.trim() === "") {
    throw new ReconcileError(
      "precondition",
      "appendEvent: result is required and must not be empty",
      { entity: event.entity ?? "" }
    );
  }

  // --- parametrized insert ---
  // When ts is provided we cast it explicitly to TIMESTAMPTZ; otherwise we let
  // the column default (now()) handle it by using a CASE expression.
  const sql = `
    INSERT INTO state_events (ts, actor, scope, op, entity, before, after, result)
    VALUES (
      COALESCE($1::timestamptz, now()),
      $2, $3, $4, $5,
      $6::jsonb, $7::jsonb,
      $8
    )
    RETURNING seq
  `;

  const values = [
    event.ts ?? null,
    event.actor,
    event.scope,
    event.op,
    event.entity,
    event.before !== undefined ? JSON.stringify(event.before) : null,
    event.after !== undefined ? JSON.stringify(event.after) : null,
    event.result,
  ];

  const res = await db.query<{ seq: string }>(sql, values);
  const row = res.rows[0];
  if (!row) {
    throw new ReconcileError("fatal", "appendEvent: INSERT returned no row", {
      entity: event.entity,
    });
  }

  return { seq: Number(row.seq) };
}

// ---------------------------------------------------------------------------
// queryEvents
// ---------------------------------------------------------------------------

/**
 * Query StateEvents ordered by seq (default: DESC — newest-first, matching
 * the /api/events console screen semantics). Pass order:"asc" for
 * chronological insertion order.
 *
 * Each filter field (actor, entity, result) is an exact-match predicate;
 * multiple filters are AND-ed together. Mirrors the console events tool /
 * /api/events?actor=&entity=&result= query semantics.
 *
 * Default limit is 200: the audit trail can grow unbounded; /api/events wants
 * recent + bounded results without the caller needing to specify a limit.
 *
 * Every returned row is validated via StateEventSchema.parse on read.
 */
export async function queryEvents(
  pool: pg.Pool,
  filter?: QueryEventsFilter
): Promise<StateEvent[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.actor !== undefined) {
    values.push(filter.actor);
    conditions.push(`actor = $${values.length}`);
  }
  if (filter?.entity !== undefined) {
    values.push(filter.entity);
    conditions.push(`entity = $${values.length}`);
  }
  if (filter?.result !== undefined) {
    values.push(filter.result);
    conditions.push(`result = $${values.length}`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // order is a controlled union literal ("asc" | "desc"), never user-supplied
  // free text — safe to interpolate as a direction keyword.
  const direction = filter?.order === "asc" ? "ASC" : "DESC";

  // Apply default limit of 200 when the caller omits it (audit trail can grow
  // unbounded; /api/events wants recent + bounded).
  const effectiveLimit =
    filter?.limit !== undefined && filter.limit > 0
      ? Math.floor(filter.limit)
      : 200;
  values.push(effectiveLimit);
  const limitParam = `$${values.length}`;

  const sql = `
    SELECT seq, ts, actor, scope, op, entity, before, after, result
    FROM state_events
    ${where}
    ORDER BY seq ${direction}
    LIMIT ${limitParam}
  `;

  const res = await pool.query<StateEventRow>(sql, values);

  return res.rows.map((row) => {
    // Build the raw object and validate via StateEventSchema.parse.
    // BRICK-RISK (mirrors Task 1.5 state-store-helper.ts): strict parse throws
    // ZodError if the audit table holds schema-incompatible rows (e.g. written
    // by a future version with new required fields).  In a rolling update this
    // can brick queryEvents for ALL callers (the trail is global, cross-scope)
    // until versions align.  The Fase 4 REST layer / reconciler MUST catch
    // ZodError from queryEvents distinctly.  Resilience strategy to be
    // formalised consistently with Task 1.5 in a later task.
    const raw = {
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
      actor: row.actor,
      scope: row.scope,
      op: row.op,
      entity: row.entity,
      result: row.result,
      // before/after are already parsed JSONB objects from node-postgres;
      // pass them through only when non-null
      ...(row.before !== null && row.before !== undefined
        ? { before: row.before }
        : {}),
      ...(row.after !== null && row.after !== undefined
        ? { after: row.after }
        : {}),
    };

    return StateEventSchema.parse(raw);
  });
}
