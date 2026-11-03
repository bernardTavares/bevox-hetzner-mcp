/**
 * core/src/agent/v2/run-migrations.test.ts
 *
 * Task 5.x — TDD teeth for `run_migrations` (v2 write tool).
 *
 * Asserts on the single `runMigrations(...)` function, the shared core
 * for the REST `POST /api/v2/migrations` route and the MCP
 * `run_migrations` tool. Builds up step-by-step (5.1 → 5.4):
 *
 *   5.1 — capability gate (deny-before-write).
 *   5.2 — input parse via Zod (value-free precondition).
 *   5.3 — target_service resolution against observed services.
 *   5.4 — always-sensitive Approval Gate routing.
 *
 * Spec: docs/specs/2026-05-28-migration-runner-v1.md
 * Plan: docs/superpowers/plans/2026-05-28-migration-runner-v1.md
 */

import { describe, it, expect } from "vitest";
import { runMigrations, type RunMigrationsDeps } from "./run-migrations.js";
import { __mintVerifiedCredentialForTest } from "../capability.js";
import type { Service } from "../../domain/entities.js";
import { passThroughGate, type ReconcileGate } from "../../reconciler/reconcile.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Default deps for the runner. Each test overrides only what it cares about
 * via spread. The defaults are deliberately "useless but typed" — they
 * resolve to empty/no-op shapes so tests that don't exercise a given dep
 * never accidentally depend on its behaviour.
 */
function makeDeps(overrides: Partial<RunMigrationsDeps> = {}): RunMigrationsDeps {
  const base: RunMigrationsDeps = {
    servicesProvider: async (): Promise<readonly Service[]> => [],
    approvalGate: passThroughGate,
  };
  return { ...base, ...overrides };
}

describe("runMigrations — capability gate", () => {
  it("credential without run_migrations cap → 403-class error envelope", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "resolve_selector",
    ]);
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "SELECT 1" }],
      },
      { credential: cred, scope: "service" },
      {} as unknown as Parameters<typeof runMigrations>[2],
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("fatal");
    expect(env.error?.message).toMatch(/run_migrations/);
  });
});

describe("runMigrations — input parse (precondition)", () => {
  it("invalid input (empty target_service) → error envelope precondition", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const env = await runMigrations(
      {
        target_service: "",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "x" }],
      } as unknown as Parameters<typeof runMigrations>[0],
      { credential: cred, scope: "service" },
      {} as unknown as Parameters<typeof runMigrations>[2],
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    // Value-free: the message must NOT echo any input value. The fields
    // here are deliberately distinctive so a careless `${err.message}`
    // splat would surface them.
    expect(env.error?.message).not.toMatch(/SELECT|x\.sql|database name|x/);
  });
});

describe("runMigrations — target_service resolution", () => {
  it("target_service not found in observed services → precondition envelope", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const deps = makeDeps({ servicesProvider: async () => [] });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "SELECT 1" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(env.error?.message).toMatch(/target service not running/);
  });

  it("target_service present but container_ids empty → precondition", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const deps = makeDeps({
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: [],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "SELECT 1" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
  });
});

describe("runMigrations — always-sensitive Approval Gate routing", () => {
  it("first call → pending_approval envelope; gate consulted with synthetic PlanItem", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    // A gate that denies every item once, surfacing a pending approval id.
    // Mirrors the contract surface set-firewall.ts consumes.
    const denyOnceGate: ReconcileGate = {
      name: "deny-once",
      async evaluate(items, _ctx) {
        return {
          approved: [],
          denied: items,
          pendingApprovals: items.map((it, i) => ({
            op: it.op,
            entity: it.entity,
            approvalId: `apr_${i}`,
          })),
        };
      },
    };
    const deps = makeDeps({
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
      approvalGate: denyOnceGate,
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "x.sql", sql: "SELECT 1" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBe("apr_0");
  });
});

describe("runMigrations — apply loop (5.5)", () => {
  it("happy: 1 migration applied → schema_migrations init runs FIRST, then INSERT", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const calls: string[][] = [];
    const dockerExec = async (
      containerId: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push([containerId, ...argv]);
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" }; // not applied
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001_init.sql", sql: "CREATE TABLE x()" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.join(" ")).toMatch(
      /CREATE TABLE IF NOT EXISTS schema_migrations/,
    );
    expect(
      calls.some((c) => c.join(" ").includes("INSERT INTO schema_migrations")),
    ).toBe(true);
    expect(env.report?.applied?.[0]?.result).toBe("ok");
    expect(env.report?.applied?.[0]?.filename).toBe("001_init.sql");
  });
});

