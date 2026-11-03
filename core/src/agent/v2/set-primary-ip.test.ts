/**
 * core/src/agent/v2/set-primary-ip.test.ts
 *
 * Task F2.4 — TDD teeth for `set_primary_ip` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `setPrimaryIp(...)` function (the shared core both
 * the REST `POST /api/v2/primary-ips` route and the MCP `set_primary_ip`
 * tool call):
 *
 *   - `dry_run:true`  ⇒ `{ status:"planned", plan }`, NO working-store write,
 *                       NO approval row, NO StateEvent.
 *   - `dry_run:false` for a new PrimaryIP (observed null) ⇒
 *                       `{ status:"pending_approval", approval_id:"apr_…" }`,
 *                       NO working-store write (approval-always; PrimaryIP
 *                       is billed even when unassigned).
 *   - `dry_run:false` for an already-converged PrimaryIP ⇒
 *                       `{ status:"applied", plan:{ ops:[] } }`, idempotent
 *                       no-op; NO approval, NO StateEvent.
 *   - `dry_run:false` for an assignment change ⇒ pending_approval.
 *   - `assignee_selector` matches >1 servers ⇒ precondition_failed envelope
 *     at the tool boundary (inline ≤1 check; the F2.3 provider duplicates
 *     this at apply — defence-in-depth).
 *   - REST `POST /api/v2/primary-ips` returns the same envelope.
 *   - MCP `set_primary_ip` returns the SAME envelope shape REST does
 *     (parity); missing v2 capability ⇒ error envelope (parity with REST 403).
 *   - Idempotency: a desired applied twice via approval-then-apply cycle
 *     settles correctly.
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ALL_TOOLS,
  V2_TOOLS,
  __mintVerifiedCredentialForTest,
} from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
import { createMcpServer } from "../mcp.js";
import {
  setPrimaryIp,
  createInMemoryWorkingPrimaryIpStore,
  type WorkingPrimaryIpStore,
} from "./set-primary-ip.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../../providers/v2/hetzner-cloud-v2-http.js";
import {
  createHetznerPrimaryIPProvider,
  type PrimaryIPProvider,
} from "../../providers/v2/hetzner-primary-ip.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Server } from "../../domain/entities.js";
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
import { runMigrations } from "../../store/db.js";

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
// Common harness
// ===========================================================================

const BASE = "https://api.hetzner.cloud/v1";
const FIXED = new Date("2026-05-20T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOPIP = "tok-nopip";

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

function mkServer(
  name: string,
  hcloud_id: number,
  labels: Record<string, string> = {},
): Server {
  return {
    name,
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels,
    network: "mesh",
    status: "healthy",
    hcloud_id,
  };
}

interface World {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
  provider: PrimaryIPProvider;
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>;
  servers: Server[];
  workingStore: WorkingPrimaryIpStore;
  /** Always-sensitive gate — every synthetic PlanItem (`create`/`update`) is gated. */
  gate: ReturnType<typeof createApprovalGate>;
}

function makeWorld(opts?: { servers?: Server[] }): World {
  const servers = opts?.servers ?? [];
  const fakeHetzner = createHetznerHttpFake();
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  const provider = createHetznerPrimaryIPProvider({
    http: v2http,
    serversProvider: async () => servers,
  });
  const workingStore = createInMemoryWorkingPrimaryIpStore();
  let idn = 0;
  // APPROVAL-ALWAYS — set_primary_ip's synthetic PlanItems use op=create/
  // update which are NOT in defaultSensitiveOps; the deps contract requires
  // a gate configured with isSensitive:() => true. See set-primary-ip.ts.
  const gate = createApprovalGate({
    pool,
    clock,
    isSensitive: () => true,
    idFactory: () => `apr_test_${++idn}`,
  });

  // v1 fake provider & catalog (so the REST server can be constructed —
  // its v1 surface stays inert in these tests).
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
    [TOKEN_NOPIP]: {
      actor: "agent:limited",
      // FULL v1 tools, BUT no set_primary_ip capability.
      capabilities: [...ALL_TOOLS, "resolve_selector", "set_firewall"],
    },
  });
  const setPrimaryIpDeps = {
    pool,
    provider,
    approvalGate: gate,
    workingStore,
    serversProvider: async () => servers,
  };
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["set_primary_ip"]),
    setPrimaryIp: setPrimaryIpDeps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["set_primary_ip"]),
    setPrimaryIp: setPrimaryIpDeps,
  });
  return { rest, mcp, provider, fakeHetzner, servers, workingStore, gate };
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

