/**
 * core/src/agent/v2/ensure-k3s.rest.test.ts
 *
 * Bloco E Task 23 — TDD teeth for the REST wire of `ensure_k3s`:
 *
 *   - seam absent (deps.ensureK3s undefined) ⇒ `POST /api/v2/k3s/ensure`
 *     falls through to the contract 404, NO StateEvent, NO approval row;
 *   - seam present ⇒ the route is wired and routes through the SHARED
 *     `ensureK3s(...)` function (same source as the MCP `ensure_k3s` tool); a
 *     valid call returns HTTP 200 + `status:"applied"`;
 *   - missing capability on the token ⇒ HTTP 403 + error envelope, NO
 *     StateEvent, NO approval row (deny-before-write).
 *
 * Mirrors the kubectl-apply REST test harness verbatim.
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
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { ALL_TOOLS, V2_TOOLS } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
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
// In-process HTTP doubles (kubectl-apply.rest.test.ts pattern)
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
const TOKEN_NOK3S = "tok-nok3s";

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
  ensureK3s?: EnsureK3sToolDeps;
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
    [TOKEN_NOK3S]: {
      actor: "agent:limited",
      // FULL v1 tools, BUT no ensure_k3s capability.
      capabilities: [...ALL_TOOLS, "resolve_selector"],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(opts?.ensureK3s ? ["ensure_k3s"] : []),
    ...(opts?.ensureK3s !== undefined ? { ensureK3s: opts.ensureK3s } : {}),
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
  version: "v1.30.2+k3s1",
  role: "server",
};

const HOST_CONFIG: EnsureK3sHostConfig = { host: "k3s-server-1" };

function fakeProvider(): EnsureK3sProvider {
  return {
    name: "ensure-k3s-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(d: EnsureK3s): Promise<EnsureK3sApplyResult> {
      return { entity: `k3s:${d.host}`, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

function passingDeps(): EnsureK3sToolDeps {
  const provider = fakeProvider();
  return {
    resolveHost: async (): Promise<EnsureK3sHostConfig> => HOST_CONFIG,
    getEnsureK3sProvider: () => provider,
    approvalGate: passThroughGate,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Bloco E Task 23 — POST /api/v2/k3s/ensure (REST wire)", () => {
  it("seam absent ⇒ 404 contract-shaped envelope", async () => {
    const { rest } = makeWorld(); // no `ensureK3s` dep
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/k3s/ensure",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(404);
    expect((r.body as { status: string }).status).toBe("error");
  });

  it("seam present ⇒ 200 envelope status:'applied'", async () => {
    const { rest } = makeWorld({ ensureK3s: passingDeps() });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/k3s/ensure",
      body: VALID_INPUT,
    });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("applied");
  });

  it("missing ensure_k3s capability on token ⇒ 403 + error envelope, NO state changes", async () => {
    const { rest } = makeWorld({ ensureK3s: passingDeps() });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/k3s/ensure",
      token: TOKEN_NOK3S,
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
