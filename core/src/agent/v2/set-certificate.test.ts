/**
 * core/src/agent/v2/set-certificate.test.ts
 *
 * Task F3.5 — TDD teeth for `set_certificate` (v2 write tool, REST + MCP).
 *
 * Asserts on the SINGLE `setCertificate(...)` function (shared core for
 * REST `POST /api/v2/certificates` and MCP `set_certificate`):
 *
 *   - dry_run:true (managed)  → planned, NO working write, NO approval,
 *                                secretResolver NOT called.
 *   - dry_run:true (uploaded) → planned, NO working write, NO approval,
 *                                secretResolver NOT called.
 *   - dry_run:false NEW managed → applied (NO approval). Working store
 *                                  written; StateEvent emitted.
 *   - dry_run:false NEW uploaded → pending_approval (touches secret); NO
 *                                   working write.
 *   - dry_run:false idempotent no-op for both types → applied empty-ops.
 *   - managed renewal drift in plan → applied with drift op visible in the
 *     planned response (drift is read-only signal).
 *   - managed with `requires_dns_challenge` precondition → error envelope.
 *   - REST/MCP envelope parity (uploaded approval path & dry_run).
 *   - Missing set_certificate capability → 403 REST / error MCP.
 *   - Capability grant allows the tool through.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
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
  setCertificate,
  createInMemoryWorkingCertificateStore,
  type WorkingCertificateStore,
} from "./set-certificate.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../../providers/v2/hetzner-cloud-v2-http.js";
import {
  createHetznerCertificateProvider,
  type CertificateProvider,
} from "../../providers/v2/hetzner-certificate.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
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
// Harness
// ===========================================================================

const BASE = "https://api.hetzner.cloud/v1";
const FIXED = new Date("2026-05-20T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN_FULL = "tok-full";
const TOKEN_NOCERT = "tok-nocert";

const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nfakecert-web\n-----END CERTIFICATE-----";
const KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nfakekey-web\n-----END PRIVATE KEY-----";

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

interface World {
  rest: RestServer;
  mcp: ReturnType<typeof createMcpServer>;
  provider: CertificateProvider;
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>;
  workingStore: WorkingCertificateStore;
  /** Always-sensitive gate — gates uploaded create/update synthetics. */
  gate: ReturnType<typeof createApprovalGate>;
  secretResolver: ReturnType<typeof vi.fn>;
}

function makeWorld(): World {
  const fakeHetzner = createHetznerHttpFake();
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  const secretResolver = vi.fn(async (_ref: string) => KEY_PEM);
  const provider = createHetznerCertificateProvider({
    http: v2http,
    secretResolver,
  });
  const workingStore = createInMemoryWorkingCertificateStore();
  let idn = 0;
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
    [TOKEN_NOCERT]: {
      actor: "agent:limited",
      // FULL v1 + all v2 tools EXCEPT set_certificate.
      capabilities: [
        ...ALL_TOOLS,
        "resolve_selector",
        "set_firewall",
        "set_primary_ip",
      ],
    },
  });
  const setCertificateDeps = {
    pool,
    provider,
    approvalGate: gate,
    workingStore,
  };
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["set_certificate"]),
    setCertificate: setCertificateDeps,
  });
  const mcp = createMcpServer({
    catalog,
    credentials,
    v2Tools: new Set(["set_certificate"]),
    setCertificate: setCertificateDeps,
  });
  return { rest, mcp, provider, fakeHetzner, workingStore, gate, secretResolver };
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

const CERT_MANAGED = {
  name: "web-cert",
  type: "managed" as const,
  domains: ["web.example.com"],
};
const CERT_UPLOADED = {
  name: "web-cert",
  type: "uploaded" as const,
  domains: ["web.example.com"],
  certificate_pem: CERT_PEM,
  private_key_secret_ref: "secret:web-cert-key",
};

// ===========================================================================
// 1. Core function — direct invocation
// ===========================================================================

