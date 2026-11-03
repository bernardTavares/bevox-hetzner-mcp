/**
 * core/src/agent/v2/expose-service.test.ts
 *
 * Task F6.1 — TDD teeth for `expose_service` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `exposeService(...)` function (shared core for REST
 * `POST /api/v2/expose` and MCP `expose_service`):
 *
 *   - `dry_run:true` ⇒ `{ status:"planned", plan }`, 3-entity ops (sorted),
 *                       NO sub-store write, NO StateEvent, NO approval row.
 *   - `tls:"managed"` non-dry_run, first call ⇒ `pending_approval` with ONE
 *                       approval id; NO sub-store writes; approval row entity
 *                       = "expose:<slug>".
 *   - After approving that approval, a re-call ⇒ `applied` and ALL THREE
 *                       sub-entities present in their working stores (the
 *                       cert/lb/ingress shapes match what the equivalent
 *                       scripted set_certificate + set_load_balancer +
 *                       set_ingress would have written).
 *   - `tls:<cert-ref>` (reuse path) ⇒ plan carries 2 ops (lb + ingress only),
 *                       still ONE bundled approval.
 *   - `dry_run:false` IDEMPOTENT (all sub-entities already match) ⇒ `applied`
 *                       empty-ops, NO approval, NO StateEvent.
 *   - Slug collision (lb of same name with different shape pre-seeded) ⇒
 *                       precondition error envelope; NO writes; NO approval.
 *   - Missing `expose_service` capability ⇒ REST 403 / MCP error envelope;
 *                       NO writes, NO StateEvent, NO approval.
 *   - REST `POST /api/v2/expose` returns the same envelope shape as the core
 *     function.
 *   - MCP `expose_service` returns the SAME envelope shape as REST (parity).
 *   - `dry_run:true` does NOT create an approval (separate explicit assert).
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
  exposeService,
  type ExposeServiceDeps,
} from "./expose-service.js";
import {
  createInMemoryWorkingCertificateStore,
  type WorkingCertificateStore,
} from "./set-certificate.js";
import {
  createInMemoryWorkingLoadBalancerStore,
  type WorkingLoadBalancerStore,
} from "./set-load-balancer.js";
import {
  createInMemoryWorkingIngressStore,
  type WorkingIngressStore,
} from "./set-ingress.js";
import type { LoadBalancer } from "../../domain/entities-v2.js";
import type {
  ObservedSlice,
  PlanAction,
  Provider,
  ApplyResult,
} from "../../providers/provider.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations } from "../../store/db.js";

// ===========================================================================
// In-process HTTP doubles for REST
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

const FIXED = new Date("2026-05-21T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOEXP = "tok-noexp";

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
// World factory
// ---------------------------------------------------------------------------

interface World {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
  certificateStore: WorkingCertificateStore;
  loadBalancerStore: WorkingLoadBalancerStore;
  ingressStore: WorkingIngressStore;
  gate: ReturnType<typeof createApprovalGate>;
  deps: ExposeServiceDeps;
}

function makeWorld(): World {
  const certificateStore = createInMemoryWorkingCertificateStore();
  const loadBalancerStore = createInMemoryWorkingLoadBalancerStore();
  const ingressStore = createInMemoryWorkingIngressStore();
  let idn = 0;
  // Approval-always: the wrapper PlanItem is `op:"create"` (not in the
  // default sensitive set). The tool's docstring requires this.
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
    [TOKEN_NOEXP]: {
      actor: "agent:limited",
      capabilities: [
        ...ALL_TOOLS,
        // Every v2 EXCEPT expose_service.
        "resolve_selector",
        "set_firewall",
        "set_primary_ip",
        "set_certificate",
        "set_load_balancer",
        "set_ingress",
      ],
    },
  });
  const deps: ExposeServiceDeps = {
    pool,
    approvalGate: gate,
    certificateStore,
    loadBalancerStore,
    ingressStore,
  };
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["expose_service"]),
    exposeService: deps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["expose_service"]),
    exposeService: deps,
  });
  return {
    rest,
    mcp,
    certificateStore,
    loadBalancerStore,
    ingressStore,
    gate,
    deps,
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

/**
 * Approve the (single) bundle approval id via the gate's webhook path so the
 * gate's next `evaluate` returns this exact item as `approved`. This mirrors
 * what the REST `POST /api/approvals/:id/approve` endpoint would do.
 */
