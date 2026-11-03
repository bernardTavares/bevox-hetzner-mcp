/**
 * core/src/agent/v2/set-ingress.test.ts
 *
 * Task F5.3 — TDD teeth for `set_ingress` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `setIngress(...)` function (shared core for REST
 * `POST /api/v2/ingresses` and MCP `set_ingress`):
 *
 *   - `dry_run:true` ⇒ `{ status:"planned", plan }`, NO working-store write,
 *                       NO StateEvent, NO approval row.
 *   - `dry_run:false` for a NEW Ingress (prior null) ⇒ `applied` (no approval).
 *   - `dry_run:false` for a HOSTNAME change ⇒ `pending_approval`.
 *   - `dry_run:false` for a load_balancer_ref CHANGE ⇒ `pending_approval`.
 *   - `dry_run:false` for a routes-only change ⇒ `applied` (no approval).
 *   - `dry_run:false` for a firewall_ref add ⇒ `applied` (no approval).
 *   - `dry_run:false` no-op (already-stored same desired) ⇒ `applied` empty-ops.
 *   - Missing `set_ingress` capability ⇒ REST 403 / MCP error envelope,
 *                       NO working-store write, NO StateEvent, NO approval.
 *   - REST `POST /api/v2/ingresses` returns the same envelope shape.
 *   - MCP `set_ingress` returns the SAME envelope shape (parity).
 *   - Idempotency: same desired applied twice ⇒ second is no-op.
 *   - Lookup failure (cert ref dangling) ⇒ precondition error envelope.
 *   - Plan ops propagate to envelope: dry_run shows composite ops.
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
  setIngress,
  createInMemoryWorkingIngressStore,
  type WorkingIngressStore,
} from "./set-ingress.js";
import type {
  Certificate,
  Firewall,
  Ingress,
  LoadBalancer,
} from "../../domain/entities-v2.js";
import { createIngressProvider } from "../../providers/v2/ingress.js";
import type {
  ApplyResult as IngressApply,
  IngressProvider,
  IngressPlan,
  ObservedIngress,
} from "../../providers/v2/ingress.js";
import type {
  CertificateProvider,
  ObservedCertificate,
} from "../../providers/v2/hetzner-certificate.js";
import type {
  FirewallProvider,
  ObservedFirewall,
} from "../../providers/v2/hetzner-firewall.js";
import type {
  LoadBalancerProvider,
  ObservedLoadBalancer,
  HetznerLoadBalancerShape,
} from "../../providers/v2/hetzner-load-balancer.js";
import type {
  ApplyResult as DnsApplyResult,
  ObservedSlice,
  PlanAction,
  Provider as DnsProvider,
} from "../../providers/provider.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Server } from "../../domain/entities.js";
import type { Provider, ApplyResult } from "../../providers/provider.js";
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

const FIXED = new Date("2026-05-20T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOING = "tok-noing";

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

// ---------------------------------------------------------------------------
// Mock sub-providers (matching ingress.test.ts patterns; minimal)
// ---------------------------------------------------------------------------

function mockCert(opts?: {
  observed?: ObservedCertificate | null;
  planOps?: Array<{ op: string; entity?: string }>;
}): CertificateProvider {
  return {
    name: "mock-cert",
    async observe(_n) {
      return opts?.observed ?? null;
    },
    async plan(d) {
      return {
        ops: (opts?.planOps ?? []).map((o) => ({
          op: o.op as "create",
          entity: o.entity ?? `certificate:${d.name}`,
        })),
      };
    },
    async apply(d) {
      return {
        entity: `certificate:${d.name}`,
        changed: true,
        action_status: "completed",
      };
    },
    async verify() {
      return true;
    },
  };
}

function lbObsFor(name: string, ip = "1.2.3.4"): ObservedLoadBalancer {
  const h: HetznerLoadBalancerShape = {
    id: 1,
    name,
    load_balancer_type: { name: "lb11" },
    location: { name: "fsn1" },
    algorithm: { type: "round_robin" },
    services: [],
    targets: [],
    labels: {},
    public_net: {
      enabled: true,
      ipv4: { ip },
      ipv6: { ip: "2001:db8::1" },
    },
    created: "2026-01-01T00:00:00Z",
  };
  return { hetzner: h };
}

function mockLb(opts?: {
  observed?: ObservedLoadBalancer | null;
  planOps?: Array<{ op: string; entity?: string; impact?: string }>;
}): LoadBalancerProvider {
  return {
    name: "mock-lb",
    async observe(_n) {
      return opts?.observed ?? null;
    },
    async plan(d) {
      return {
        ops: (opts?.planOps ?? []).map((o) => ({
          op: o.op as "create",
          entity: o.entity ?? `load_balancer:${d.name}`,
          ...(o.impact ? { impact: o.impact } : {}),
        })) as unknown as Array<{ op: "create"; entity: string }>,
      } as unknown as ReturnType<LoadBalancerProvider["plan"]> extends Promise<infer R>
        ? R
        : never;
    },
    async apply(d) {
      return { entity: `load_balancer:${d.name}`, changed: true };
    },
    async verify() {
      return true;
    },
  };
}

function mockFw(opts?: {
  observed?: ObservedFirewall | null;
  planOps?: Array<{ op: string; entity?: string }>;
}): FirewallProvider {
  return {
    name: "mock-fw",
    async observe(_n) {
      return opts?.observed ?? null;
    },
    async plan(d) {
      return {
        ops: (opts?.planOps ?? []).map((o) => ({
          op: o.op as "create",
          entity: o.entity ?? `firewall:${d.name}`,
        })) as unknown as Array<{ op: "create"; entity: string }>,
      };
    },
    async apply(d) {
      return { entity: `firewall:${d.name}`, changed: true };
    },
    async verify() {
      return true;
    },
  };
}

function mockDns(): DnsProvider {
  return {
    name: "mock-dns",
    async observe(scope): Promise<ObservedSlice> {
      return { scope, entities: [] };
    },
    async apply(action: PlanAction): Promise<DnsApplyResult> {
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify() {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CERT_FIXTURE: Certificate = {
  name: "web-cert",
  type: "managed",
  domains: ["web.example.com"],
};

const LB_FIXTURE: LoadBalancer = {
  name: "web-lb",
  location: "fsn1",
  algorithm: "round_robin",
  targets: { label: "lb-backend" },
  health_check: {
    protocol: "http",
    port: 80,
    interval: 15,
    timeout: 10,
    retries: 3,
    path: "/health",
  },
};

const LB_FIXTURE_ALT: LoadBalancer = { ...LB_FIXTURE, name: "web-lb-2" };

const FW_FIXTURE: Firewall = {
  name: "web-fw",
  rules: [
    {
      direction: "in",
      protocol: "tcp",
      port: "80",
      source_ips: ["0.0.0.0/0"],
    },
  ],
  applied_to: { label: "lb-backend" },
};

const ING: Ingress = {
  name: "web",
  hostname: "web.example.com",
  tls: { certificate_ref: "web-cert" },
  routes: [
    {
      path: "/",
      backend: {
        service_selector: { label: "web" },
        port: 80,
      },
    },
  ],
  load_balancer_ref: "web-lb",
};

const SERVERS: Server[] = [];

// ---------------------------------------------------------------------------
// World factory
// ---------------------------------------------------------------------------

interface World {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
  provider: IngressProvider;
  workingStore: WorkingIngressStore;
  gate: ReturnType<typeof createApprovalGate>;
}

function makeWorld(opts?: {
  // Controls IngressProvider behaviour via mock sub-providers + lookups.
  certLookupReturns?: Certificate | null;
  lbLookupReturns?: LoadBalancer | null;
  lbObserved?: ObservedLoadBalancer | null;
  lbPlanOps?: Array<{ op: string; entity?: string; impact?: string }>;
}): World {
  const cert = mockCert();
  const lb = mockLb({
    observed: opts?.lbObserved ?? null,
    planOps: opts?.lbPlanOps,
  });
  const fw = mockFw();
  const dns = mockDns();
  const provider = createIngressProvider({
    certificateProvider: cert,
    loadBalancerProvider: lb,
    firewallProvider: fw,
    dnsProvider: dns,
    serversProvider: async () => SERVERS,
    servicesProvider: async () => [],
    certificateLookup: async () =>
      opts?.certLookupReturns === undefined
        ? CERT_FIXTURE
        : opts.certLookupReturns,
    firewallLookup: async () => FW_FIXTURE,
    loadBalancerLookup: async () =>
      opts?.lbLookupReturns === undefined
        ? LB_FIXTURE
        : opts.lbLookupReturns,
  });
  const workingStore = createInMemoryWorkingIngressStore();
  let idn = 0;
  // Default isSensitive (op-based) — `destroy` is sensitive by default;
  // F5.3 only synthesises `destroy` items on DNS-touch destructive changes,
  // so the default gate is correct here.
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
    [TOKEN_NOING]: {
      actor: "agent:limited",
      // Full v1 + v2 EXCEPT set_ingress.
      capabilities: [
        ...ALL_TOOLS,
        "resolve_selector",
        "set_firewall",
        "set_primary_ip",
        "set_certificate",
        "set_load_balancer",
      ],
    },
  });
  const setIngressDeps = {
    pool,
    provider,
    approvalGate: gate,
    workingStore,
  };
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["set_ingress"]),
    setIngress: setIngressDeps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["set_ingress"]),
    setIngress: setIngressDeps,
  });
  return { rest, mcp, provider, workingStore, gate };
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
// 1. Core function — setIngress directly
// ===========================================================================

describe("Task F5.3 — setIngress (core function)", () => {
  it("dry_run:true returns { status:'planned', plan } and writes NO state", async () => {
    const w = makeWorld({
      lbPlanOps: [{ op: "create", entity: "load_balancer:web-lb" }],
    });
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setIngress(
      { dry_run: true, ingress: ING },
      { credential: cred, scope: "ingress" },
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
    // The composite plan should at minimum carry a DNS upsert op (no
    // observed LB ⇒ DNS is fresh) and the LB create.
    const ops = env.plan!.ops as Array<{ op: string; kind?: string }>;
    expect(ops.some((o) => o.kind === "load_balancer")).toBe(true);
    expect(ops.some((o) => o.kind === "dns")).toBe(true);
    expect(await w.workingStore.get("web")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 2. REST POST /api/v2/ingresses
// ===========================================================================

describe("Task F5.3 — POST /api/v2/ingresses (REST)", () => {
  it("dry_run:true ⇒ planned envelope with composite plan ops", async () => {
    const w = makeWorld({
      lbPlanOps: [{ op: "create", entity: "load_balancer:web-lb" }],
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: true, ingress: ING },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("planned");
    expect(Array.isArray(env.plan!.ops)).toBe(true);
  });

  it("dry_run:false NEW ingress (no prior) ⇒ applied (no Approval, consistent with set_dns)", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string };
    expect(env.status).toBe("applied");
    const stored = await w.workingStore.get("web");
    expect(stored).not.toBeNull();
    expect(stored!.hostname).toBe("web.example.com");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
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
    expect(row.entity).toBe("ingress:web");
    expect(row.result).toBe("applied");
    expect(
      (row.after as { capability_token_id: unknown }).capability_token_id,
    ).toBeNull();
  });

  it("dry_run:false HOSTNAME change ⇒ pending_approval, NO working write", async () => {
    const w = makeWorld();
    // Seed prior working desired with a different hostname.
    await w.workingStore.put("web", {
      ...ING,
      hostname: "old.example.com",
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // Working store still has the OLD hostname — fail-safe.
    const stored = await w.workingStore.get("web");
    expect(stored!.hostname).toBe("old.example.com");
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["ingress:web"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.status).toBe("pending");
    expect(apr.rows[0]!.op).toBe("destroy");
  });

  it("dry_run:false load_balancer_ref CHANGE ⇒ pending_approval", async () => {
    const w = makeWorld({ lbLookupReturns: LB_FIXTURE_ALT });
    await w.workingStore.put("web", { ...ING, load_balancer_ref: "web-lb" });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: {
        dry_run: false,
        ingress: { ...ING, load_balancer_ref: "web-lb-2" },
      },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("dry_run:false ROUTES-only change ⇒ applied (no Approval; in-place LB update)", async () => {
    const w = makeWorld();
    await w.workingStore.put("web", ING);
    const updated: Ingress = {
      ...ING,
      routes: [
        ...ING.routes,
        {
          path: "/api",
          backend: { service_selector: { label: "api" }, port: 8080 },
        },
      ],
    };
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: updated },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string };
    expect(env.status).toBe("applied");
    const stored = await w.workingStore.get("web");
    expect(stored!.routes.length).toBe(2);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:false firewall_ref ADD only ⇒ applied (no Approval)", async () => {
    const w = makeWorld();
    await w.workingStore.put("web", ING);
    const updated: Ingress = { ...ING, firewall_ref: "web-fw" };
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: updated },
    });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:false IDEMPOTENT no-op ⇒ applied empty-ops, NO StateEvent", async () => {
    // Provider's mock plan: no ops; LB observed already exists so DNS won't
    // be triggered either.
    const w = makeWorld({
      lbObserved: lbObsFor("web-lb"),
    });
    await w.workingStore.put("web", ING);
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("applied");
    expect(env.plan!.ops).toEqual([]);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("missing set_ingress capability ⇒ 403, NO working write, NO StateEvent, NO approval", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      token: TOKEN_NOING,
      body: { dry_run: false, ingress: ING },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.workingStore.get("web")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("lookup failure (cert ref dangling) ⇒ precondition error envelope", async () => {
    const w = makeWorld({ certLookupReturns: null });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    expect(r.status).toBe(400);
    const env = r.body as { status: string; error?: { code: string } };
    expect(env.status).toBe("error");
    expect(env.error!.code).toBe("precondition");
    expect(await w.workingStore.get("web")).toBeNull();
  });

  it("idempotency: same desired applied twice ⇒ second is no-op", async () => {
    const w = makeWorld({ lbObserved: lbObsFor("web-lb") });
    // First apply: fresh create (no prior).
    const r1 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    expect((r1.body as { status: string }).status).toBe("applied");
    // Second apply: prior matches desired AND provider plan empty (LB
    // observed already) ⇒ idempotent no-op.
    const r2 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING },
    });
    const env2 = r2.body as { status: string; plan?: { ops: unknown[] } };
    expect(env2.status).toBe("applied");
    expect(env2.plan!.ops).toEqual([]);
  });
});

// ===========================================================================
// 3. MCP set_ingress — parity with REST envelope
// ===========================================================================

describe("Task F5.3 — MCP set_ingress", () => {
  it("MCP set_ingress dry_run:true returns the SAME envelope shape as REST", async () => {
    const w = makeWorld({
      lbPlanOps: [{ op: "create", entity: "load_balancer:web-lb" }],
    });
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_ingress",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          ingress: ING,
        },
      });
      const env = structured(res) as { status: string; plan?: unknown };
      expect(env.status).toBe("planned");
      expect(env.plan).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("MCP set_ingress without set_ingress capability ⇒ error envelope", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_ingress",
        arguments: {
          _credential: TOKEN_NOING,
          dry_run: false,
          ingress: ING,
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

// Silence unused-import lints for types referenced via casts.
void (null as unknown as IngressPlan);
void (null as unknown as IngressApply);
void (null as unknown as ObservedIngress);

// ===========================================================================
// 4. Task F4.5 — dry_run does NOT call provider.observe()
// ===========================================================================

describe("Task F4.5 — set_ingress dry_run does not call provider.observe()", () => {
  it("dry_run:true skips provider.observe() entirely; returns planned with create-from-empty ops", async () => {
    let observeCalls = 0;
    const sentinelProvider: IngressProvider = {
      name: "sentinel-ingress",
      async observe(): Promise<null> {
        observeCalls += 1;
        throw new Error("observe must not be called in dry_run");
      },
      async plan(desired, observed) {
        // Mirror the composite plan's create-from-empty shape: a single
        // `create` op per sub-component. The exact ops aren't asserted —
        // only that the plan is non-empty.
        if (observed === null) {
          return {
            ops: [
              { kind: "certificate", op: "create", entity: `certificate:${desired.tls.certificate_ref}` },
              { kind: "load_balancer", op: "create", entity: `load_balancer:${desired.load_balancer_ref}` },
            ],
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
    const workingStore = createInMemoryWorkingIngressStore();
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
    const beforeStored = await workingStore.get("web");
    const env = await setIngress(
      { dry_run: true, ingress: ING },
      { credential: cred, scope: "ingress" },
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
    expect(await workingStore.get("web")).toEqual(beforeStored);
    expect(observeCalls).toBe(0);
  });
});
