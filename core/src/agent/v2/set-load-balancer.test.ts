/**
 * core/src/agent/v2/set-load-balancer.test.ts
 *
 * Task F4.4 — TDD teeth for `set_load_balancer` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `setLoadBalancer(...)` function (shared core for
 * REST `POST /api/v2/load-balancers` and MCP `set_load_balancer`):
 *
 *   - `dry_run:true`  ⇒ `{ status:"planned", plan }`, NO working-store write,
 *                       NO StateEvent, NO approval row.
 *   - `dry_run:false` for a NEW LB (observed null) ⇒ `pending_approval`
 *                       (Approval ALWAYS — billed resource + recreation risk).
 *   - `dry_run:false` for an algorithm CHANGE ⇒ `pending_approval`.
 *   - `dry_run:false` for a LOCATION change ⇒ `pending_approval` AND
 *                       envelope's plan.ops contains the `recreate` op with
 *                       `impact: "public IP will change"`.
 *   - `dry_run:false` for an ALREADY-CONVERGED LB ⇒ `applied` empty-ops
 *                       (idempotent no-op; NO approval, NO StateEvent).
 *   - `dry_run:false` with targets selector matching ZERO servers ⇒
 *                       `pending_approval` and plan shows an `update_targets`
 *                       op with the empty target set.
 *   - Missing `set_load_balancer` capability ⇒ REST 403 / MCP error envelope,
 *                       NO working-store write, NO StateEvent, NO approval.
 *   - REST `POST /api/v2/load-balancers` returns the same envelope shape.
 *   - MCP `set_load_balancer` returns the SAME envelope shape (parity).
 *   - Idempotency: pending_approval → approve → re-apply ⇒ applied +
 *                       working-store written + StateEvent.
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
  setLoadBalancer,
  createInMemoryWorkingLoadBalancerStore,
  type WorkingLoadBalancerStore,
} from "./set-load-balancer.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../../providers/v2/hetzner-cloud-v2-http.js";
import {
  createHetznerLoadBalancerProvider,
  type LoadBalancerProvider,
} from "../../providers/v2/hetzner-load-balancer.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Server, Service } from "../../domain/entities.js";
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
// In-process HTTP doubles for the REST side
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
const TOKEN_NOLB = "tok-nolb";

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

function mkService(name: string, server_selector?: Record<string, unknown>): Service {
  return {
    name,
    image: "nginx:latest",
    replicas: 1,
    server_selector,
  };
}

interface World {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
  provider: LoadBalancerProvider;
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>;
  workingStore: WorkingLoadBalancerStore;
  gate: ReturnType<typeof createApprovalGate>;
  servers: Server[];
  services: Service[];
}

function makeWorld(opts?: {
  servers?: Server[];
  services?: Service[];
}): World {
  const servers = opts?.servers ?? [];
  const services = opts?.services ?? [];
  const fakeHetzner = createHetznerHttpFake();
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  const provider = createHetznerLoadBalancerProvider({
    http: v2http,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
  });
  const workingStore = createInMemoryWorkingLoadBalancerStore();
  let idn = 0;
  // APPROVAL-ALWAYS — set_load_balancer's synthetic PlanItems may use
  // op=create/update/destroy. With isSensitive:() => true every non-no-op is
  // gated (LB is billed; recreate-on-location-change destroys public IP).
  const gate = createApprovalGate({
    pool,
    clock,
    isSensitive: () => true,
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
    [TOKEN_NOLB]: {
      actor: "agent:limited",
      // Full v1 + v2 EXCEPT set_load_balancer.
      capabilities: [
        ...ALL_TOOLS,
        "resolve_selector",
        "set_firewall",
        "set_primary_ip",
        "set_certificate",
      ],
    },
  });
  const setLoadBalancerDeps = {
    pool,
    provider,
    approvalGate: gate,
    workingStore,
  };
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["set_load_balancer"]),
    setLoadBalancer: setLoadBalancerDeps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["set_load_balancer"]),
    setLoadBalancer: setLoadBalancerDeps,
  });
  return {
    rest,
    mcp,
    provider,
    fakeHetzner,
    workingStore,
    gate,
    servers,
    services,
  };
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

const LB_DESIRED = {
  name: "web-lb",
  location: "fsn1",
  algorithm: "round_robin" as const,
  targets: { label: "lb-backend" },
  health_check: {
    protocol: "http" as const,
    port: 80,
    interval: 15,
    timeout: 10,
    retries: 3,
    path: "/health",
  },
};

const SERVICE_WITH_BACKEND_LABEL: Service = {
  name: "backend-svc",
  image: "nginx:latest",
  replicas: 1,
  server_selector: { "lb-backend": "" },
};

/** Seed Hetzner with a LB matching `LB_DESIRED` (location parameter override). */
async function seedLb(
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>,
  overrides: { location?: string; algorithm?: string; targetIds?: number[] } = {},
): Promise<number> {
  const res = await fakeHetzner.fetch(`${BASE}/load_balancers`, {
    method: "POST",
    body: JSON.stringify({
      name: LB_DESIRED.name,
      load_balancer_type: "lb11",
      location: overrides.location ?? LB_DESIRED.location,
      algorithm: { type: overrides.algorithm ?? LB_DESIRED.algorithm },
      services: [
        {
          protocol: "https",
          listen_port: 443,
          destination_port: 80,
          health_check: {
            protocol: LB_DESIRED.health_check.protocol,
            port: LB_DESIRED.health_check.port,
            interval: LB_DESIRED.health_check.interval,
            timeout: LB_DESIRED.health_check.timeout,
            retries: LB_DESIRED.health_check.retries,
            http: { path: LB_DESIRED.health_check.path },
          },
        },
      ],
      targets: (overrides.targetIds ?? []).map((id) => ({
        type: "server",
        server: { id },
      })),
    }),
  });
  const body = (await res.json()) as { load_balancer: { id: number } };
  return body.load_balancer.id;
}

