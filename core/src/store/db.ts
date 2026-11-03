/**
 * core/src/store/db.ts
 *
 * pg connection pool factory and forward-only, idempotent migration runner.
 *
 * Design decisions:
 * - `createPool` is a thin factory — callers own the pool lifecycle.
 * - `runMigrations` is idempotent: files already recorded in `schema_migrations`
 *   are skipped; running it N times is identical to running it once.
 * - The entire migration run is wrapped in a single transaction so a partial
 *   failure leaves the schema untouched.
 * - A PostgreSQL transaction-scoped blocking advisory lock (key 9_876_543_210)
 *   ensures that two concurrent callers (e.g. two server processes starting
 *   simultaneously) do not interleave migration SQL. The lock is released
 *   automatically when the transaction ends.
 * - SQL files are read at runtime from the `migrations/` directory sibling to
 *   this file, in strict lexical order.
 */

import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Advisory lock key namespace — single-arg pg_advisory_xact_lock(int8).
//
// Partition contract (must not overlap):
//   [0, 8_999_999_999]       — per-scope reconcile locks (Task 1.7).
//                              Task 1.7 MUST map hashed scope into this range
//                              to guarantee non-collision with migration locks.
//   [9_000_000_000, 9_999_999_999] — migration locks (this file).
//
// MIGRATION_LOCK_KEY is exported so Task 1.7 can assert non-overlap in tests.
// ---------------------------------------------------------------------------
export const MIGRATION_LOCK_KEY = 9_876_543_210n; // BigInt fits pg int8

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new pg.Pool for the given connection string.
 * The caller is responsible for calling `pool.end()` when done.
 */
export function createPool(connectionString: string): pg.Pool {
  return new Pool({ connectionString });
}

/**
 * Runs all pending SQL migration files in `migrations/` in lexical order.
 *
 * Guarantees:
 * - Files already recorded in `schema_migrations` are skipped (idempotent).
 * - The entire batch is wrapped in a single transaction.
 * - A pg advisory lock prevents concurrent migration runs.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations"
  );

  // Collect .sql files in lexical order
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Acquire a transaction-scoped blocking advisory lock via pg_advisory_xact_lock.
    // The lock is held for the duration of the transaction and released on COMMIT
    // or ROLLBACK. Concurrent callers block here until the lock is available.
    // Explicit ::bigint cast avoids unknown→int4 overflow for large int8 keys.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      String(MIGRATION_LOCK_KEY),
    ]);

    // Ensure the ledger table exists (bootstraps the very first run).
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Fetch already-applied filenames.
    const applied = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    for (const file of files) {
      if (appliedSet.has(file)) continue; // idempotent skip

      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
