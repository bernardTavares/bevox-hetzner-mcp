/**
 * core/src/agent/v2/ensure-k3s.mcp.test.ts
 *
 * Bloco E Task 23 — TDD teeth for the MCP wire of `ensure_k3s`:
 *
 *   - seam absent (no `ensure_k3s` in `v2Tools` or no deps) ⇒ `ensure_k3s` is
 *     NOT advertised in `tools/list` (the FROZEN 12-tool listing assertion stays
 *     byte-stable for prior callers);
 *   - seam present + `v2Tools` opts in ⇒ tool is callable; with a valid
 *     credential + valid input the returned envelope is `status:"applied"`
 *     (same source as REST `POST /api/v2/k3s/ensure`).
 *
 * Mirrors the kubectl-apply MCP test setup verbatim.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 23)
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
import { passThroughGate } from "../../reconciler/reconcile.js";
import type {
  EnsureK3sToolDeps,
  EnsureK3sHostConfig,
} from "./ensure-k3s.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
  ObservedEntity,
} from "../../providers/provider.js";
import type {
  EnsureK3sProvider,
  EnsureK3sApplyResult,
} from "../../providers/v2/ensure-k3s.js";
import type { EnsureK3s } from "../../domain/entities-v2.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations as runMigrationsTable } from "../../store/db.js";

// ===========================================================================
// Harness
// ===========================================================================

const FIXED = new Date("2026-06-12T00:00:00.000Z");
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
  ensureK3s?: EnsureK3sToolDeps;
  v2Tools?: ReadonlySet<string>;
}): ReturnType<typeof createMcpServer> {
  let idn = 0;
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
  });
  return createMcpServer({
    catalog,
    credentials,
    v2Tools: opts?.v2Tools as never,
    ...(opts?.ensureK3s !== undefined ? { ensureK3s: opts.ensureK3s } : {}),
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
  host: "k3s-server-1",
  version: "v1.30.2+k3s1",
  role: "server",
};

const HOST_CONFIG: EnsureK3sHostConfig = { host: "k3s-server-1" };

function fakeProvider(applies: EnsureK3s[]): EnsureK3sProvider {
  return {
    name: "ensure-k3s-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(desired: EnsureK3s): Promise<EnsureK3sApplyResult> {
      applies.push(desired);
      return { entity: `k3s:${desired.host}`, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

function passingDeps(): EnsureK3sToolDeps {
  const provider = fakeProvider([]);
  return {
    resolveHost: async (): Promise<EnsureK3sHostConfig> => HOST_CONFIG,
    getEnsureK3sProvider: () => provider,
    approvalGate: passThroughGate,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Bloco E Task 23 — MCP ensure_k3s tool wire", () => {
  it("seam absent ⇒ 'ensure_k3s' NOT in tools/list", async () => {
    const mcp = makeMcp(); // no v2Tools opt-in, no ensureK3s dep
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).not.toContain("ensure_k3s");
    } finally {
      await client.close();
    }
  });

  it("seam present + v2Tools has 'ensure_k3s' ⇒ tool callable, returns applied envelope", async () => {
    const mcp = makeMcp({
      v2Tools: new Set(["ensure_k3s"]),
      ensureK3s: passingDeps(),
    });
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("ensure_k3s");
      const res = await client.callTool({
        name: "ensure_k3s",
        arguments: {
          _credential: TOKEN_FULL,
          ...VALID_INPUT,
        },
      });
      const env = structured(res) as { status: string };
      expect(env.status).toBe("applied");
    } finally {
      await client.close();
    }
  });
});
