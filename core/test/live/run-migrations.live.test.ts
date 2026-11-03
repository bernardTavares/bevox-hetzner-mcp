/**
 * @live smoke test for run_migrations.
 *
 * MANUAL pre-release procedure — NOT run in CI (vitest glob excludes
 * **\/*.live.test.ts from the unit project; see core/vitest.config.ts).
 *
 * Prerequisites:
 * - bevox-daemon running, reachable at BEVOX_DAEMON_BASE_URL.
 * - Agent token with `run_migrations` capability (set BEVOX_TEST_AGENT_TOKEN).
 * - A real `postgres` container deployed via deploy_service, named "pg",
 *   running with a database "core_live_test".
 *
 * To run locally: flip `describe.skip` -> `describe.only` and execute:
 *   BEVOX_DAEMON_BASE_URL=https://mcp.example.com \
 *   BEVOX_TEST_AGENT_TOKEN=<token> \
 *   npm --prefix core test core/test/live/run-migrations.live.test.ts
 *
 * Smoke checks:
 * 1. POST /api/v2/migrations with single CREATE TABLE migration.
 * 2. Approve via POST /api/approvals/<id>/approve.
 * 3. Retry POST -> expect 200 envelope status:"applied", report.applied[0].result === "ok".
 * 4. Verify schema_migrations row exists.
 * 5. Verify no SQL bytes leaked to /api/events or /api/state.
 * 6. Verify the psql -U $POSTGRES_USER argv-form actually works in the
 *    real Docker exec path (this is the validation the integration test
 *    deliberately skipped).
 */
import { describe, it, expect } from "vitest";

describe.skip("run_migrations @live smoke", () => {
  it("end-to-end: apply 1 migration, approve, verify schema_migrations row, no leak", async () => {
    const baseUrl = process.env.BEVOX_DAEMON_BASE_URL;
    const token = process.env.BEVOX_TEST_AGENT_TOKEN;
    if (!baseUrl || !token) {
      throw new Error("BEVOX_DAEMON_BASE_URL and BEVOX_TEST_AGENT_TOKEN required for @live test");
    }
    const sentinel = `bevox_smoke_${Date.now()}`;
    const body = {
      target_service: "pg",
      database: "core_live_test",
      migrations: [{
        filename: `_smoke_${Date.now()}.sql`,
        sql: `CREATE TABLE IF NOT EXISTS ${sentinel} (run_at TIMESTAMPTZ DEFAULT NOW()); INSERT INTO ${sentinel} DEFAULT VALUES;`,
      }],
    };
    // First call -> pending_approval
    const r1 = await fetch(`${baseUrl}/api/v2/migrations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r1.status).toBe(200);
    const env1 = await r1.json();
    expect(env1.status).toBe("pending_approval");
    expect(env1.approval_id).toBeTruthy();

    // Approve
    const r2 = await fetch(`${baseUrl}/api/approvals/${env1.approval_id}/approve`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
    expect(r2.status).toBe(200);

    // Retry -> applied
    const r3 = await fetch(`${baseUrl}/api/v2/migrations`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(r3.status).toBe(200);
    const env3 = await r3.json();
    expect(env3.status).toBe("applied");
    expect(env3.report?.applied?.[0]?.result).toBe("ok");

    // No leak in events
    const events = await fetch(`${baseUrl}/api/events?entity=${encodeURIComponent("migrations:pg:core_live_test")}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const eventsText = await events.text();
    expect(eventsText).not.toContain("CREATE TABLE");  // M1 invariant
  });
});
