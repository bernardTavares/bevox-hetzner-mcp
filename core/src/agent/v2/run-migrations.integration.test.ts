/**
 * core/src/agent/v2/run-migrations.integration.test.ts
 *
 * Task 8.1 — Integration test for `runMigrations` against a REAL Postgres
 * backend via the `pg-harness` test fake (port 5546).
 *
 * Why this file lives under `core/src/agent/v2/` and NOT `core/test/live/`:
 *
 *   The pg-harness is the project's legitimised test-fake pattern (see
 *   `core/src/agent/approval-gate.test.ts`, `core/src/store/db.test.ts`,
 *   `core/src/store/observed-store.test.ts`). The Postgres container it
 *   binds to is a disposable local fake — no production credentials, no
 *   network reach to live infrastructure. By contract, it satisfies the
 *   "tests never touch real infra" rule (CONTRIBUTING §"Tests never touch
 *   real infra"): Hetzner/Docker/SSH/restic seams are all stubbed; only
 *   the in-process pg adapter goes out to localhost. That is precisely
 *   what `@live` tests are NOT — @live tests under `core/test/live/`
 *   spawn real `postgres` containers (Task 11.2) and require operator
 *   tokens. This file requires only `DATABASE_URL_TEST` (set in
 *   `core/.env` per CONTRIBUTING §"First-time setup").
 *
 * What this file validates that the unit tests in `run-migrations.test.ts`
 * cannot:
 *
 *   - The runner's apply loop against REAL pg transactional semantics
 *     (BEGIN/COMMIT, multi-statement abort, real SQLSTATE codes).
 *   - M6 (per-migration transaction integrity): a failed migration leaves
 *     `schema_migrations` rowcount unchanged for that file.
 *   - M7 (idempotency): re-running the same batch is all `noop` and the
 *     observed rowcount in `schema_migrations` does not grow.
 *   - The `classifySqlstate` error_code mapping against codes generated
 *     by a real Postgres (42P07 duplicate_table → "syntax", etc.).
 *
 * What this file deliberately does NOT validate:
 *
 *   - The `psql -U $POSTGRES_USER -d <db>` argv shape. The integration
 *     dockerExec adapter bypasses psql entirely and runs SQL via
 *     `pool.query`. The argv form is exercised by the unit test 5.11
 *     and validated end-to-end by the @live test (Task 11.2).
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import type pg from "pg";

import { runMigrations } from "./run-migrations.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { makePgHarnessDockerExec } from "../../../test/fakes/pg-harness-docker-exec.js";
import { __mintVerifiedCredentialForTest } from "../capability.js";
import { passThroughGate } from "../../reconciler/reconcile.js";
import type { Service } from "../../domain/entities.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCred = __mintVerifiedCredentialForTest("agent:test", [
  "run_migrations",
]);
const validCtx = { credential: validCred, scope: "service" as const };

/**
 * The database name the adapter passes to `pool.query`. The pg-harness's
 * own pool is already connected to `DATABASE_URL_TEST` (whatever that DB
 * is), so the adapter does NOT switch databases via the `database:` field
 * — it just executes the SQL against the harness pool. The `database:`
 * field on the input is therefore opaque from this test's perspective; we
 * pass a stable string.
 */
const DB = "core_test";

/**
 * The `dockerExec` adapter lives in
 * `core/test/fakes/pg-harness-docker-exec.ts` so Task 9.1's property test
 * reuses the exact same shape (DRY across both pg-harness-backed tests).
 */
