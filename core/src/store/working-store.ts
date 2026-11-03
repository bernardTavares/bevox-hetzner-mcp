/**
 * core/src/store/working-store.ts
 *
 * Typed CRUD over the `working_state` table.
 *
 * `working_state` holds the desired state as last applied by the reconciler —
 * i.e. the YAML manifest snapshot at each reconcile cycle. One row per entity,
 * keyed by (scope, entity). See state-store-helper.ts for the entity key
 * convention and shared SQL logic.
 *
 * The API is identical to observed-store.ts; the only difference is the
 * underlying table. This separation makes the two stores independently
 * queryable and prevents any accidental cross-table writes.
 *
 * API:
 *   putState(pool, scope, state) — full replace: upsert all entities in
 *     `state` and delete rows for entities no longer present.
 *   getState(pool, scope)       — read + regroup + StateSchema.parse.
 */

import type pg from "pg";
import type { State } from "../domain/entities.js";
import { makeStateStore } from "./state-store-helper.js";

const store = makeStateStore("working_state");

/**
 * Replace the desired-state snapshot for `scope` with `state`.
 *
 * Within a single transaction:
 * 1. Deletes rows for entities in `scope` that are absent from `state`.
 * 2. Upserts a row for every entity present in `state`.
 *
 * Calling this with the same `state` twice is idempotent: row count is stable
 * and updated_at is refreshed but no new rows are created.
 */
export function putState(
  pool: pg.Pool,
  scope: string,
  state: State
): Promise<void> {
  return store.putState(pool, scope, state);
}

/**
 * Read all entity rows for `scope`, regroup into the six State collections,
 * and validate with StateSchema.parse before returning.
 *
 * An unknown scope (no rows) returns a valid empty State.
 */
export function getState(pool: pg.Pool, scope: string): Promise<State> {
  return store.getState(pool, scope);
}
