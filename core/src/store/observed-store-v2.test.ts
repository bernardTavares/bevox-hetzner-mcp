/**
 * core/src/store/observed-store-v2.test.ts
 *
 * Integration test for the v2 Bloco A additive migration (004_v2_bloco_a.sql).
 *
 * Verifies that after running all migrations:
 *   - The 5 new v2 observed-state tables exist (firewalls, load_balancers,
 *     certificates, primary_ips, ingresses).
 *   - The state_events table gained the two new columns
 *     (capability_token_id, policy_eval_result) required by v2.
 *
 * Uses the standard pg test harness (DROP/CREATE schema → runMigrations).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPool, resetSchema, closeTestPool } from "../../test/fakes/pg-harness.js";
import { runMigrations } from "./db.js";
import type pg from "pg";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
  await resetSchema(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await closeTestPool();
});

describe("v2 Bloco A migration (004_v2_bloco_a.sql)", () => {
  it("migration creates v2 tables and adds StateEvent columns", async () => {
    const rows = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('firewalls','load_balancers','certificates','primary_ips','ingresses')
      ORDER BY table_name
    `);
    expect(rows.rows.map((r) => r.table_name)).toEqual([
      "certificates",
      "firewalls",
      "ingresses",
      "load_balancers",
      "primary_ips",
    ]);

    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'state_events'
        AND column_name IN ('capability_token_id','policy_eval_result')
      ORDER BY column_name
    `);
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "capability_token_id",
      "policy_eval_result",
    ]);
  });
});
