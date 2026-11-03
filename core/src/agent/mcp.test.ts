/**
 * core/src/agent/mcp.test.ts
 *
 * Task 4.7 — TDD teeth for the MCP server. The CENTRAL guarantee: MCP is a
 * SECOND transport over the EXACT same 4.4 shared tool catalog REST (4.5)
 * uses — there is NO parallel tool/authz/approval/envelope logic. Proven by:
 *
 *   - PARITY (the teeth): an MCP `destroy` and a REST `POST /api/destroy` for
 *     the SAME input + SAME credential, run against the SAME pool/catalog/
 *     approval-gate/clock, produce the SAME `WriteEnvelope` (status
 *     `pending_approval`, same shape) AND the SAME resulting `StateEvent`
 *     (modulo the deterministic `seq`/`ts`) — envelope-equality AND
 *     StateEvent-equality assert no divergence;
 *   - 12 tools listed from the SINGLE `ALL_TOOLS` source (not a second list);
 *   - credential seam + deny-before-write parity: missing/invalid credential →
 *     the SAME fatal error, NO tool executed (no StateEvent, no approval row);
 *   - destructive ops still gated (`pending_approval`) — MCP cannot bypass 4.3;
 *   - reads return the contract shape and mutate nothing;
 *   - no token/secret leak in any MCP result.
 *
 * The server is driven through the real SDK `Client` over an in-process
 * `InMemoryTransport` pair (no stdio/socket race; deterministic). The REST
 * side reuses the rest.test.ts in-process handler pattern so BOTH transports
 * hit the identical catalog/pg/gate/clock.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { z } from "zod";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ALL_TOOLS } from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import { createToolCatalog } from "./tools.js";
import { createInjectedCredentialStore } from "./auth.js";
import { createRestServer, type RestServer } from "./rest.js";
import { createMcpServer } from "./mcp.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

// ===========================================================================
// By-value mirror of the relevant FROZEN contract schemas (rest.test.ts precedent)
// ===========================================================================

const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  entity: z.string(),
});
const WriteEnvelopeSchema = z.object({
  status: z.enum(["planned", "pending_approval", "applied", "error"]),
  plan: z.array(z.unknown()).optional(),
  approval_id: z.string().optional(),
  error: ErrorSchema.optional(),
});
const StateSchema = z.object({
  servers: z.array(z.unknown()),
  networks: z.array(z.unknown()),
  volumes: z.array(z.unknown()),
  services: z.array(z.unknown()),
  dns: z.array(z.unknown()),
  backups: z.array(z.unknown()),
});

// ===========================================================================
// In-process HTTP doubles for the REST side (rest.test.ts pattern)
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
    this.done = new Promise((r) => {
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
// Network-free fakes — IDENTICAL to rest.test.ts so REST/MCP hit the same core
// ===========================================================================

let pool: pg.Pool;

beforeAll(() => {
  pool = getTestPool();
});
afterAll(async () => {
  await closeTestPool();
});
beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

const FIXED = new Date("2026-05-18T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };

function makeFakeProvider(): Provider {
  const reality = new Set<string>();
  return {
    name: "fake",
    async observe(scope: string): Promise<ObservedSlice> {
      const prefix = `${scope}:`;
      return {
        scope,
        entities: [...reality]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      if (reality.has(action.entity)) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
}

const EMPTY: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

function observedAdapter(slice: ObservedSlice): State {
  const servers = slice.entities
    .filter((e) => e.key.startsWith("server:"))
    .map((e) => ({
      name: e.key.slice("server:".length),
      type: "cx22",
      location: "nbg1",
      network: "net-a",
      image: "ubuntu-24.04",
      status: "healthy" as const,
    }));
  const services = slice.entities
    .filter((e) => e.key.startsWith("service:"))
    .map((e) => ({
      name: e.key.slice("service:".length),
      image: "registry/x:v1",
      replicas: 1,
    }));
  return {
    ...EMPTY,
    servers: servers as State["servers"],
    services: services as State["services"],
  };
}

const TOKEN = "tok-vox";

/**
 * Build BOTH transports over the SAME pool/catalog/gate/clock. The id factory
 * is shared so deterministic ids are comparable; each test resets the schema
 * (beforeEach) so per-test counters start clean.
 */
