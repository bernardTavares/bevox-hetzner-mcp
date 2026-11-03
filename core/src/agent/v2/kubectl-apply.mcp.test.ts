/**
 * core/src/agent/v2/kubectl-apply.mcp.test.ts
 *
 * Bloco E Task 14 — TDD teeth for the MCP wire of `kubectl_apply`:
 *
 *   - seam absent (no `kubectl_apply` in `v2Tools` or no deps) ⇒
 *     `kubectl_apply` is NOT advertised in `tools/list` (the FROZEN 12-tool
 *     listing assertion stays byte-stable for prior callers);
 *   - seam present + `v2Tools` opts in ⇒ tool is callable; with a valid
 *     credential + valid input the returned envelope is `status:"applied"`
 *     (same source as REST `POST /api/v2/kube/apply`).
 *
 * Mirrors the run-migrations MCP test setup verbatim.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 14)
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
import type { KubectlApplyDeps, KubeHostConfig } from "./kubectl-apply.js";
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
  KubernetesProvider,
  KubeApplyResult,
} from "../../providers/v2/kube-apply.js";
import type { KubeManifest } from "../../domain/entities-v2.js";
import type { ApplyContext } from "../../store/secrets.js";
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
  kubectlApply?: KubectlApplyDeps;
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
    ...(opts?.kubectlApply !== undefined
      ? { kubectlApply: opts.kubectlApply }
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
  host: "k3s-server-1",
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "demo" },
  namespace: "bevox",
  body: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
};

const HOST_CONFIG: KubeHostConfig = { host: "k3s-server-1" };

function fakeKubeProvider(applies: KubeManifest[]): KubernetesProvider {
  return {
    name: "kubernetes-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(
      desired: KubeManifest,
      _o: ObservedEntity | null,
      _c?: ApplyContext,
    ): Promise<KubeApplyResult> {
      applies.push(desired);
      return { entity: `kube:${desired.host}`, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
    async destroy(d: KubeManifest): Promise<KubeApplyResult> {
      return { entity: `kube:${d.host}`, changed: true };
    },
  };
}

function passingDeps(): KubectlApplyDeps {
  const provider = fakeKubeProvider([]);
  return {
    resolveHost: async (): Promise<KubeHostConfig> => HOST_CONFIG,
    getProvider: () => provider,
    namespaceExists: async (): Promise<boolean> => true,
    approvalGate: passThroughGate,
    makeApplyContext: () => ({}) as unknown as ApplyContext,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Bloco E Task 14 — MCP kubectl_apply tool wire", () => {
  it("seam absent ⇒ 'kubectl_apply' NOT in tools/list", async () => {
    const mcp = makeMcp(); // no v2Tools opt-in, no kubectlApply dep
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).not.toContain("kubectl_apply");
    } finally {
      await client.close();
    }
  });

  it("seam present + v2Tools has 'kubectl_apply' ⇒ tool callable, returns applied envelope", async () => {
    const mcp = makeMcp({
      v2Tools: new Set(["kubectl_apply"]),
      kubectlApply: passingDeps(),
    });
    const client = await connectClient(mcp);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toContain("kubectl_apply");
      const res = await client.callTool({
        name: "kubectl_apply",
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
