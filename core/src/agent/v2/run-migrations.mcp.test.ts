/**
 * core/src/agent/v2/run-migrations.mcp.test.ts
 *
 * Task 7.2 — TDD teeth for the MCP wire of `run_migrations`:
 *
 *   - seam absent (no `runMigrations` in `v2Tools` or no deps) ⇒
 *     `run_migrations` is NOT advertised in `tools/list` (the FROZEN 12-tool
 *     listing assertion stays byte-stable for prior callers);
 *   - seam present + `v2Tools` opts in ⇒ tool is callable; with a valid
 *     credential + valid input the returned envelope is `status:"applied"`
 *     (same source as REST `POST /api/v2/migrations`).
 *
 * Mirrors the F1.4 set-firewall MCP test setup verbatim.
 *
 * Spec: docs/specs/2026-05-28-migration-runner-v1.md §1.4
 * Plan: docs/superpowers/plans/2026-05-28-migration-runner-v1.md task 7.2
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type pg from "pg";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ALL_TOOLS, V2_TOOLS } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createMcpServer } from "../mcp.js";
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
// Harness
// ===========================================================================

const FIXED = new Date("2026-05-28T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";

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

function makeMcp(opts?: {
  runMigrations?: RunMigrationsDeps;
  v2Tools?: ReadonlySet<string>;
}): ReturnType<typeof createMcpServer> {
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
  void gate;
  const credentials = createInjectedCredentialStore({
    [TOKEN_FULL]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  return createMcpServer({
    catalog,
    credentials,
    v2Tools: opts?.v2Tools as never,
    ...(opts?.runMigrations !== undefined
      ? { runMigrations: opts.runMigrations }
      : {}),
  });
}

async function connectClient(
  mcp: ReturnType<typeof createMcpServer>,
): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(b);
  return client;
}

function structured(r: unknown): unknown {
  return (r as { structuredContent: unknown }).structuredContent;
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

function passingDockerExec(): (
  cid: string,
  argv: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return async (
    _cid: string,
    _argv: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Task 7.2 — MCP run_migrations tool wire", () => {
  it("seam absent ⇒ 'run_migrations' NOT in tools/list", async () => {
    const mcp = makeMcp(); // no v2Tools opt-in, no runMigrations dep
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).not.toContain("run_migrations");
    } finally {
      await client.close();
    }
  });

  it("seam present + v2Tools has 'run_migrations' ⇒ tool callable, returns applied envelope", async () => {
    const mcp = makeMcp({
      v2Tools: new Set(["run_migrations"]),
      runMigrations: {
        servicesProvider: pgServiceProvider(),
        approvalGate: {
          name: "always-pass",
          async evaluate(items) {
            return { approved: [...items], denied: [], pendingApprovals: [] };
          },
        },
        dockerExec: passingDockerExec(),
      },
    });
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("run_migrations");
      const res = await client.callTool({
        name: "run_migrations",
        arguments: {
          _credential: TOKEN_FULL,
          ...VALID_INPUT,
        },
      });
      const env = structured(res) as {
        status: string;
        report?: { applied?: { result: string }[] };
      };
      expect(env.status).toBe("applied");
      expect(env.report?.applied?.[0]?.result).toBe("ok");
    } finally {
      await client.close();
    }
  });
});