function makeWorld(): {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
} {
  const desiredByScope = new Map<string, DesiredState>();
  const provider = makeFakeProvider();
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock,
    idFactory: () => `apr_test_${++idn}`,
  });
  const catalog = createToolCatalog({
    pool,
    provider,
    observedAdapter,
    loadDesired: async (scope: string): Promise<DesiredState> =>
      desiredByScope.get(scope) ?? {},
    writeDesired: async (scope: string, desired: DesiredState) => {
      desiredByScope.set(scope, desired);
    },
    makeGate: (isSensitive): ReconcileGate =>
      createApprovalGate({
        pool,
        clock,
        isSensitive,
        idFactory: () => `apr_test_${++idn}`,
      }),
  });
  const credentials = createInjectedCredentialStore({
    [TOKEN]: { actor: "agent:vox", capabilities: [...ALL_TOOLS] },
    "tok-empty": { actor: "agent:weak", capabilities: [] },
  });
  const rest = createRestServer({ catalog, credentials, approvalGate: gate });
  const mcp = createMcpServer({ catalog, credentials });
  return { rest, mcp };
}

async function restCall(
  rest: RestServer,
  opts: { method: string; url: string; token?: string | null; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    headers["authorization"] = `Bearer ${opts.token ?? TOKEN}`;
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

/** Connect a real SDK client to the MCP server over an in-memory pair. */
async function connectClient(
  mcp: ReturnType<typeof createMcpServer>,
): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

/** The structured payload of an MCP tools/call (the same shape REST returns). */
function structured(r: unknown): unknown {
  return (r as { structuredContent?: unknown }).structuredContent;
}

async function readEvents(): Promise<
  Array<{ actor: string; op: string; entity: string; result: string; scope: string }>
> {
  const rows = await pool.query<{
    actor: string;
    op: string;
    entity: string;
    result: string;
    scope: string;
  }>(
    "SELECT actor, op, entity, result, scope FROM state_events ORDER BY seq ASC",
  );
  return rows.rows;
}

// ===========================================================================
// 0. Tool surface = the 12, from the SINGLE ALL_TOOLS source
// ===========================================================================

describe("MCP tool surface", () => {
  it("lists EXACTLY the 12 ALL_TOOLS tools (single source, not a 2nd list)", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
      expect(tools).toHaveLength(ALL_TOOLS.length);
      for (const t of tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(typeof t.description).toBe("string");
      }
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// 1. THE TEETH — MCP destroy == REST destroy (envelope + StateEvent parity)
// ===========================================================================

describe("REST/MCP parity — same core, no parallel logic", () => {
  it("MCP destroy and REST POST /api/destroy → SAME WriteEnvelope + SAME StateEvent", async () => {
    const input = { entity: "server:app-1" };

    // --- REST destroy (real rest.ts handler, shared catalog) -------------
    const w1 = makeWorld();
    const rest = await restCall(w1.rest, {
      method: "POST",
      url: "/api/destroy",
      body: input,
    });
    expect(rest.status).toBe(200);
    const restEnv = WriteEnvelopeSchema.parse(rest.body);
    const restEvents = await readEvents();

    // Reset so the MCP run starts from the IDENTICAL clean state and the
    // deterministic id counter begins at the same value (true apples-to-apples).
    await resetSchema(pool);
    await runMigrations(pool);

    // --- MCP destroy (real SDK client over in-memory transport) ----------
    const w2 = makeWorld();
    const client = await connectClient(w2.mcp);
    let mcpEnv: z.infer<typeof WriteEnvelopeSchema>;
    let mcpEvents: Awaited<ReturnType<typeof readEvents>>;
    try {
      const res = await client.callTool({
        name: "destroy",
        arguments: { ...input, _credential: TOKEN },
      });
      mcpEnv = WriteEnvelopeSchema.parse(structured(res));
      mcpEvents = await readEvents();
    } finally {
      await client.close();
    }

    // ENVELOPE parity — identical shape & values (deterministic ids match
    // because both worlds use the same injected idFactory from a reset DB).
    expect(mcpEnv.status).toBe("pending_approval");
    expect(mcpEnv).toEqual(restEnv);

    // STATEEVENT parity — same audited actor/op/entity/result/scope, same
    // count (ts is fixed by the injected clock; seq is the only divergence and
    // is excluded by the projection). Proves the SAME authz/audit spine ran.
    expect(mcpEvents).toEqual(restEvents);
    expect(mcpEvents.length).toBeGreaterThanOrEqual(1);
    expect(mcpEvents.some((e) => e.op === "destroy")).toBe(true);
  });

  it("destructive op stays gated through MCP — pending_approval, never auto-destructs", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "destroy",
        arguments: { entity: "server:db-1", _credential: TOKEN },
      });
      const env = WriteEnvelopeSchema.parse(structured(res));
      expect(env.status).toBe("pending_approval");
      expect(env.approval_id).toMatch(/^apr_/);
      const apr = await pool.query(
        "SELECT count(*)::int AS n FROM approvals WHERE status='pending'",
      );
      expect(apr.rows[0].n).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("read tool via MCP returns the contract State shape and mutates nothing", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "get_state",
        arguments: { _credential: TOKEN },
      });
      expect(() => StateSchema.parse(structured(res))).not.toThrow();
      const ws = await pool.query(
        "SELECT count(*)::int AS n FROM working_state",
      );
      expect(ws.rows[0].n).toBe(0);
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// 2. Credential seam (4.2) — deny-before-write parity with REST
// ===========================================================================

describe("MCP credential seam — deny-before-write", () => {
  it("missing credential → SAME fatal error, NO tool executed (no event/approval)", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "destroy",
        arguments: { entity: "server:app-1" }, // no _credential
      });
      expect(res.isError).toBe(true);
      const env = WriteEnvelopeSchema.parse(structured(res));
      expect(env.status).toBe("error");
      expect(env.error!.code).toBe("fatal");
      // deny-before-write: NOTHING executed.
      const ev = await pool.query(
        "SELECT count(*)::int AS n FROM state_events",
      );
      expect(ev.rows[0].n).toBe(0);
      const apr = await pool.query(
        "SELECT count(*)::int AS n FROM approvals",
      );
      expect(apr.rows[0].n).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("unknown token → fatal error envelope, no execution (parity with REST)", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "deploy_service",
        arguments: {
          name: "x",
          image: "y",
          replicas: 1,
          _credential: "nope",
        },
      });
      expect(res.isError).toBe(true);
      expect(WriteEnvelopeSchema.parse(structured(res)).error!.code).toBe(
        "fatal",
      );
      const ev = await pool.query(
        "SELECT count(*)::int AS n FROM state_events",
      );
      expect(ev.rows[0].n).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("authenticated but lacking the capability → fatal (shared catalog authz)", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "get_state",
        arguments: { _credential: "tok-empty" },
      });
      expect(res.isError).toBe(true);
      expect(WriteEnvelopeSchema.parse(structured(res)).error!.code).toBe(
        "fatal",
      );
    } finally {
      await client.close();
    }
  });

  it("never leaks the token in any MCP result", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "deploy_service",
        arguments: {
          name: "x",
          image: "y",
          replicas: 1,
          _credential: "super-secret-token",
        },
      });
      expect(JSON.stringify(res)).not.toContain("super-secret-token");
    } finally {
      await client.close();
    }
  });

  it("unknown tool → contract fatal error from the shared catalog (no fork)", async () => {
    const { mcp } = makeWorld();
    const client = await connectClient(mcp);
    try {
      const res = await client.callTool({
        name: "not_a_tool",
        arguments: { _credential: TOKEN },
      });
      expect(res.isError).toBe(true);
      expect(WriteEnvelopeSchema.parse(structured(res)).status).toBe("error");
    } finally {
      await client.close();
    }
  });
});