async function connectMcpClient(
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

const PIP_NEW = {
  name: "web-ipv4",
  type: "ipv4" as const,
  location: "fsn1",
};

const PIP_ASSIGNED = {
  name: "web-ipv4",
  type: "ipv4" as const,
  location: "fsn1",
  assignee_selector: { name: "web-1" },
};

/** Pre-seed Hetzner with a primary_ip matching `PIP_NEW`, optionally assigned. */
async function seedPrimaryIp(
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>,
  body: {
    name: string;
    type: string;
    datacenter: string;
    assignee_type?: string;
    assignee_id?: number;
  },
): Promise<void> {
  const payload: Record<string, unknown> = {
    name: body.name,
    type: body.type,
    datacenter: body.datacenter,
  };
  if (body.assignee_type !== undefined) {
    payload.assignee_type = body.assignee_type;
    payload.assignee_id = body.assignee_id;
  }
  await fakeHetzner.fetch(`${BASE}/primary_ips`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ===========================================================================
// 1. Core function — setPrimaryIp directly
// ===========================================================================

describe("Task F2.4 — setPrimaryIp (core function)", () => {
  it("dry_run:true returns { status:'planned', plan } and writes NO state", async () => {
    const { provider, workingStore, gate } = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setPrimaryIp(
      { dry_run: true, primary_ip: PIP_NEW },
      { credential: cred, scope: "primary_ip" },
      {
        pool,
        provider,
        approvalGate: gate,
        workingStore,
        serversProvider: async () => [],
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
    expect(await workingStore.get("web-ipv4")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 2. REST POST /api/v2/primary-ips
// ===========================================================================

describe("Task F2.4 — POST /api/v2/primary-ips", () => {
  it("dry_run:true ⇒ planned envelope (canonical failing test)", async () => {
    const { rest } = makeWorld();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: true, primary_ip: PIP_NEW },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(Array.isArray(env.plan!.ops)).toBe(true);
  });

  it("dry_run:false on a NEW PrimaryIP ⇒ pending_approval, NO working-store write (approval-always)", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP_NEW },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // Working store untouched (fail-safe — even creation is held back).
    expect(await w.workingStore.get("web-ipv4")).toBeNull();
    // The gate opened a pending approval with the synthetic `create` op.
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["primary_ip:web-ipv4"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.status).toBe("pending");
    expect(apr.rows[0]!.op).toBe("create");
  });

  it("dry_run:false on an ALREADY-CONVERGED PrimaryIP ⇒ applied empty-ops (idempotent no-op, no approval)", async () => {
    const w = makeWorld();
    await seedPrimaryIp(w.fakeHetzner, {
      name: PIP_NEW.name,
      type: PIP_NEW.type,
      datacenter: PIP_NEW.location,
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP_NEW },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("applied");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops).toEqual([]);
    // No-op: working store NOT written, no approval row, no StateEvent.
    expect(await w.workingStore.get("web-ipv4")).toBeNull();
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("dry_run:false for an assignment CHANGE ⇒ pending_approval", async () => {
    const servers = [mkServer("web-1", 10, {})];
    const w = makeWorld({ servers });
    // Pre-seed Hetzner: PrimaryIP exists but is UNASSIGNED.
    await seedPrimaryIp(w.fakeHetzner, {
      name: PIP_NEW.name,
      type: PIP_NEW.type,
      datacenter: PIP_NEW.location,
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP_ASSIGNED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["primary_ip:web-ipv4"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.op).toBe("update");
    // Working store untouched (held back until approval resolves).
    expect(await w.workingStore.get("web-ipv4")).toBeNull();
  });

  it("assignee_selector matches >1 servers ⇒ precondition_failed envelope (inline ≤1 check)", async () => {
    const servers = [mkServer("web-1", 10, { web: "" }), mkServer("web-2", 11, { web: "" })];
    const w = makeWorld({ servers });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: {
        dry_run: false,
        primary_ip: { ...PIP_NEW, assignee_selector: { label: "web" } },
      },
    });
    expect(r.status).toBe(400);
    const env = r.body as { status: string; error?: { code: string; message: string } };
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(env.error?.message).toMatch(/matched 2 servers/);
    // No working-store write, no approval row, no StateEvent.
    expect(await w.workingStore.get("web-ipv4")).toBeNull();
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("missing set_primary_ip capability ⇒ 403, NO working-store write, NO StateEvent, NO approval", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      token: TOKEN_NOPIP,
      body: { dry_run: false, primary_ip: PIP_NEW },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.workingStore.get("web-ipv4")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("idempotency: pending_approval → approve → re-apply ⇒ applied with StateEvent", async () => {
    const w = makeWorld();
    // 1st call: creates a pending approval.
    const r1 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP_NEW },
    });
    const env1 = r1.body as { status: string; approval_id: string };
    expect(env1.status).toBe("pending_approval");
    // Resolve the approval as approved (via the gate directly — tests don't
    // need to round-trip through /api/approvals).
    await w.gate.resolveApproval(env1.approval_id, "approved", "agent:human");
    // 2nd call: same desired; the gate finds the approved record and lets
    // the synthetic PlanItem through ⇒ applied + working-store written +
    // StateEvent emitted.
    const r2 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP_NEW },
    });
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("applied");
    const stored = await w.workingStore.get("web-ipv4");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("web-ipv4");
    const ev = await pool.query<{
      actor: string;
      op: string;
      entity: string;
      result: string;
      after: unknown;
    }>(
      "SELECT actor, op, entity, result, after FROM state_events ORDER BY seq DESC LIMIT 1",
    );
    const row = ev.rows[0]!;
    expect(row.actor).toBe("agent:vox");
    expect(row.op).toBe("create");
    expect(row.entity).toBe("primary_ip:web-ipv4");
    expect(row.result).toBe("applied");
    expect(
      (row.after as { capability_token_id: unknown }).capability_token_id,
    ).toBeNull();
  });
});

// ===========================================================================
// 3. MCP set_primary_ip — parity with REST envelope
// ===========================================================================

describe("Task F2.4 — MCP set_primary_ip", () => {
  it("MCP set_primary_ip returns the SAME envelope shape as REST (dry_run:true)", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_primary_ip",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          primary_ip: PIP_NEW,
        },
      });
      const env = structured(res) as { status: string; plan?: unknown };
      expect(env.status).toBe("planned");
      expect(env.plan).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("MCP set_primary_ip with no v2 capability ⇒ error envelope (parity with REST 403)", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_primary_ip",
        arguments: {
          _credential: TOKEN_NOPIP,
          dry_run: false,
          primary_ip: PIP_NEW,
        },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      const env = structured(res) as { status: string };
      expect(env.status).toBe("error");
    } finally {
      await client.close();
    }
  });
});

// ===========================================================================
// 4. Task F4.4 — dry_run does NOT call provider.observe()
// ===========================================================================

describe("Task F4.4 — set_primary_ip dry_run does not call provider.observe()", () => {
  it("dry_run:true skips provider.observe() entirely; returns planned with create-from-empty ops", async () => {
    let observeCalls = 0;
    const sentinelProvider: PrimaryIPProvider = {
      name: "sentinel-pip",
      async observe(): Promise<null> {
        observeCalls += 1;
        throw new Error("observe must not be called in dry_run");
      },
      async plan(desired, observed) {
        if (observed === null) {
          return { ops: [{ op: "create", entity: `primary_ip:${desired.name}` }] };
        }
        return { ops: [] };
      },
      async apply() {
        throw new Error("apply must not be called in dry_run");
      },
      async verify() {
        return false;
      },
    };
    const workingStore = createInMemoryWorkingPrimaryIpStore();
    let idn = 0;
    const gate = createApprovalGate({
      pool,
      clock,
      isSensitive: () => true,
      idFactory: () => `apr_test_${++idn}`,
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const beforeStored = await workingStore.get("web-ipv4");
    const env = await setPrimaryIp(
      { dry_run: true, primary_ip: PIP_NEW },
      { credential: cred, scope: "primary_ip" },
      {
        pool,
        provider: sentinelProvider,
        approvalGate: gate,
        workingStore,
        serversProvider: async () => [],
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops.length).toBeGreaterThan(0);
    expect(await workingStore.get("web-ipv4")).toEqual(beforeStored);
    expect(observeCalls).toBe(0);
  });
});