describe("runMigrations — SQLSTATE → error_code + stop-on-first (5.7)", () => {
  it.each([
    ["42601", "syntax"],
    ["42501", "permission"],
    ["23505", "constraint"],
    ["08006", "unknown"],
  ])(
    "SQLSTATE %s maps to error_code %s and stops the batch",
    async (sqlstate, expectedCode) => {
      const cred = __mintVerifiedCredentialForTest("agent:test", [
        "run_migrations",
      ]);
      const dockerExec = async (
        _cid: string,
        argv: readonly string[],
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const dashCIdx = argv.indexOf("-c");
        const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
        if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (sql.startsWith("SELECT 1 FROM schema_migrations"))
          return { exitCode: 0, stdout: "", stderr: "" };
        if (sql.includes("BEGIN"))
          return {
            exitCode: 1,
            stdout: "",
            stderr: `ERROR: ...\nSQLSTATE: ${sqlstate}\n`,
          };
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      const deps = makeDeps({
        approvalGate: passThroughGate,
        dockerExec,
        servicesProvider: async () => [
          {
            name: "pg",
            image: "postgres:16",
            replicas: 1,
            container_ids: ["cid1"],
          } satisfies Service,
        ],
      });
      const env = await runMigrations(
        {
          target_service: "pg",
          database: "db",
          migrations: [
            { filename: "001.sql", sql: "BAD" },
            { filename: "002.sql", sql: "GOOD" },
          ],
        },
        { credential: cred, scope: "service" },
        deps,
      );
      // Per spec §2.3: HTTP envelope stays "applied"; per-migration error is data.
      expect(env.status).toBe("applied");
      expect(env.report?.applied?.[0]?.result).toBe("error");
      expect(env.report?.applied?.[0]?.error_code).toBe(expectedCode);
      // Stop-on-first: migration 2 never attempted.
      expect(env.report?.applied).toHaveLength(1);
    },
  );
});

describe("runMigrations — container_exited handling (5.8)", () => {
  it("docker exec throws 'container is not running' on init → error_code:'container_exited', batch stops", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) {
        throw new Error("docker exec failed: container is not running");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001.sql", sql: "CREATE TABLE x()" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.error_code).toBe("container_exited");
    expect(env.report?.applied?.[0]?.result).toBe("error");
    expect(env.report?.applied).toHaveLength(1);
  });

  it("docker exec throws 'container is not running' mid-batch → per-migration container_exited; stop", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      // BEGIN/apply throws — container died mid-batch.
      throw new Error("docker exec failed: container is not running");
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [
          { filename: "001.sql", sql: "CREATE TABLE x()" },
          { filename: "002.sql", sql: "CREATE TABLE y()" },
        ],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.result).toBe("error");
    expect(env.report?.applied?.[0]?.error_code).toBe("container_exited");
    expect(env.report?.applied).toHaveLength(1);
  });

  it("non-container-exited throw → error_code:'unknown', stop", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const dockerExec = async (
      _cid: string,
      _argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      throw new Error("ssh: connection reset by peer");
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001.sql", sql: "SELECT 1" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.error_code).toBe("unknown");
    expect(env.report?.applied?.[0]?.result).toBe("error");
  });
});

describe("runMigrations — per-migration timeout (5.9)", () => {
  it("dockerExec hangs past timeoutMs → error_code:'timeout', batch stops", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    // dockerExec only resolves on abort; otherwise the promise hangs forever.
    const dockerExec = async (
      _cid: string,
      _argv: readonly string[],
      opts?: { signal?: AbortSignal },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
        // otherwise never resolves
      });
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
      timeoutMs: 50,
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [
          { filename: "001.sql", sql: "SELECT 1" },
          { filename: "002.sql", sql: "SELECT 2" },
        ],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.error_code).toBe("timeout");
    expect(env.report?.applied?.[0]?.result).toBe("error");
    // Stop-on-first: migration 2 never attempted.
    expect(env.report?.applied).toHaveLength(1);
  });
});

