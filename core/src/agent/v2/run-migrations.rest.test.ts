/**
 * core/src/agent/v2/run-migrations.rest.test.ts
 *
 * Task 7.1 — TDD teeth for the REST wire of `run_migrations`:
 *
 *   - seam absent (deps.runMigrations undefined) ⇒ `POST /api/v2/migrations`
 *     falls through to the contract 404, NO StateEvent, NO approval row;
 *   - seam present ⇒ the route is wired and routes through the SHARED
 *     `runMigrations(...)` function (same source as the MCP `run_migrations`
 *     tool). A per-migration failure surfaces as HTTP 200 with envelope
 *     `status:"applied"` + `report.applied[0].result:"error"` (spec §2.3 —
 *     per-migration error is DATA, not an HTTP failure);
 *   - missing capability on the token ⇒ HTTP 403 + error envelope, NO
 *     StateEvent, NO approval row (deny-before-write).
 *
 * Mirrors the F1.4 set-firewall REST test harness verbatim.
 *
 * Spec: docs/specs/2026-05-28-migration-runner-v1.md §1.4 + §2.3
 * Plan: docs/superpowers/plans/2026-05-28-migration-runner-v1.md task 7.1
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { ALL_TOOLS, V2_TOOLS } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
import type { RunMigrationsDeps } from "./run-migrations.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Service } from "../../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../../providers/provider.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations as runMigrationsTable } from "../../store/db.js";

// ===========================================================================
// In-process HTTP doubles (set-firewall.test.ts pattern)
// ===========================================================================

class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private body: Buffer;
  constructor(opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }) {
    super();
    this.method = opts.method;
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.body =
      opts.body === undefined
        ? Buffer.alloc(0)
        : Buffer.from(JSON.stringify(opts.body), "utf8");
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.body.length > 0) yield this.body;
  }
}

class FakeRes {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  headersSent = false;
  private chunks: Buffer[] = [];
  done: Promise<void>;
  private resolveDone!: () => void;
  constructor() {
    this.done = new Promise<void>((r) => {
      this.resolveDone = r;
    });
  }
  writeHead(status: number, headers: Record<string, unknown>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  end(chunk?: Buffer | string): void {
    if (chunk) {
      this.chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    }
    this.resolveDone();
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  json(): unknown {
    const t = this.text;
    return t === "" ? undefined : JSON.parse(t);
  }
}

// ===========================================================================
// Harness
// ===========================================================================

const FIXED = new Date("2026-05-28T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOMIG = "tok-nomig";

let pool: pg.Pool;

beforeAll(() => {
  pool = getTestPool();
});
afterAll(async () => {
  await closeTestPool();
});
beforeEach(async () => {
  await resetSchema(pool);
  await runMigrationsTable(pool);
});

interface World {
  rest: RestServer;
  gate: ReturnType<typeof createApprovalGate>;
}

function makeWorld(opts?: {
  runMigrations?: RunMigrationsDeps;
}): World {
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock,
    idFactory: () => `apr_test_${++idn}`,
  });

  const v1Provider: Provider = {
    name: "fake-v1",
    async observe(scope: string): Promise<ObservedSlice> {
      return { scope, entities: [] };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      return { entity: action.entity, op: action.op, changed: false };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
  const catalog = createToolCatalog({
    pool,
    provider: v1Provider,
    observedAdapter: () => ({
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    }),
    loadDesired: async (): Promise<DesiredState> => ({}),
    writeDesired: async (): Promise<void> => {},
    makeGate: (isSensitive): ReconcileGate =>
      createApprovalGate({
        pool,
        clock,
        isSensitive,
        idFactory: () => `apr_test_${++idn}`,
      }),
  });
  const credentials = createInjectedCredentialStore({
    [TOKEN_FULL]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
    [TOKEN_NOMIG]: {
      actor: "agent:limited",
      // FULL v1 tools, BUT no run_migrations capability.
      capabilities: [...ALL_TOOLS, "resolve_selector"],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(opts?.runMigrations ? ["run_migrations"] : []),
    ...(opts?.runMigrations !== undefined
      ? { runMigrations: opts.runMigrations }
      : {}),
  });
  return { rest, gate };
}

async function restCall(
  rest: RestServer,
  opts: {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    headers["authorization"] = `Bearer ${opts.token ?? TOKEN_FULL}`;
  }
  const req = new FakeReq({
    method: opts.method,
    url: opts.url,
    headers,
    body: opts.body,
  });
  const res = new FakeRes();
  await rest.handle(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  await res.done;
  return { status: res.statusCode, body: res.json() };
}

// ===========================================================================
// Fixtures
// ===========================================================================

const VALID_INPUT = {
  target_service: "pg",
  database: "bevox_harness",
  migrations: [{ filename: "001_init.sql", sql: "CREATE TABLE x();" }],
};

function pgServiceProvider(): () => Promise<readonly Service[]> {
  return async () => [
    {
      name: "pg",
      image: "postgres:16",
      replicas: 1,
      container_ids: ["cid1"],
    } satisfies Service,
  ];
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Task 7.1 — POST /api/v2/migrations (REST wire)", () => {
  it("seam absent ⇒ 404 contract-shaped envelope", async () => {
    const { rest } = makeWorld(); // no `runMigrations` dep
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/migrations",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(404);
    expect((r.body as { status: string }).status).toBe("error");
  });

  it("seam present ⇒ 200 envelope status:'applied' even on per-migration error (spec §2.3)", async () => {
    // dockerExec returns exit 1 + SQLSTATE → per-migration error_code.
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
      // The apply exec fails with SQLSTATE 42601 (syntax).
      return {
        exitCode: 1,
        stdout: "",
        stderr: "ERROR: bad\nSQLSTATE: 42601\n",
      };
    };
    const { rest } = makeWorld({
      runMigrations: {
        servicesProvider: pgServiceProvider(),
        approvalGate: {
          name: "always-pass",
          async evaluate(items) {
            return { approved: [...items], denied: [], pendingApprovals: [] };
          },
        },
        dockerExec,
      },
    });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/migrations",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(200);
    const env = r.body as {
      status: string;
      report?: { applied?: { result: string; error_code?: string }[] };
    };
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.result).toBe("error");
    expect(env.report?.applied?.[0]?.error_code).toBe("syntax");
  });

  it("missing run_migrations capability on token ⇒ 403 + error envelope, NO state changes", async () => {
    const { rest } = makeWorld({
      runMigrations: {
        servicesProvider: pgServiceProvider(),
        approvalGate: {
          name: "always-pass",
          async evaluate(items) {
            return { approved: [...items], denied: [], pendingApprovals: [] };
          },
        },
      },
    });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/migrations",
      token: TOKEN_NOMIG,
      body: VALID_INPUT,
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});
