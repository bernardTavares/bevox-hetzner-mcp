/**
 * core/src/agent/v2/kubectl-apply.rest.test.ts
 *
 * Bloco E Task 14 — TDD teeth for the REST wire of `kubectl_apply`:
 *
 *   - seam absent (deps.kubectlApply undefined) ⇒ `POST /api/v2/kube/apply`
 *     falls through to the contract 404, NO StateEvent, NO approval row;
 *   - seam present ⇒ the route is wired and routes through the SHARED
 *     `kubectlApply(...)` function (same source as the MCP `kubectl_apply`
 *     tool); a valid call returns HTTP 200 + `status:"applied"`;
 *   - missing capability on the token ⇒ HTTP 403 + error envelope, NO
 *     StateEvent, NO approval row (deny-before-write).
 *
 * Mirrors the run-migrations REST test harness verbatim.
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
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { ALL_TOOLS, V2_TOOLS } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
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
// In-process HTTP doubles (run-migrations.rest.test.ts pattern)
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

const FIXED = new Date("2026-06-12T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOKUBE = "tok-nokube";

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

function makeWorld(opts?: {
  kubectlApply?: KubectlApplyDeps;
}): { rest: RestServer } {
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
    [TOKEN_NOKUBE]: {
      actor: "agent:limited",
      // FULL v1 tools, BUT no kubectl_apply capability.
      capabilities: [...ALL_TOOLS, "resolve_selector"],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(opts?.kubectlApply ? ["kubectl_apply"] : []),
    ...(opts?.kubectlApply !== undefined
      ? { kubectlApply: opts.kubectlApply }
      : {}),
  });
  return { rest };
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
  host: "k3s-server-1",
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "demo" },
  namespace: "bevox",
  body: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
};

const HOST_CONFIG: KubeHostConfig = { host: "k3s-server-1" };

function fakeKubeProvider(): KubernetesProvider {
  return {
    name: "kubernetes-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(
      d: KubeManifest,
      _o: ObservedEntity | null,
      _c?: ApplyContext,
    ): Promise<KubeApplyResult> {
      return { entity: `kube:${d.host}`, changed: true };
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
  const provider = fakeKubeProvider();
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

describe("Bloco E Task 14 — POST /api/v2/kube/apply (REST wire)", () => {
  it("seam absent ⇒ 404 contract-shaped envelope", async () => {
    const { rest } = makeWorld(); // no `kubectlApply` dep
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/kube/apply",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(404);
    expect((r.body as { status: string }).status).toBe("error");
  });

  it("seam present ⇒ 200 envelope status:'applied'", async () => {
    const { rest } = makeWorld({ kubectlApply: passingDeps() });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/kube/apply",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("applied");
  });

  it("missing kubectl_apply capability on token ⇒ 403 + error envelope, NO state changes", async () => {
    const { rest } = makeWorld({ kubectlApply: passingDeps() });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/kube/apply",
      token: TOKEN_NOKUBE,
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