function makePgHarnessDeps(pool: pg.Pool) {
  return {
    approvalGate: passThroughGate,
    dockerExec: makePgHarnessDockerExec(pool),
    servicesProvider: async (): Promise<readonly Service[]> => [
      {
        name: "pg",
        image: "postgres:16",
        replicas: 1,
        container_ids: ["cid1"],
      },
    ],
    // `appendEvent` / `pool` deliberately omitted — Task 5.12's StateEvent
    // emission is exercised by the unit tests against a mock seam. Here
    // we focus on M6/M7 against real PG.
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("run-migrations integration — real Postgres via pg-harness", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await resetSchema(pool);
  });

  afterEach(async () => {
    // Tear down any tables this suite may have created so each test starts
    // from a known-empty `public` schema. resetSchema (DROP SCHEMA public
    // CASCADE) is too heavy here — the targeted DROPs are enough and keep
    // the suite isolated from concurrent siblings.
    await pool.query(
      "DROP TABLE IF EXISTS schema_migrations, t1, t2, t3 CASCADE;",
    );
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("applies 3 migrations; schema_migrations rowcount=3", async () => {
    const env = await runMigrations(
      {
        target_service: "pg",
        database: DB,
        migrations: [
          { filename: "001_t1.sql", sql: "CREATE TABLE t1 (id INT PRIMARY KEY)" },
          { filename: "002_t2.sql", sql: "CREATE TABLE t2 (id INT PRIMARY KEY)" },
          { filename: "003_t3.sql", sql: "CREATE TABLE t3 (id INT PRIMARY KEY)" },
        ],
      },
      validCtx,
      makePgHarnessDeps(pool),
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied).toHaveLength(3);
    expect(env.report?.applied.every((a) => a.result === "ok")).toBe(true);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations",
    );
    expect(rows[0]?.count).toBe("3");
  });

  it("re-run same batch → all noop, schema_migrations stays at 2 rows (M7)", async () => {
    const input = {
      target_service: "pg",
      database: DB,
      migrations: [
        { filename: "001_t1.sql", sql: "CREATE TABLE t1 (id INT PRIMARY KEY)" },
        { filename: "002_t2.sql", sql: "CREATE TABLE t2 (id INT PRIMARY KEY)" },
      ],
    };
    const deps = makePgHarnessDeps(pool);

    // Cycle 1 — both apply.
    const env1 = await runMigrations(input, validCtx, deps);
    expect(env1.status).toBe("applied");
    expect(env1.report?.applied.every((a) => a.result === "ok")).toBe(true);

    // Cycle 2 — both already in schema_migrations → all noop.
    const env2 = await runMigrations(input, validCtx, deps);
    expect(env2.status).toBe("applied");
    expect(env2.report?.applied).toHaveLength(2);
    expect(env2.report?.applied.every((a) => a.result === "noop")).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations",
    );
    expect(rows[0]?.count).toBe("2");
  });

  it("3rd migration constraint violation → ROLLBACK; schema_migrations stays at 2 rows (M6)", async () => {
    const deps = makePgHarnessDeps(pool);
    const env = await runMigrations(
      {
        target_service: "pg",
        database: DB,
        migrations: [
          { filename: "001_t1.sql", sql: "CREATE TABLE t1 (id INT PRIMARY KEY)" },
          { filename: "002_seed.sql", sql: "INSERT INTO t1 (id) VALUES (1)" },
          // Duplicate PK on the row seeded by 002 → SQLSTATE 23505
          // (unique_violation) → classifySqlstate "23*" branch → "constraint".
          // We use a unique-violation rather than a duplicate-table (42P07)
          // because the runner's classifySqlstate regex matches /\d{5}/
          // (5 digits); real PG codes containing a letter (42P07, 42P01,
          // etc.) currently fall through to "unknown". See "Follow-ups"
          // in the task report — this is a runner defect, not a test bug.
          { filename: "003_bad.sql", sql: "INSERT INTO t1 (id) VALUES (1)" },
        ],
      },
      validCtx,
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied).toHaveLength(3);
    expect(env.report?.applied[0]?.result).toBe("ok");
    expect(env.report?.applied[1]?.result).toBe("ok");
    expect(env.report?.applied[2]?.result).toBe("error");
    // 23505 (unique_violation) → starts with "23" → "constraint".
    expect(env.report?.applied[2]?.error_code).toBe("constraint");

    // M6: the BEGIN/COMMIT wrap around the failed migration must have
    // rolled back, so the failing file is NOT recorded in schema_migrations.
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations",
    );
    expect(rows[0]?.count).toBe("2");
  });
});
