/**
 * core/test/fakes/pg-harness.ts
 *
 * Test harness for integration tests that require a real Postgres database.
 *
 * Connects to the disposable DATABASE_URL_TEST Postgres (Docker container
 * bevox-core-test-pg). NEVER point this at production.
 * Each test file resets the schema via `resetSchema(pool)` to start clean.
 *
 * NOTE: testcontainers is NOT used. The chosen approach is a pre-started
 * local/disposable Docker container documented in the project README and
 * wired via core/.env (gitignored). This keeps test startup fast and avoids
 * Docker-in-Docker complexity.
 *
 * Usage:
 *   import { getTestPool, resetSchema, closeTestPool } from "../fakes/pg-harness.js";
 *
 *   beforeAll(async () => { await resetSchema(getTestPool()); });
 *   afterAll(async () => { await closeTestPool(); });
 */

import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * Returns a shared pg.Pool connected to DATABASE_URL_TEST.
 * Throws a clear error if the env var is unset (telling the dev to set it /
 * start the container).
 */
export function getTestPool(): pg.Pool {
  if (!process.env["DATABASE_URL_TEST"]) {
    throw new Error(
      "DATABASE_URL_TEST is not set.\n" +
        "Start the disposable test container and ensure core/.env contains:\n" +
        "  DATABASE_URL_TEST=postgresql://<user>:<pass>@localhost:<port>/<db>\n" +
        "See project README § 'Running integration tests' for instructions."
    );
  }

  if (!_pool) {
    _pool = new Pool({ connectionString: process.env["DATABASE_URL_TEST"] });
  }

  return _pool;
}

/**
 * Drops and recreates the `public` schema so the next test file starts clean.
 * WARNING: destroys all data in the public schema of DATABASE_URL_TEST.
 */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/**
 * Closes the shared test pool. Call in `afterAll` of the last/only test file
 * that uses the harness, or in a global teardown.
 */
export async function closeTestPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