async function approveById(
  gate: ReturnType<typeof createApprovalGate>,
  id: string,
): Promise<void> {
  await gate.resolveApproval(id, "approved", "agent:human");
}

// ===========================================================================
// 1. Core function — exposeService directly
// ===========================================================================

describe("Task F6.1 — exposeService (core function)", () => {
  it("dry_run:true (managed) returns planned with 3 ops (cert+lb+ingress) sorted by entity", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await exposeService(
      {
        dry_run: true,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    const ops = env.plan!.ops as Array<{ op: string; entity: string }>;
    expect(ops.length).toBe(3);
    // Sorted alphabetically by entity name:
    // certificate:bevox-web-app, ingress:bevox-web-app, load_balancer:bevox-web-app
    expect(ops.map((o) => o.entity)).toEqual([
      "certificate:bevox-web-app",
      "ingress:bevox-web-app",
      "load_balancer:bevox-web-app",
    ]);
    expect(ops.every((o) => o.op === "create")).toBe(true);
    // No sub-store writes, no StateEvent, no approval row.
    expect(await w.certificateStore.get("bevox-web-app")).toBeNull();
    expect(await w.loadBalancerStore.get("bevox-web-app")).toBeNull();
    expect(await w.ingressStore.get("bevox-web-app")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:true with reused cert-ref returns 2 ops (lb + ingress only)", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await exposeService(
      {
        dry_run: true,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "shared-wildcard-cert",
      },
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(env.status).toBe("planned");
    const ops = env.plan!.ops as Array<{ op: string; entity: string }>;
    expect(ops.length).toBe(2);
    expect(ops.map((o) => o.entity)).toEqual([
      "ingress:bevox-web-app",
      "load_balancer:bevox-web-app",
    ]);
  });

  it("non-dry_run (managed) first call ⇒ ONE pending_approval; NO sub-store writes; approval entity = expose:<slug>", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await exposeService(
      {
        dry_run: false,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // Sub-stores untouched — fail-safe.
    expect(await w.certificateStore.get("bevox-web-app")).toBeNull();
    expect(await w.loadBalancerStore.get("bevox-web-app")).toBeNull();
    expect(await w.ingressStore.get("bevox-web-app")).toBeNull();
    // Exactly ONE approval row, on the wrapper entity.
    const apr = await pool.query<{
      id: string;
      op: string;
      entity: string;
      impact: string;
      status: string;
    }>(
      "SELECT id, op, entity, impact, status FROM approvals ORDER BY id",
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.op).toBe("create");
    expect(apr.rows[0]!.entity).toBe("expose:bevox-web-app");
    expect(apr.rows[0]!.status).toBe("pending");
    // Impact text names all three sub-entities so /api/approvals surfaces it.
    expect(apr.rows[0]!.impact).toContain("certificate:bevox-web-app");
    expect(apr.rows[0]!.impact).toContain("ingress:bevox-web-app");
    expect(apr.rows[0]!.impact).toContain("load_balancer:bevox-web-app");
    // Plan ops on the pending_approval envelope still include the 3 entities.
    expect((env.plan!.ops as unknown[]).length).toBe(3);
  });

  it("after approval, re-call ⇒ applied AND ALL THREE sub-entities present", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const input = {
      dry_run: false,
      service: "bevox-web",
      hostname: "app.example.com",
      tls: "managed",
    } as const;
    const first = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(first.status).toBe("pending_approval");
    await approveById(w.gate, first.approval_id!);
    const second = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(second.status).toBe("applied");
    // All three sub-entities now exist.
    const cert = await w.certificateStore.get("bevox-web-app");
    const lb = await w.loadBalancerStore.get("bevox-web-app");
    const ingress = await w.ingressStore.get("bevox-web-app");
    expect(cert).not.toBeNull();
    expect(lb).not.toBeNull();
    expect(ingress).not.toBeNull();
    expect(cert).toEqual({
      name: "bevox-web-app",
      type: "managed",
      domains: ["app.example.com"],
    });
    expect(lb!.name).toBe("bevox-web-app");
    expect(lb!.location).toBe("fsn1");
    expect(lb!.targets).toEqual({ label: "bevox-web" });
    expect(ingress!.hostname).toBe("app.example.com");
    expect(ingress!.load_balancer_ref).toBe("bevox-web-app");
    expect(ingress!.tls).toEqual({ certificate_ref: "bevox-web-app" });
    // Three state_events recorded (one per sub-entity), each tagged with
    // the bundle entity id in `after.bundle`.
    const ev = await pool.query<{
      entity: string;
      after: { bundle?: string };
    }>(
      "SELECT entity, after FROM state_events WHERE result = 'applied' ORDER BY entity",
    );
    expect(ev.rows.map((r) => r.entity)).toEqual([
      "certificate:bevox-web-app",
      "ingress:bevox-web-app",
      "load_balancer:bevox-web-app",
    ]);
    for (const r of ev.rows) {
      expect(r.after.bundle).toBe("expose:bevox-web-app");
    }
  });

  it("tls:<cert-ref> path: only LB + Ingress written after approval; NO cert synthesised", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const input = {
      dry_run: false,
      service: "bevox-web",
      hostname: "app.example.com",
      tls: "wildcard-cert",
    } as const;
    const first = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(first.status).toBe("pending_approval");
    expect((first.plan!.ops as unknown[]).length).toBe(2);
    await approveById(w.gate, first.approval_id!);
    const second = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(second.status).toBe("applied");
    expect(await w.certificateStore.get("bevox-web-app")).toBeNull();
    const lb = await w.loadBalancerStore.get("bevox-web-app");
    const ingress = await w.ingressStore.get("bevox-web-app");
    expect(lb).not.toBeNull();
    expect(ingress).not.toBeNull();
    expect(ingress!.tls).toEqual({ certificate_ref: "wildcard-cert" });
  });

  it("idempotent: same inputs called twice (post-approval) ⇒ second is no-op (applied empty-ops)", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const input = {
      dry_run: false,
      service: "bevox-web",
      hostname: "app.example.com",
      tls: "managed",
    } as const;
    const first = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    await approveById(w.gate, first.approval_id!);
    const second = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(second.status).toBe("applied");
    // THIRD call — everything already present ⇒ idempotent no-op.
    const third = await exposeService(
      input,
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(third.status).toBe("applied");
    expect(third.plan!.ops).toEqual([]);
  });

  it("slug collision: pre-existing lb with different shape ⇒ precondition; no writes", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    // Pre-seed an unrelated LB with the same slug but different shape.
    const conflicting: LoadBalancer = {
      name: "bevox-web-app",
      location: "nbg1", // different location ⇒ shape differs
      algorithm: "least_connections",
      targets: { label: "other" },
      health_check: {
        protocol: "tcp",
        port: 22,
        interval: 30,
        timeout: 5,
        retries: 2,
      },
    };
    await w.loadBalancerStore.put("bevox-web-app", conflicting);
    const env = await exposeService(
      {
        dry_run: false,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
      { credential: cred, scope: "expose" },
      w.deps,
    );
    expect(env.status).toBe("error");
    expect(env.error!.code).toBe("precondition");
    // Pre-existing LB untouched; no other writes.
    expect(await w.certificateStore.get("bevox-web-app")).toBeNull();
    expect(await w.ingressStore.get("bevox-web-app")).toBeNull();
    expect(await w.loadBalancerStore.get("bevox-web-app")).toEqual(
      conflicting,
    );
    // No approval was opened (precondition is detected BEFORE the gate).
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:true does NOT create an approval (even when prior is null)", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    await exposeService(
      {
        dry_run: true,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
      { credential: cred, scope: "expose" },
      w.deps,
    );
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 2. REST POST /api/v2/expose
// ===========================================================================

describe("Task F6.1 — POST /api/v2/expose (REST)", () => {
  it("dry_run:true ⇒ 200 planned envelope with 3 ops (managed)", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/expose",
      body: {
        dry_run: true,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
    });
    expect(r.status).toBe(200);
    const env = r.body as {
      status: string;
      plan?: { ops: unknown[] };
    };
    expect(env.status).toBe("planned");
    expect((env.plan!.ops as unknown[]).length).toBe(3);
  });

  it("non-dry_run first call ⇒ 200 pending_approval with ONE approval id", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/expose",
      body: {
        dry_run: false,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("missing expose_service capability ⇒ 403; NO writes, NO approval", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/expose",
      token: TOKEN_NOEXP,
      body: {
        dry_run: false,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.loadBalancerStore.get("bevox-web-app")).toBeNull();
    expect(await w.ingressStore.get("bevox-web-app")).toBeNull();
    expect(await w.certificateStore.get("bevox-web-app")).toBeNull();
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 3. MCP expose_service — parity with REST envelope
// ===========================================================================

describe("Task F6.1 — MCP expose_service", () => {
  it("MCP dry_run:true returns the SAME envelope shape as REST", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "expose_service",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          service: "bevox-web",
          hostname: "app.example.com",
          tls: "managed",
        },
      });
      const env = structured(res) as {
        status: string;
        plan?: { ops: unknown[] };
      };
      expect(env.status).toBe("planned");
      expect((env.plan!.ops as unknown[]).length).toBe(3);
    } finally {
      await client.close();
    }
  });

  it("MCP without expose_service capability ⇒ error envelope", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "expose_service",
        arguments: {
          _credential: TOKEN_NOEXP,
          dry_run: false,
          service: "bevox-web",
          hostname: "app.example.com",
          tls: "managed",
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
// 4. Task F4.6 — expose_service dry_run does NOT call any observe / store read
// ===========================================================================
//
// FINDING: expose_service does NOT call provider.observe() directly — it
// does not even take a provider in its ExposeServiceDeps. It composes only
// the per-tool primitives (cert + lb + ingress) at the WORKING STORE level,
// reading prior shapes for idempotency / collision detection. With
// `dry_run:true`, the existing code at line 367-373 already returns
// `planned` BEFORE the readPrior() call — so the dry_run path neither
// transitively observes Hetzner (4.3/4.2/4.5 already gated their
// per-tool dry_run observes; expose_service does not invoke them at all)
// nor reads the working stores. This is a sentinel regression guard.

describe("Task F4.6 — expose_service dry_run does not call any observe / store read", () => {
  it("dry_run:true returns planned without reading any working store", async () => {
    let certGet = 0;
    let lbGet = 0;
    let ingGet = 0;
    const certStore = createInMemoryWorkingCertificateStore();
    const lbStore = createInMemoryWorkingLoadBalancerStore();
    const ingStore = createInMemoryWorkingIngressStore();
    // Wrap each store's `get` with a sentinel that throws on access — the
    // dry_run path must NOT touch any of these.
    const wrappedCert: WorkingCertificateStore = {
      ...certStore,
      async get(name: string) {
        certGet += 1;
        throw new Error("certificateStore.get must not be called in dry_run");
      },
    };
    const wrappedLb: WorkingLoadBalancerStore = {
      ...lbStore,
      async get(name: string) {
        lbGet += 1;
        throw new Error("loadBalancerStore.get must not be called in dry_run");
      },
    };
    const wrappedIng: WorkingIngressStore = {
      ...ingStore,
      async get(name: string) {
        ingGet += 1;
        throw new Error("ingressStore.get must not be called in dry_run");
      },
    };
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
    const env = await exposeService(
      {
        dry_run: true,
        service: "bevox-web",
        hostname: "app.example.com",
        tls: "managed",
      },
      { credential: cred, scope: "expose" },
      {
        pool,
        approvalGate: gate,
        certificateStore: wrappedCert,
        loadBalancerStore: wrappedLb,
        ingressStore: wrappedIng,
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops.length).toBe(3);
    // No working-store read whatsoever during dry_run.
    expect(certGet).toBe(0);
    expect(lbGet).toBe(0);
    expect(ingGet).toBe(0);
    // No approval row was created either.
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});