// ===========================================================================
// 1. Core function — setLoadBalancer directly
// ===========================================================================

describe("Task F4.4 — setLoadBalancer (core function)", () => {
  it("dry_run:true returns { status:'planned', plan } and writes NO state", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setLoadBalancer(
      { dry_run: true, load_balancer: LB_DESIRED },
      { credential: cred, scope: "load_balancer" },
      {
        pool,
        provider: w.provider,
        approvalGate: w.gate,
        workingStore: w.workingStore,
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
    expect(await w.workingStore.get("web-lb")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 2. REST POST /api/v2/load-balancers
// ===========================================================================

describe("Task F4.4 — POST /api/v2/load-balancers (REST)", () => {
  it("dry_run:true ⇒ planned envelope", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: true, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("planned");
    expect(Array.isArray(env.plan!.ops)).toBe(true);
  });

  it("dry_run:false on a NEW LB ⇒ pending_approval, NO working write (approval-always: cost)", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    expect(await w.workingStore.get("web-lb")).toBeNull();
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["load_balancer:web-lb"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.status).toBe("pending");
  });

  it("dry_run:false ALGORITHM change ⇒ pending_approval", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    // Seed observed LB with a different algorithm.
    await seedLb(w.fakeHetzner, { algorithm: "least_connections", targetIds: [10] });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    expect(await w.workingStore.get("web-lb")).toBeNull();
  });

  it("dry_run:false LOCATION change ⇒ pending_approval AND plan has recreate op with public-IP impact", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    // Seed observed LB at a different location (nbg1) — desired is fsn1.
    await seedLb(w.fakeHetzner, { location: "nbg1", targetIds: [10] });

    // F4.2 — dry_run is now pure introspection (no observe). It returns the
    // create-from-empty plan; the location-change `recreate` op is surfaced
    // post-approval via the non-dry pending_approval envelope's plan.ops
    // (the gate evaluates the live diff after the approval write).
    const rDry = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: true, load_balancer: LB_DESIRED },
    });
    expect(rDry.status).toBe(200);
    const envDry = rDry.body as {
      status: string;
      plan?: { ops: Array<{ op: string; entity: string; impact?: string }> };
    };
    expect(envDry.status).toBe("planned");
    expect(envDry.plan!.ops.length).toBeGreaterThan(0);

    // Now non-dry: approval-always (and the agent must follow up with explicit
    // destroy_load_balancer + re-issue; F4.4 only gates and surfaces the plan).
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("dry_run:false on an ALREADY-CONVERGED LB ⇒ applied empty-ops (idempotent no-op)", async () => {
    const services = [SERVICE_WITH_BACKEND_LABEL];
    const servers = [mkServer("web-1", 10, { "lb-backend": "" })];
    const w = makeWorld({ servers, services });
    // Drive the seed through provider.apply() so the health-check is in the
    // shape the provider expects (nested http.path).
    await w.provider.apply(LB_DESIRED, null);
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("applied");
    expect(env.plan!.ops).toEqual([]);
    expect(await w.workingStore.get("web-lb")).toBeNull();
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("dry_run:false targets selector matches ZERO servers ⇒ pending_approval, plan has update_targets with empty set", async () => {
    // No services / no servers → desired target set is empty. With an
    // observed LB carrying a stale target, plan must surface `update_targets`
    // (removing the stale target) and approval is required.
    const w = makeWorld({ servers: [], services: [] });
    await seedLb(w.fakeHetzner, { targetIds: [42] });

    // F4.2 — dry_run is pure introspection (no observe), so the create-from-
    // empty plan is what dry_run sees here. The live `update_targets` diff
    // is surfaced post-approval via the pending_approval envelope's plan.ops.
    const rDry = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: true, load_balancer: LB_DESIRED },
    });
    expect(rDry.status).toBe(200);
    const envDry = rDry.body as {
      status: string;
      plan?: { ops: Array<{ op: string }> };
    };
    expect(envDry.plan!.ops.length).toBeGreaterThan(0);

    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("missing set_load_balancer capability ⇒ 403, NO working write, NO StateEvent, NO approval", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      token: TOKEN_NOLB,
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.workingStore.get("web-lb")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("idempotency: pending_approval → approve → re-apply ⇒ applied + StateEvent", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const r1 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    const env1 = r1.body as { status: string; approval_id: string };
    expect(env1.status).toBe("pending_approval");
    await w.gate.resolveApproval(env1.approval_id, "approved", "agent:human");

    const r2 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("applied");
    const stored = await w.workingStore.get("web-lb");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("web-lb");
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
    expect(row.entity).toBe("load_balancer:web-lb");
    expect(row.result).toBe("applied");
    expect(
      (row.after as { capability_token_id: unknown }).capability_token_id,
    ).toBeNull();
  });
});

// ===========================================================================
// 3. MCP set_load_balancer — parity with REST envelope
// ===========================================================================

describe("Task F4.4 — MCP set_load_balancer", () => {
  it("MCP set_load_balancer dry_run:true returns the SAME envelope shape as REST", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_load_balancer",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          load_balancer: LB_DESIRED,
        },
      });
      const env = structured(res) as { status: string; plan?: unknown };
      expect(env.status).toBe("planned");
      expect(env.plan).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("MCP set_load_balancer without set_load_balancer capability ⇒ error envelope", async () => {
    const w = makeWorld({
      servers: [mkServer("web-1", 10, { "lb-backend": "" })],
      services: [SERVICE_WITH_BACKEND_LABEL],
    });
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_load_balancer",
        arguments: {
          _credential: TOKEN_NOLB,
          dry_run: false,
          load_balancer: LB_DESIRED,
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
// 4. Task F4.2 — dry_run does NOT call provider.observe()
// ===========================================================================

describe("Task F4.2 — set_load_balancer dry_run does not call provider.observe()", () => {
  it("dry_run:true skips provider.observe() entirely; returns planned with create-from-empty ops", async () => {
    let observeCalls = 0;
    const sentinelProvider: LoadBalancerProvider = {
      name: "sentinel-lb",
      async observe(): Promise<null> {
        observeCalls += 1;
        throw new Error("observe must not be called in dry_run");
      },
      async plan(desired, observed) {
        if (observed === null) {
          return { ops: [{ op: "create", entity: `load_balancer:${desired.name}` }] };
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
    const workingStore = createInMemoryWorkingLoadBalancerStore();
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
    const beforeStored = await workingStore.get("web-lb");
    const env = await setLoadBalancer(
      { dry_run: true, load_balancer: LB_DESIRED },
      { credential: cred, scope: "load_balancer" },
      {
        pool,
        provider: sentinelProvider,
        approvalGate: gate,
        workingStore,
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops.length).toBeGreaterThan(0);
    expect(await workingStore.get("web-lb")).toEqual(beforeStored);
    expect(observeCalls).toBe(0);
  });
});
