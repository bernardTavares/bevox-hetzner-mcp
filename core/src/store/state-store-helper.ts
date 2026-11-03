/**
 * core/src/store/state-store-helper.ts
 *
 * Shared helper for observed-store.ts and working-store.ts.
 * Both stores expose an identical API over different tables
 * (`observed_state` and `working_state`). This module factors
 * the SQL into a single place, parameterised by table name.
 *
 * SECURITY NOTE: `tableName` is a controlled internal constant — it is
 * never derived from user input.  We construct the SQL string once at
 * `makeStateStore` call time (module initialisation) rather than on every
 * query, so the concatenation is visually auditable and poses no injection
 * risk.  All data values (scope, entity, state JSON) go through
 * parameterised $N placeholders; no value is ever interpolated.
 *
 * Entity key convention
 * ---------------------
 * Each entity occupies exactly one row, keyed by `(scope, entity)` where
 *   entity = `${kind}:${escapedNaturalId}`
 *
 * The `kind:` prefix is NEVER escaped so that `rowsToState` can route by
 * `startsWith("kind:")`.  Component values in the natural-id portion are
 * escaped via `escapePart` to prevent distinct entities from colliding to
 * the same key (e.g. a DNS name containing `:` must not alias another record).
 *
 * kind → natural-id components (each escaped):
 *   servers   → "server:{name}"
 *   networks  → "network:{name}"
 *   volumes   → "volume:{name}"
 *   services  → "service:{name}"
 *   dns       → "dns:{zone}:{name}:{type}"   (stable natural key; all three parts escaped)
 *   backups   → "backup:{target}"
 */

import pg from "pg";
import { StateSchema } from "../domain/entities.js";
import type { State, Server, Network, Volume, Service, DnsRecord, BackupPolicy } from "../domain/entities.js";

// ---------------------------------------------------------------------------
// Entity key builders
// ---------------------------------------------------------------------------

/**
 * Escape a single component value so that `:` inside a value cannot alias
 * the `:` separator between components.
 *
 * Encoding: `\` → `\\`, `:` → `\:`
 * Decoding is not needed — keys are opaque identifiers used only for
 * equality/prefix matching; the actual entity data comes from the JSON column.
 */
export function escapePart(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Build the entity key for a given kind and its natural-id components.
 *
 * The `kind:` prefix is intentionally NOT escaped so that `rowsToState` can
 * route by `startsWith("kind:")`.  Every component value IS escaped so that
 * two distinct entities always produce two distinct keys (collision-free).
 */
export function entityKey(kind: string, ...parts: string[]): string {
  return `${kind}:` + parts.map(escapePart).join(":");
}

/** Expand a State into an array of (entityKey, jsonValue) pairs. */
function stateToRows(state: State): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [];

  for (const server of state.servers) {
    rows.push([entityKey("server", server.name), server]);
  }
  for (const network of state.networks) {
    rows.push([entityKey("network", network.name), network]);
  }
  for (const volume of state.volumes) {
    rows.push([entityKey("volume", volume.name), volume]);
  }
  for (const service of state.services) {
    rows.push([entityKey("service", service.name), service]);
  }
  for (const dns of state.dns) {
    rows.push([entityKey("dns", dns.zone, dns.name, dns.type), dns]);
  }
  for (const backup of state.backups) {
    rows.push([entityKey("backup", backup.target), backup]);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Row → entity reconstruction
// ---------------------------------------------------------------------------

interface StateRow {
  entity: string;
  state: unknown;
}

/** Re-group flat entity rows back into a State object. */
function rowsToState(rows: StateRow[]): State {
  const servers: Server[] = [];
  const networks: Network[] = [];
  const volumes: Volume[] = [];
  const services: Service[] = [];
  const dns: DnsRecord[] = [];
  const backups: BackupPolicy[] = [];

  for (const row of rows) {
    const key = row.entity;
    if (key.startsWith("server:")) {
      servers.push(row.state as Server);
    } else if (key.startsWith("network:")) {
      networks.push(row.state as Network);
    } else if (key.startsWith("volume:")) {
      volumes.push(row.state as Volume);
    } else if (key.startsWith("service:")) {
      services.push(row.state as Service);
    } else if (key.startsWith("dns:")) {
      dns.push(row.state as DnsRecord);
    } else if (key.startsWith("backup:")) {
      backups.push(row.state as BackupPolicy);
    }
    // Unknown entity kinds are silently ignored to be forward-compatible.
  }

  return { servers, networks, volumes, services, dns, backups };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface StateStore {
  /**
   * Replace the full state for `scope` atomically (DELETE stale + upsert current).
   *
   * NOT safe for concurrent calls on the same scope: the DELETE-then-upsert
   * sequence runs in READ COMMITTED and can tear if two callers race on the
   * same scope.  The reconciler MUST wrap every putState call in the Task 1.7
   * per-scope advisory lock (advisory-lock.ts) before invoking this method.
   */
  putState(pool: pg.Pool, scope: string, state: State): Promise<void>;
  getState(pool: pg.Pool, scope: string): Promise<State>;
}

/**
 * Creates a StateStore bound to the given table.
 *
 * `tableName` MUST be a controlled internal constant ("observed_state" or
 * "working_state"). It is interpolated into the SQL string at factory call
 * time. Never pass user-supplied input here.
 */
export function makeStateStore(tableName: "observed_state" | "working_state"): StateStore {
  // Pre-build the SQL templates once.
  // $1 = scope, $2 = entity, $3 = state JSON
  const upsertSql = `
    INSERT INTO ${tableName} (scope, entity, state, updated_at)
    VALUES ($1, $2, $3::jsonb, now())
    ON CONFLICT (scope, entity)
    DO UPDATE SET state = EXCLUDED.state, updated_at = now()
  `;

  // Delete rows for this scope whose entity is NOT in the current set.
  // We pass the entity key array as a Postgres text[] via $2.
  const deleteStaleSql = `
    DELETE FROM ${tableName}
    WHERE scope = $1
      AND entity <> ALL($2::text[])
  `;

  const selectSql = `
    SELECT entity, state
    FROM ${tableName}
    WHERE scope = $1
    ORDER BY entity
  `;

  return {
    async putState(pool: pg.Pool, scope: string, state: State): Promise<void> {
      const rows = stateToRows(state);
      const entityKeys = rows.map(([k]) => k);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete rows for entities that are no longer in `state`.
        // When `state` is empty, entityKeys is [] and ALL entities for the
        // scope are removed — correct replace semantics.
        await client.query(deleteStaleSql, [scope, entityKeys]);

        // Upsert every entity in `state`.
        // Per-row upsert is atomic within this transaction; acceptable at
        // expected entity counts (tens per scope). If counts ever scale to
        // thousands, replace with a batch UNNEST upsert (future optimisation).
        for (const [entity, value] of rows) {
          await client.query(upsertSql, [
            scope,
            entity,
            JSON.stringify(value),
          ]);
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async getState(pool: pg.Pool, scope: string): Promise<State> {
      const result = await pool.query<StateRow>(selectSql, [scope]);
      const raw = rowsToState(result.rows);
      // Validate on read — strict parse throws ZodError if the DB holds
      // schema-incompatible rows (e.g. written by a future version with new
      // required fields).  In a rolling update this can brick getState for the
      // affected scope until the old process is replaced.  The reconciler's
      // Observe step MUST catch ZodError from getState distinctly and skip (not
      // crash) that scope's reconcile cycle.  Resilience strategy to be
      // formalised in a later task.
      return StateSchema.parse(raw);
    },
  };
}
