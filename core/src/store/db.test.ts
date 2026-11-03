/**
 * core/src/store/db.test.ts
 *
 * TDD tests for db.ts — pg pool creation and idempotent migration runner.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { createPool, runMigrations, MIGRATION_LOCK_KEY } from "./db.js";
import type pg from "pg";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
  await resetSchema(pool);
});

afterAll(async () => {
  await closeTestPool();
});

describe("createPool", () => {
  it("creates a pool that can execute a simple query", async () => {
    const url = process.env["DATABASE_URL_TEST"];
    if (!url) throw new Error("DATABASE_URL_TEST not set");

    const p = createPool(url);
    try {
      // pg returns integer literals as JS numbers; cast to text for a stable string comparison.
      const result = await p.query<{ one: string }>("SELECT 1::text AS one");
      expect(result.rows[0]?.one).toBe("1");
    } finally {
      await p.end();
    }
  });
});

describe("MIGRATION_LOCK_KEY", () => {
  it("is exported and falls in the migration lock partition [9_000_000_000, 9_999_999_999]", () => {
    expect(typeof MIGRATION_LOCK_KEY).toBe("bigint");
    expect(MIGRATION_LOCK_KEY).toBeGreaterThanOrEqual(9_000_000_000n);
    expect(MIGRATION_LOCK_KEY).toBeLessThanOrEqual(9_999_999_999n);
  });
});

describe("runMigrations", () => {
  it("runs migrations and creates expected tables", async () => {
    await runMigrations(pool);

    const result = await pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const tables = result.rows.map((r) => r.tablename);
    expect(tables).toContain("schema_migrations");
    expect(tables).toContain("observed_state");
    expect(tables).toContain("working_state");
    expect(tables).toContain("state_events");
  });

  it("creates the idx_state_events_filter index (002 migration)", async () => {
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'state_events'
        AND indexname = 'idx_state_events_filter'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it("is idempotent — running twice does not throw and does not duplicate ledger entries", async () => {
    // Run a second time on the already-migrated schema
    await expect(runMigrations(pool)).resolves.toBeUndefined();

    const result = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM schema_migrations
    `);

    // Exactly 4 rows: 001_init.sql + 002_state_events_index.sql +
    // 003_approvals.sql + 004_v2_bloco_a.sql (Task 0.2 added the v2 Bloco A
    // additive migration: 5 new observed-state tables + 2 StateEvent columns).
    expect(Number(result.rows[0]?.count)).toBe(4);
  });

  it("records applied filenames in schema_migrations ledger", async () => {
    const result = await pool.query<{ filename: string; applied_at: Date }>(`
      SELECT filename, applied_at FROM schema_migrations ORDER BY filename
    `);

    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]?.filename).toBe("001_init.sql");
    expect(result.rows[1]?.filename).toBe("002_state_events_index.sql");
    expect(result.rows[2]?.filename).toBe("003_approvals.sql");
    expect(result.rows[3]?.filename).toBe("004_v2_bloco_a.sql");
    expect(result.rows[0]?.applied_at).toBeInstanceOf(Date);
    expect(result.rows[1]?.applied_at).toBeInstanceOf(Date);
    expect(result.rows[2]?.applied_at).toBeInstanceOf(Date);
    expect(result.rows[3]?.applied_at).toBeInstanceOf(Date);
  });
});