describe("runMigrations — sentinel leak prevention (5.10, M2)", () => {
  it("L5: PG stderr containing S3CR3T-6.2-migration-leak-XYZ never leaks into report/envelope", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.includes("BEGIN"))
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            'ERROR:  password "S3CR3T-6.2-migration-leak-XYZ" must be quoted\nSQLSTATE: 42601\n',
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001.sql", sql: "BAD" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(JSON.stringify(env)).not.toMatch(/S3CR3T/);
  });
});

describe("runMigrations — argv form (5.11)", () => {
  it("argv form: SQL passes via '-c' argv pair, not stdin or temp file", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const calls: string[][] = [];
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "(1 row)\n", stderr: "" }; // pretend already applied
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    await runMigrations(
      {
        target_service: "pg",
        database: "bevox",
        migrations: [{ filename: "001_x.sql", sql: "CREATE TABLE foo();" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    const selectCall = calls.find((c) =>
      c.some((a) => a.startsWith("SELECT 1")),
    );
    expect(selectCall).toBeDefined();
    const dashCIdx = selectCall!.indexOf("-c");
    expect(dashCIdx).toBeGreaterThan(-1);
    expect(selectCall![dashCIdx + 1]).toMatch(/^SELECT 1 FROM schema_migrations/);
    expect(
      selectCall!.some((a) => a === "-f" || a.startsWith("/tmp/") || a === "<"),
    ).toBe(false);
  });
});

describe("runMigrations — StateEvent emission per migration (5.12, M1)", () => {
  it("each migration emits one StateEvent with actor + scope:'service' + entity 'migrations:<svc>:<db>'", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const events: Array<{
      actor: string;
      scope: string;
      entity: string;
      op: string;
      result: string;
      after?: Record<string, unknown>;
    }> = [];
    const appendEvent = async (
      _pool: unknown,
      evt: {
        actor: string;
        scope: string;
        entity: string;
        op: string;
        result: string;
        after?: Record<string, unknown>;
      },
    ): Promise<void> => {
      events.push(evt);
    };
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      appendEvent,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    await runMigrations(
      {
        target_service: "pg",
        database: "bevox",
        migrations: [
          { filename: "001.sql", sql: "CREATE TABLE x()" },
          { filename: "002.sql", sql: "CREATE TABLE y()" },
        ],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.actor).toBe("agent:test");
      expect(e.scope).toBe("service");
      expect(e.entity).toBe("migrations:pg:bevox");
      expect(e.op).toBe("create");
      expect(["ok", "noop", "error"]).toContain(e.result);
      // M1: no sql bytes ever in the event payload.
      expect(JSON.stringify(e)).not.toContain("CREATE TABLE x");
      expect(JSON.stringify(e)).not.toContain("CREATE TABLE y");
    }
  });
});

describe("runMigrations — idempotency noop branch (5.6)", () => {
  it("re-run same batch (filename already in schema_migrations) → result:'noop' per file, zero apply exec", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const calls: string[][] = [];
    const dockerExec = async (
      _cid: string,
      argv: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push([...argv]);
      const dashCIdx = argv.indexOf("-c");
      const sql = dashCIdx >= 0 ? (argv[dashCIdx + 1] ?? "") : "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations"))
        return { exitCode: 0, stdout: " 1\n(1 row)\n", stderr: "" }; // ALREADY APPLIED
      throw new Error(
        "unexpected exec — should not apply if SELECT returned 1",
      );
    };
    const deps = makeDeps({
      approvalGate: passThroughGate,
      dockerExec,
      servicesProvider: async () => [
        {
          name: "pg",
          image: "postgres:16",
          replicas: 1,
          container_ids: ["cid1"],
        } satisfies Service,
      ],
    });
    const env = await runMigrations(
      {
        target_service: "pg",
        database: "db",
        migrations: [{ filename: "001_init.sql", sql: "CREATE TABLE x()" }],
      },
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.result).toBe("noop");
    expect(
      calls.filter((c) => c.some((a) => a.includes("BEGIN"))),
    ).toHaveLength(0);
  });
});
