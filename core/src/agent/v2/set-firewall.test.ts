/**
 * core/src/agent/v2/set-firewall.test.ts
 *
 * Task F1.4 — TDD teeth for `set_firewall` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `setFirewall(...)` function (the shared core both the
 * REST `POST /api/v2/firewalls` route and the MCP `set_firewall` tool call):
 *
 *   - `dry_run:true`  ⇒ `{ status:"planned", plan }`, NO working-store write,
 *                       NO StateEvent (pure introspection).
 *   - `dry_run:false` for a new firewall (observed null) ⇒ `{ status:"applied" }`,
 *                       working-store updated, StateEvent appended with
 *                       `capability_token_id: null` in `after`.
 *   - Removing a rule that covers an active Server (observed has more rules
 *     than desired AND `applied_to` resolves to ≥1 server) ⇒
 *                       `{ status:"pending_approval", approval_id:"apr_…" }`,
 *                       NO working-store write (fail-safe).
 *   - Idempotent re-apply (no diff) ⇒ `{ status:"applied" }` with empty ops.
 *   - REST `POST /api/v2/firewalls` returns the same envelope.
 *   - MCP `set_firewall` returns the SAME envelope shape REST does (parity).
 *   - Capability scope without `set_firewall` ⇒ REST 403 / MCP fatal error
 *     envelope, NO working-store write, NO StateEvent, NO approval row.
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

import { ALL_TOOLS, V2_TOOLS, __mintVerifiedCredentialForTest } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
import { createMcpServer } from "../mcp.js";
import {
  setFirewall,
  createInMemoryWorkingFirewallStore,
  type WorkingFirewallStore,
} from "./set-firewall.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../../providers/v2/hetzner-cloud-v2-http.js";
import {
  createHetznerFirewallProvider,
  type FirewallProvider,
  type ObservedFirewall,
} from "../../providers/v2/hetzner-firewall.js";
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
const TOKEN_NOFW = "tok-nofw";

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
  provider: FirewallProvider;
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>;
  servers: Server[];
  workingStore: WorkingFirewallStore;
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
  const provider = createHetznerFirewallProvider({
    http: v2http,
    serversProvider: async () => servers,
  });
  const workingStore = createInMemoryWorkingFirewallStore();
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock,
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
    [TOKEN_NOFW]: {
      actor: "agent:limited",
      // FULL v1 tools, BUT no set_firewall capability.
      capabilities: [...ALL_TOOLS, "resolve_selector"],
    },
  });
  const setFirewallDeps = {
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
    v2Tools: new Set(["resolve_selector", "set_firewall"]),
    setFirewall: setFirewallDeps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["resolve_selector", "set_firewall"]),
    setFirewall: setFirewallDeps,
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

const FW_BASE = {
  name: "web-fw",
  rules: [
    {
      direction: "in" as const,
      protocol: "tcp" as const,
      port: "443",
      source_ips: ["0.0.0.0/0"],
    },
  ],
  applied_to: { label: "web" },
};

const FW_TWO_RULES = {
  ...FW_BASE,
  rules: [
    ...FW_BASE.rules,
    {
      direction: "in" as const,
      protocol: "tcp" as const,
      port: "80",
      source_ips: ["0.0.0.0/0"],
    },
  ],
};

// ===========================================================================
// 1. Core function — setFirewall directly
// ===========================================================================

describe("Task F1.4 — setFirewall (core function)", () => {
  it("dry_run:true returns { status:'planned', plan } and writes NO state", async () => {
    const { provider, workingStore, gate } = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setFirewall(
      { dry_run: true, firewall: FW_BASE },
      { credential: cred, scope: "firewall" },
      {
        pool,
        provider,
        approvalGate: gate,
        workingStore,
        serversProvider: async () => [mkServer("web-1", 10, { web: "" })],
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
    // NO working-store write.
    expect(await workingStore.get("web-fw")).toBeNull();
    // NO StateEvent.
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  // Spec docs/specs/2026-05-27-mcp-string-interop-batch.md §3 #3:
  // some MCP clients serialize nested object args as JSON strings.
  // setFirewall must accept `firewall: "<JSON string>"` equivalently to
  // `firewall: <object>`. Companion test to the asBool dry_run coercion.
  it("accepts firewall as JSON-encoded string (MCP-client interop)", async () => {
    const { provider, workingStore, gate } = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setFirewall(
      {
        dry_run: true,
        firewall: JSON.stringify(FW_BASE) as unknown as typeof FW_BASE,
      },
      { credential: cred, scope: "firewall" },
      {
        pool,
        provider,
        approvalGate: gate,
        workingStore,
        serversProvider: async () => [mkServer("web-1", 10, { web: "" })],
      },
    );
    // No precondition error from "expected object, received string".
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
  });

  // Spec docs/specs/2026-05-27-set-firewall-synchronous-apply.md §4 #1:
  // bug #15 — set_firewall must converge Hetzner reality via provider.apply
  // BEFORE persisting intent. Pre-fix the tool wrote workingStore + emitted
  // StateEvent without ever touching the Hetzner API → "applied" envelope
  // but zero side-effect.
  it("apply path actually creates firewall in (fake) Hetzner (bug #15 regression)", async () => {
    const w = makeWorld({ servers: [mkServer("web-1", 10, { web: "" })] });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    // Pre-condition: fake Hetzner has zero firewalls.
    const before = await w.fakeHetzner.fetch(`${BASE}/firewalls`, {});
    const beforeBody = await before.json();
    expect(beforeBody.firewalls).toHaveLength(0);

    const env = await setFirewall(
      { dry_run: false, firewall: FW_BASE },
      { credential: cred, scope: "firewall" },
      {
        pool,
        provider: w.provider,
        approvalGate: w.gate,
        workingStore: w.workingStore,
        serversProvider: async () => [mkServer("web-1", 10, { web: "" })],
      },
    );
    expect(env.status).toBe("applied");

    // Post-condition: fake Hetzner now has the firewall.
    const after = await w.fakeHetzner.fetch(`${BASE}/firewalls`, {});
    const afterBody = await after.json();
    expect(afterBody.firewalls).toHaveLength(1);
    expect(afterBody.firewalls[0].name).toBe(FW_BASE.name);
  });
});

// ===========================================================================
// 2. REST POST /api/v2/firewalls
// ===========================================================================

describe("Task F1.4 — POST /api/v2/firewalls", () => {
  it("dry_run:true ⇒ planned envelope (canonical failing test)", async () => {
    const { rest } = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: true, firewall: FW_BASE },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(Array.isArray(env.plan!.ops)).toBe(true);
  });

  it("dry_run:false on a new firewall (observed null) ⇒ applied + working-store updated + StateEvent", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: false, firewall: FW_BASE },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "applied" });
    const stored = await w.workingStore.get("web-fw");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("web-fw");
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
    expect(row.entity).toBe("firewall:web-fw");
    expect(row.result).toBe("applied");
    // capability_token_id is null in Bloco A — explicit, never omitted.
    expect((row.after as { capability_token_id: unknown }).capability_token_id).toBeNull();
  });

  it("removing a rule that covers an active server ⇒ pending_approval, NO working-store write", async () => {
    const servers = [mkServer("web-1", 10, { web: "" })];
    const w = makeWorld({ servers });
    // Pre-seed Hetzner with the TWO-rule firewall applied to web-1.
    await w.fakeHetzner.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: FW_TWO_RULES.name,
        rules: FW_TWO_RULES.rules,
        apply_to: [{ type: "server", server: { id: 10 } }],
      }),
    });
    // Apply the ONE-rule desired (removes the :80 rule).
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: false, firewall: FW_BASE },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // Working store untouched (fail-safe — destructive change held back).
    expect(await w.workingStore.get("web-fw")).toBeNull();
    // The gate opened a pending approval (its own pending_approval event).
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["firewall:web-fw"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.status).toBe("pending");
    expect(apr.rows[0]!.op).toBe("remove");
  });

  it("removing a rule when applied_to resolves to ZERO servers is NOT destructive ⇒ applied", async () => {
    // No servers ⇒ applied_to:{label:web} resolves to []. A rule removal is
    // then NOT destructive (no active server is currently protected).
    const w = makeWorld({ servers: [] });
    await w.fakeHetzner.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: FW_TWO_RULES.name,
        rules: FW_TWO_RULES.rules,
        apply_to: [],
      }),
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: false, firewall: FW_BASE },
    });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("applied");
    expect(await w.workingStore.get("web-fw")).not.toBeNull();
  });

  it("missing set_firewall capability ⇒ 403, NO working-store write, NO StateEvent", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      token: TOKEN_NOFW,
      body: { dry_run: false, firewall: FW_BASE },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.workingStore.get("web-fw")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("missing/invalid credential ⇒ 403 with NO StateEvent (authn fails first)", async () => {
    const w = makeWorld({});
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      token: null,
      body: { dry_run: true, firewall: FW_BASE },
    });
    expect(r.status).toBe(403);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 3. MCP set_firewall — parity with REST envelope
// ===========================================================================

describe("Task F1.4 — MCP set_firewall", () => {
  it("MCP set_firewall returns the SAME envelope shape as REST (dry_run:true)", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_firewall",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          firewall: FW_BASE,
        },
      });
      const env = structured(res) as { status: string; plan?: unknown };
      expect(env.status).toBe("planned");
      expect(env.plan).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("MCP set_firewall with no v2 capability ⇒ error envelope (parity with REST 403)", async () => {
    const w = makeWorld({});
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_firewall",
        arguments: {
          _credential: TOKEN_NOFW,
          dry_run: false,
          firewall: FW_BASE,
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
// 4. Task F4.1 — dry_run does NOT call provider.observe()
// ===========================================================================

describe("Task F4.1 — set_firewall dry_run does not call provider.observe()", () => {
  it("dry_run:true skips provider.observe() entirely; returns planned with create-from-empty ops", async () => {
    // Sentinel provider — observe() throws unconditionally. plan() handles
    // the create-from-empty path (observed === null) and returns "create" ops.
    let observeCalls = 0;
    const sentinelProvider: FirewallProvider = {
      name: "sentinel-fw",
      async observe(): Promise<ObservedFirewall | null> {
        observeCalls += 1;
        throw new Error("observe must not be called in dry_run");
      },
      async plan(desired, observed) {
        // Mirror createHetznerFirewallProvider's create-from-empty branch.
        if (observed === null) {
          return {
            ops: [{ op: "create", entity: `firewall:${desired.name}` }],
          };
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
    const workingStore = createInMemoryWorkingFirewallStore();
    let idn = 0;
    const gate = createApprovalGate({
      pool,
      clock,
      idFactory: () => `apr_test_${++idn}`,
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const beforeStored = await workingStore.get("web-fw");
    const env = await setFirewall(
      { dry_run: true, firewall: FW_BASE },
      { credential: cred, scope: "firewall" },
      {
        pool,
        provider: sentinelProvider,
        approvalGate: gate,
        workingStore,
        serversProvider: async () => [],
      },
    );
    // (a) envelope is planned.
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    // (b) plan.ops reflects the create-from-empty path.
    expect(env.plan!.ops.length).toBeGreaterThan(0);
    // (c) no working-store write occurred.
    expect(await workingStore.get("web-fw")).toEqual(beforeStored);
    // (d) observe() was NEVER invoked.
    expect(observeCalls).toBe(0);
  });
});