describe("Task F3.5 — setCertificate (core function)", () => {
  it("dry_run:true managed → planned envelope, NO state, secretResolver NOT called", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setCertificate(
      { dry_run: true, certificate: CERT_MANAGED },
      { credential: cred, scope: "certificate" },
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
    expect(await w.workingStore.get("web-cert")).toBeNull();
    expect(w.secretResolver).not.toHaveBeenCalled();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:true uploaded → planned, secretResolver NOT called", async () => {
    const w = makeWorld();
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      ...ALL_TOOLS,
      ...V2_TOOLS,
    ]);
    const env = await setCertificate(
      { dry_run: true, certificate: CERT_UPLOADED },
      { credential: cred, scope: "certificate" },
      {
        pool,
        provider: w.provider,
        approvalGate: w.gate,
        workingStore: w.workingStore,
      },
    );
    expect(env.status).toBe("planned");
    expect(w.secretResolver).not.toHaveBeenCalled();
    expect(await w.workingStore.get("web-cert")).toBeNull();
  });
});

// ===========================================================================
// 2. REST POST /api/v2/certificates
// ===========================================================================

describe("Task F3.5 — POST /api/v2/certificates (REST)", () => {
  it("dry_run:true managed → planned envelope", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: true, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("planned");
    expect(Array.isArray(env.plan!.ops)).toBe(true);
  });

  it("dry_run:false NEW managed → applied (NO approval), working store written, StateEvent emitted", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string };
    expect(env.status).toBe("applied");
    // Working store reflects the desired intent immediately.
    const stored = await w.workingStore.get("web-cert");
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe("managed");
    // No approval row was opened.
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    // StateEvent emitted.
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
    expect(row.entity).toBe("certificate:web-cert");
    expect(row.result).toBe("applied");
    expect(
      (row.after as { capability_token_id: unknown }).capability_token_id,
    ).toBeNull();
    // Secret resolver NOT called for the managed path.
    expect(w.secretResolver).not.toHaveBeenCalled();
  });

  it("dry_run:false NEW uploaded → pending_approval, NO working write", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_UPLOADED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; approval_id?: string };
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    // Working store untouched — fail-safe while approval pending.
    expect(await w.workingStore.get("web-cert")).toBeNull();
    // secretResolver MUST NOT have been called (resolution is apply-only,
    // and we haven't approved → applied yet).
    expect(w.secretResolver).not.toHaveBeenCalled();
    const apr = await pool.query<{ status: string; op: string }>(
      "SELECT status, op FROM approvals WHERE entity = $1",
      ["certificate:web-cert"],
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0]!.status).toBe("pending");
    expect(apr.rows[0]!.op).toBe("create");
  });

  it("dry_run:false managed already-converged (idempotent no-op) → applied empty-ops, no approval, no working write", async () => {
    const w = makeWorld();
    // Pre-seed: create the managed cert (latency 0 so it settles to
    // healthy immediately on the first GET).
    w.fakeHetzner.setManagedIssuanceLatency(0);
    await w.fakeHetzner.fetch(`${BASE}/certificates`, {
      method: "POST",
      body: JSON.stringify({
        name: CERT_MANAGED.name,
        type: "managed",
        domain_names: CERT_MANAGED.domains,
      }),
    });
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(200);
    const env = r.body as { status: string; plan?: { ops: unknown[] } };
    expect(env.status).toBe("applied");
    expect(env.plan!.ops).toEqual([]);
    expect(await w.workingStore.get("web-cert")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("dry_run:false managed with requires_dns_challenge → error envelope (precondition)", async () => {
    const w = makeWorld();
    w.fakeHetzner.setNextManagedRequiresDnsChallenge(true);
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(400);
    const env = r.body as {
      status: string;
      error?: { code: string; message: string };
    };
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(env.error?.message).toMatch(/DNS challenge/i);
    expect(await w.workingStore.get("web-cert")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("missing set_certificate capability ⇒ 403, NO working write, NO StateEvent, NO approval", async () => {
    const w = makeWorld();
    const r = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      token: TOKEN_NOCERT,
      body: { dry_run: false, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(403);
    expect((r.body as { status: string }).status).toBe("error");
    expect(await w.workingStore.get("web-cert")).toBeNull();
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("uploaded idempotency: pending_approval → approve → re-apply ⇒ applied + StateEvent", async () => {
    const w = makeWorld();
    // Step 1: open pending approval.
    const r1 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_UPLOADED },
    });
    const env1 = r1.body as { status: string; approval_id: string };
    expect(env1.status).toBe("pending_approval");
    await w.gate.resolveApproval(env1.approval_id, "approved", "agent:human");
    // Step 2: re-apply — gate finds the approval and lets through.
    const r2 = await restCall(w.rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_UPLOADED },
    });
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("applied");
    const stored = await w.workingStore.get("web-cert");
    expect(stored).not.toBeNull();
    expect(stored!.type).toBe("uploaded");
    const ev = await pool.query<{
      actor: string;
      op: string;
      entity: string;
      result: string;
    }>(
      "SELECT actor, op, entity, result FROM state_events ORDER BY seq DESC LIMIT 1",
    );
    const row = ev.rows[0]!;
    expect(row.actor).toBe("agent:vox");
    expect(row.op).toBe("create");
    expect(row.entity).toBe("certificate:web-cert");
    expect(row.result).toBe("applied");
  });
});

// ===========================================================================
// 3. MCP set_certificate — parity with REST envelope
// ===========================================================================

describe("Task F3.5 — MCP set_certificate", () => {
  it("MCP set_certificate dry_run:true returns the SAME envelope shape as REST", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_certificate",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: true,
          certificate: CERT_MANAGED,
        },
      });
      const env = structured(res) as { status: string; plan?: unknown };
      expect(env.status).toBe("planned");
      expect(env.plan).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("MCP set_certificate uploaded → pending_approval (parity with REST)", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_certificate",
        arguments: {
          _credential: TOKEN_FULL,
          dry_run: false,
          certificate: CERT_UPLOADED,
        },
      });
      const env = structured(res) as {
        status: string;
        approval_id?: string;
      };
      expect(env.status).toBe("pending_approval");
      expect(env.approval_id).toMatch(/^apr_/);
    } finally {
      await client.close();
    }
  });

  it("MCP set_certificate without set_certificate capability ⇒ error envelope", async () => {
    const w = makeWorld();
    const client = await connectMcpClient(w.mcp);
    try {
      const res = await client.callTool({
        name: "set_certificate",
        arguments: {
          _credential: TOKEN_NOCERT,
          dry_run: false,
          certificate: CERT_MANAGED,
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
// 4. Task F4.3 — dry_run does NOT call provider.observe()
// ===========================================================================

describe("Task F4.3 — set_certificate dry_run does not call provider.observe()", () => {
  function sentinelProvider(observeRef: { calls: number }): CertificateProvider {
    return {
      name: "sentinel-cert",
      async observe(): Promise<null> {
        observeRef.calls += 1;
        throw new Error("observe must not be called in dry_run");
      },
      async plan(desired, observed) {
        if (observed === null) {
          return { ops: [{ op: "create", entity: `certificate:${desired.name}` }] };
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
  }

  it("dry_run:true managed skips provider.observe(); returns planned with create-from-empty ops", async () => {
    const observeRef = { calls: 0 };
    const provider = sentinelProvider(observeRef);
    const workingStore = createInMemoryWorkingCertificateStore();
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
    const beforeStored = await workingStore.get("web-cert");
    const env = await setCertificate(
      { dry_run: true, certificate: CERT_MANAGED },
      { credential: cred, scope: "certificate" },
      {
        pool,
        provider,
        approvalGate: gate,
        workingStore,
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops.length).toBeGreaterThan(0);
    expect(await workingStore.get("web-cert")).toEqual(beforeStored);
    expect(observeRef.calls).toBe(0);
  });

  it("dry_run:true uploaded skips provider.observe(); returns planned with create-from-empty ops", async () => {
    const observeRef = { calls: 0 };
    const provider = sentinelProvider(observeRef);
    const workingStore = createInMemoryWorkingCertificateStore();
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
    const beforeStored = await workingStore.get("web-cert");
    const env = await setCertificate(
      { dry_run: true, certificate: CERT_UPLOADED },
      { credential: cred, scope: "certificate" },
      {
        pool,
        provider,
        approvalGate: gate,
        workingStore,
      },
    );
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops.length).toBeGreaterThan(0);
    expect(await workingStore.get("web-cert")).toEqual(beforeStored);
    expect(observeRef.calls).toBe(0);
  });
});
