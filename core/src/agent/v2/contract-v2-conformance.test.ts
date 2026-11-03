/**
 * core/src/agent/v2/contract-v2-conformance.test.ts
 *
 * Task 0.3 — v2 envelope conformance.
 *
 * The v2 WriteEnvelope extends v1 with two NEUTRAL fields that every
 * `POST /api/v2/*` MUST carry on its `plan` payload, regardless of which
 * Bloco emits them:
 *   - `cost_estimate`        — Bloco D activates non-zero deltas.
 *   - `policy_violations`    — Bloco C activates non-empty violations.
 *
 * Bloco A always emits the neutral values
 * (`{ monthly_delta_eur: 0, breakdown: [] }` and `[]` respectively); the
 * schema enforces *presence*, not non-emptiness, so the contract is the same
 * shape forever and downstream consumers never branch on Bloco.
 *
 * The schema is the cross-package oracle: live import from console, parsed
 * here so any future drift surfaces in the core test suite first.
 */

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { z } from "zod";

import {
  CertificateSchema,
  FirewallSchema,
  IngressSchema,
  LoadBalancerSchema,
  PrimaryIPSchema,
  WriteEnvelopeV2Schema,
} from "../../../../console/src/api/contract-v2.js";
import { buildV2WriteEnvelope } from "./envelope-v2.js";

import {
  ALL_TOOLS,
  V2_TOOLS,
} from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
import {
  createInMemoryWorkingFirewallStore,
} from "./set-firewall.js";
import {
  createInMemoryWorkingPrimaryIpStore,
} from "./set-primary-ip.js";
import {
  createInMemoryWorkingCertificateStore,
} from "./set-certificate.js";
import {
  createInMemoryWorkingLoadBalancerStore,
} from "./set-load-balancer.js";
import {
  createInMemoryWorkingIngressStore,
} from "./set-ingress.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerFirewallProvider } from "../../providers/v2/hetzner-firewall.js";
import { createHetznerPrimaryIPProvider } from "../../providers/v2/hetzner-primary-ip.js";
import { createHetznerCertificateProvider } from "../../providers/v2/hetzner-certificate.js";
import { createHetznerLoadBalancerProvider } from "../../providers/v2/hetzner-load-balancer.js";
import { createIngressProvider } from "../../providers/v2/ingress.js";
import type {
  Certificate as CertV2,
  Firewall as FirewallV2,
  Ingress,
  LoadBalancer as LoadBalancerV2,
} from "../../domain/entities-v2.js";
import type {
  ApplyResult as DnsApplyResult,
  PlanAction as DnsPlanAction,
  Provider as DnsProvider,
  ObservedSlice as DnsObservedSlice,
} from "../../providers/provider.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Server, Service } from "../../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../../providers/provider.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations } from "../../store/db.js";

describe("Task 0.3 — v2 WriteEnvelope conformance", () => {
  it("v2 WriteEnvelope always carries neutral cost_estimate and policy_violations", () => {
    const env = {
      status: "planned",
      plan: {
        ops: [],
        cost_estimate: { monthly_delta_eur: 0, breakdown: [] },
        policy_violations: [],
      },
    };
    expect(() => WriteEnvelopeV2Schema.parse(env)).not.toThrow();
    expect(() =>
      WriteEnvelopeV2Schema.parse({ status: "planned", plan: { ops: [] } }),
    ).toThrow();
  });

  it("WriteEnvelopeV2Schema accepts every status without a plan", () => {
    for (const status of ["planned", "pending_approval", "applied", "error"] as const) {
      expect(() => WriteEnvelopeV2Schema.parse({ status })).not.toThrow();
    }
  });

  it("WriteEnvelopeV2Schema rejects an unknown status literal", () => {
    expect(() => WriteEnvelopeV2Schema.parse({ status: "bogus" })).toThrow();
  });

  it("rejects non-object items in plan.ops", () => {
    const env = {
      status: "planned",
      plan: { ops: [null], cost_estimate: { monthly_delta_eur: 0, breakdown: [] }, policy_violations: [] },
    };
    expect(() => WriteEnvelopeV2Schema.parse(env)).toThrow();
  });
});

describe("Task 0.3 — buildV2WriteEnvelope (core v2 builder)", () => {
  it("wraps a plan with neutral cost_estimate and policy_violations defaults", () => {
    const env = buildV2WriteEnvelope({ status: "planned", plan: { ops: [] } });
    const parsed = WriteEnvelopeV2Schema.parse(env);
    expect(parsed.status).toBe("planned");
    expect(parsed.plan).toEqual({
      ops: [],
      cost_estimate: { monthly_delta_eur: 0, breakdown: [] },
      policy_violations: [],
    });
  });

  it("preserves caller-supplied cost_estimate and policy_violations", () => {
    const env = buildV2WriteEnvelope({
      status: "planned",
      plan: {
        ops: [],
        cost_estimate: { monthly_delta_eur: 4.2, breakdown: [{ kind: "primary_ip", eur: 4.2 }] },
        policy_violations: [{ code: "forbidden-region", entity: "server:x" }],
      },
    });
    const parsed = WriteEnvelopeV2Schema.parse(env);
    expect(parsed.plan!.cost_estimate.monthly_delta_eur).toBe(4.2);
    expect(parsed.plan!.cost_estimate.breakdown.length).toBe(1);
    expect(parsed.plan!.policy_violations.length).toBe(1);
  });

  it("passes status / approval_id / error through unchanged (no plan attached)", () => {
    const pa = buildV2WriteEnvelope({ status: "pending_approval", approval_id: "apr_test_1" });
    expect(WriteEnvelopeV2Schema.parse(pa)).toEqual({
      status: "pending_approval",
      approval_id: "apr_test_1",
    });

    const ap = buildV2WriteEnvelope({ status: "applied" });
    expect(WriteEnvelopeV2Schema.parse(ap)).toEqual({ status: "applied" });

    const er = buildV2WriteEnvelope({
      status: "error",
      error: { code: "x", message: "y", retryable: false, entity: "e" },
    });
    expect(WriteEnvelopeV2Schema.parse(er).status).toBe("error");
  });
});

// ===========================================================================
// Task F1.5 — REST conformance for /api/v2/firewalls
//
// Asserts the live REST envelopes parse against the SAME canonical schemas
// the console imports. This is the cross-package oracle: any drift between
// the core's emitted shape and the contract schema fails here first.
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
      this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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

const BASE = "https://api.hetzner.cloud/v1";
const FIXED = new Date("2026-05-20T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN = "tok-full-v2conf";

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

function mkServer(name: string, hcloud_id: number): Server {
  return {
    name,
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels: { web: "" },
    network: "mesh",
    status: "healthy",
    hcloud_id,
  };
}

function makeRest(): {
  rest: RestServer;
  workingStore: ReturnType<typeof createInMemoryWorkingFirewallStore>;
} {
  const servers: Server[] = [mkServer("web-1", 10)];
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["resolve_selector", "set_firewall"]),
    setFirewall: {
      pool,
      provider,
      approvalGate: gate,
      workingStore,
      serversProvider: async () => servers,
    },
  });
  return { rest, workingStore };
}

async function restCall(
  rest: RestServer,
  opts: { method: string; url: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const req = new FakeReq({
    method: opts.method,
    url: opts.url,
    headers: { authorization: `Bearer ${TOKEN}` },
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

const FW = {
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

describe("Task F1.5 — REST contract-v2 conformance for /api/v2/firewalls", () => {
  it("POST /api/v2/firewalls (dry_run:true) response parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRest();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: true, firewall: FW },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/firewalls (applied) response parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRest();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/firewalls",
      body: { dry_run: false, firewall: FW },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("applied");
  });

  it("GET /api/v2/firewalls body parses against z.array(FirewallSchema) — seeded working store", async () => {
    const { rest, workingStore } = makeRest();
    // Seed working-store with three desired firewalls; the listing endpoint
    // returns them in deterministic (name-sorted) order.
    const FW2 = { ...FW, name: "api-fw" };
    const FW3 = {
      ...FW,
      name: "db-fw",
      rules: [
        {
          direction: "in" as const,
          protocol: "tcp" as const,
          port: "5432",
          source_ips: ["10.0.0.0/8"],
        },
      ],
    };
    await workingStore.put(FW.name, FW);
    await workingStore.put(FW2.name, FW2);
    await workingStore.put(FW3.name, FW3);

    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/firewalls",
    });
    expect(r.status).toBe(200);
    const list = z.array(FirewallSchema).parse(r.body);
    expect(list.map((f) => f.name)).toEqual(["api-fw", "db-fw", "web-fw"]);
  });

  it("GET /api/v2/firewalls returns [] when working-store is empty", async () => {
    const { rest } = makeRest();
    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/firewalls",
    });
    expect(r.status).toBe(200);
    const list = z.array(FirewallSchema).parse(r.body);
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// Task F2.5 — REST conformance for /api/v2/primary-ips
//
// Mirrors the F1.5 firewalls block: POST envelopes parse against
// WriteEnvelopeV2Schema (dry_run:true ⇒ `planned`; non-dry_run new IP ⇒
// `pending_approval` because `set_primary_ip` is APPROVAL-ALWAYS for every
// non-no-op — a PrimaryIP is billed even when unassigned); GET body parses
// against z.array(PrimaryIPSchema) — the listing endpoint reads from the
// working desired-state store (the canonical manifest shape, plan option (c)).
// ===========================================================================

function makeRestPrimaryIp(): {
  rest: RestServer;
  workingStore: ReturnType<typeof createInMemoryWorkingPrimaryIpStore>;
} {
  // Empty server set ⇒ assignee_selector always resolves to ∅ for the
  // conformance fixtures (mirrors the F2.4 test posture and matches the
  // strict-equality boundary the F2.3 provider walks as a no-op on cycle ≥2).
  const servers: Server[] = [];
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
  // APPROVAL-ALWAYS: set_primary_ip requires isSensitive:() => true so every
  // non-no-op (create/update) is gated (PrimaryIP billed even when unassigned).
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["resolve_selector", "set_primary_ip"]),
    setPrimaryIp: {
      pool,
      provider,
      approvalGate: gate,
      workingStore,
      serversProvider: async () => servers,
    },
  });
  return { rest, workingStore };
}

const PIP = {
  name: "web-pip",
  type: "ipv4" as const,
  location: "fsn1",
  assignee_selector: { label: "web" },
};

describe("Task F2.5 — REST contract-v2 conformance for /api/v2/primary-ips", () => {
  it("POST /api/v2/primary-ips (dry_run:true) response parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRestPrimaryIp();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: true, primary_ip: PIP },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/primary-ips (non-dry_run, new IP) response parses against WriteEnvelopeV2Schema with status=pending_approval", async () => {
    // set_primary_ip is APPROVAL-ALWAYS for any real change; the realistic
    // non-dry_run success path for a fresh PrimaryIP is the pending_approval
    // envelope (the applied path is only reachable on an idempotent no-op,
    // covered exhaustively by the property test).
    const { rest } = makeRestPrimaryIp();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/primary-ips",
      body: { dry_run: false, primary_ip: PIP },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBeDefined();
  });

  it("GET /api/v2/primary-ips body parses against z.array(PrimaryIPSchema) — seeded working store", async () => {
    const { rest, workingStore } = makeRestPrimaryIp();
    // Seed working-store with three desired PrimaryIPs; the listing endpoint
    // returns them in deterministic (name-sorted) order.
    const PIP2 = { ...PIP, name: "api-pip" };
    const PIP3 = {
      ...PIP,
      name: "db-pip",
      type: "ipv6" as const,
    };
    await workingStore.put(PIP.name, PIP);
    await workingStore.put(PIP2.name, PIP2);
    await workingStore.put(PIP3.name, PIP3);

    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/primary-ips",
    });
    expect(r.status).toBe(200);
    const list = z.array(PrimaryIPSchema).parse(r.body);
    expect(list.map((p) => p.name)).toEqual(["api-pip", "db-pip", "web-pip"]);
  });

  it("GET /api/v2/primary-ips returns [] when working-store is empty", async () => {
    const { rest } = makeRestPrimaryIp();
    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/primary-ips",
    });
    expect(r.status).toBe(200);
    const list = z.array(PrimaryIPSchema).parse(r.body);
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// Task F3.6 — REST conformance for /api/v2/certificates
//
// Mirrors the F1.5 firewalls and F2.5 primary-ips blocks: POST envelopes parse
// against WriteEnvelopeV2Schema across both type branches:
//   - dry_run:true (managed / uploaded)            ⇒ planned (no approval).
//   - dry_run:false NEW managed                    ⇒ applied (no approval;
//                                                    Hetzner-owned ACME, free,
//                                                    not destructive).
//   - dry_run:false NEW uploaded                   ⇒ pending_approval (touches
//                                                    operator-supplied secret).
// GET body parses against z.array(CertificateSchema) — the listing endpoint
// reads from the working desired-state store (canonical manifest projection,
// same shape as F1.5 / F2.5). Both type branches are covered in the seeded
// listing fixture so the discriminated-union schema is exercised both ways.
// ===========================================================================

const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nfakecert-web\n-----END CERTIFICATE-----";
const STUB_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nfakekey-web\n-----END PRIVATE KEY-----";

function makeRestCertificate(): {
  rest: RestServer;
  workingStore: ReturnType<typeof createInMemoryWorkingCertificateStore>;
} {
  const fakeHetzner = createHetznerHttpFake();
  // Settle managed issuance synchronously on the first GET so the conformance
  // POST applied-path is deterministic without any reconciler loop.
  fakeHetzner.setManagedIssuanceLatency(0);
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  // Deterministic secret stub — never invoked on managed/dry_run paths and
  // (in the conformance block) never invoked on the pending_approval path
  // either (approval gates before apply), so the value is academic. Kept
  // valid for parsePem in case a future test variant flips approval-passthrough.
  const secretResolver = async (_ref: string): Promise<string> => STUB_KEY_PEM;
  const provider = createHetznerCertificateProvider({
    http: v2http,
    secretResolver,
  });
  const workingStore = createInMemoryWorkingCertificateStore();
  let idn = 0;
  // Type-aware sensitivity is owned by setCertificate itself (it constructs
  // synthetic ops only for the uploaded branch and only routes them through
  // this gate). The gate's isSensitive is therefore always-true: it only ever
  // receives uploaded-branch synthetics, which MUST gate.
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["resolve_selector", "set_certificate"]),
    setCertificate: {
      pool,
      provider,
      approvalGate: gate,
      workingStore,
    },
  });
  return { rest, workingStore };
}

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

describe("Task F3.6 — REST contract-v2 conformance for /api/v2/certificates", () => {
  it("POST /api/v2/certificates (dry_run:true, managed) → planned envelope parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRestCertificate();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: true, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/certificates (dry_run:true, uploaded) → planned envelope parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRestCertificate();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: true, certificate: CERT_UPLOADED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/certificates (non-dry_run, NEW managed) → applied envelope (no approval — Hetzner-owned ACME)", async () => {
    // Managed certs are FREE + not destructive — set_certificate emits an
    // `applied` envelope directly and kicks the issuance polling. The
    // envelope shape here is exactly what the cross-package schema requires.
    const { rest } = makeRestCertificate();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_MANAGED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("applied");
  });

  it("POST /api/v2/certificates (non-dry_run, NEW uploaded) → pending_approval (touches secret)", async () => {
    // Uploaded certs carry an operator-supplied private key (secret) ⇒
    // approval-gated on every non-no-op (parallel to F2.4 PrimaryIPs).
    const { rest } = makeRestCertificate();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/certificates",
      body: { dry_run: false, certificate: CERT_UPLOADED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBeDefined();
  });

  it("GET /api/v2/certificates body parses against z.array(CertificateSchema) — seeded mixed managed+uploaded", async () => {
    const { rest, workingStore } = makeRestCertificate();
    // Seed a mix of managed and uploaded so the discriminated-union schema
    // is exercised across BOTH branches. Listing is name-sorted (canonical).
    const C_MANAGED = {
      name: "api-cert",
      type: "managed" as const,
      domains: ["api.example.com"],
    };
    const C_UPLOADED = {
      name: "db-cert",
      type: "uploaded" as const,
      domains: ["db.example.com"],
      certificate_pem: CERT_PEM,
      private_key_secret_ref: "secret:db-cert-key",
    };
    const C_MANAGED_2 = {
      name: "web-cert",
      type: "managed" as const,
      domains: ["web.example.com"],
    };
    await workingStore.put(C_MANAGED.name, C_MANAGED);
    await workingStore.put(C_UPLOADED.name, C_UPLOADED);
    await workingStore.put(C_MANAGED_2.name, C_MANAGED_2);

    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/certificates",
    });
    expect(r.status).toBe(200);
    const list = z.array(CertificateSchema).parse(r.body);
    expect(list.map((c) => c.name)).toEqual([
      "api-cert",
      "db-cert",
      "web-cert",
    ]);
    // Both branches present in the parsed projection.
    expect(list.map((c) => c.type).sort()).toEqual([
      "managed",
      "managed",
      "uploaded",
    ]);
  });

  it("GET /api/v2/certificates returns [] when working-store is empty", async () => {
    const { rest } = makeRestCertificate();
    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/certificates",
    });
    expect(r.status).toBe(200);
    const list = z.array(CertificateSchema).parse(r.body);
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// Task F4.5 — REST conformance for /api/v2/load-balancers
//
// Mirrors the F1.5 / F2.5 / F3.6 blocks: POST envelopes parse against
// WriteEnvelopeV2Schema; GET body parses against z.array(LoadBalancerSchema).
//
// Approval posture: APPROVAL-ALWAYS for every non-no-op (LB is a billed
// Hetzner resource AND a location change forces destroy+recreate with public-
// IP loss — see set-load-balancer.ts header). Therefore the non-dry_run
// success path on a fresh LB lands `pending_approval`. The location-change
// case is asserted via the dry_run plan envelope: the provider's `recreate`
// op flows through VERBATIM into envelope.plan.ops with the public-IP impact
// note (the agent reading the envelope must see the destructive note pre-
// apply). GET listing covers seeded + empty.
// ===========================================================================

const LB_DESIRED = {
  name: "web-lb",
  location: "fsn1" as const,
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

/**
 * Seed a Load Balancer into the Hetzner fake directly (bypassing the
 * provider) so the conformance test can drive the location-change path
 * without depending on the F4.4 tool's approval flow. Mirrors the helper in
 * `set-load-balancer.test.ts` (F4.4) but lives here to keep this file
 * self-contained per F1.5/F2.5/F3.6 convention.
 */
async function seedLb(
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>,
  overrides: { location?: string } = {},
): Promise<void> {
  await fakeHetzner.fetch(`${BASE}/load_balancers`, {
    method: "POST",
    body: JSON.stringify({
      name: LB_DESIRED.name,
      load_balancer_type: "lb11",
      location: overrides.location ?? LB_DESIRED.location,
      algorithm: { type: LB_DESIRED.algorithm },
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
      targets: [],
    }),
  });
}

function makeRestLoadBalancer(opts?: {
  servers?: Server[];
  services?: Service[];
}): {
  rest: RestServer;
  workingStore: ReturnType<typeof createInMemoryWorkingLoadBalancerStore>;
  fakeHetzner: ReturnType<typeof createHetznerHttpFake>;
} {
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
  // APPROVAL-ALWAYS — set_load_balancer's synthetic PlanItems may carry
  // op=create/update/destroy; the LB is billed AND a location change destroys
  // the public IP, so every non-no-op MUST gate. Mirrors F2.5 / F3.6-uploaded.
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["resolve_selector", "set_load_balancer"]),
    setLoadBalancer: {
      pool,
      provider,
      approvalGate: gate,
      workingStore,
    },
  });
  return { rest, workingStore, fakeHetzner };
}

describe("Task F4.5 — REST contract-v2 conformance for /api/v2/load-balancers", () => {
  it("POST /api/v2/load-balancers (dry_run:true) → planned envelope parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRestLoadBalancer();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: true, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/load-balancers (non-dry_run, NEW LB) → pending_approval (Approval ALWAYS — billed resource)", async () => {
    // set_load_balancer is APPROVAL-ALWAYS for any real change; a fresh LB on
    // the non-dry_run path lands `pending_approval`. The applied path is only
    // reachable on an idempotent no-op (asserted exhaustively by the
    // F4.5 property test).
    const { rest } = makeRestLoadBalancer();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBeDefined();
  });

  it("POST /api/v2/load-balancers (non-dry_run, LOCATION change) → pending_approval AND plan.ops carries the recreate op with public-IP impact", async () => {
    // Seed an observed LB at nbg1; desired is fsn1 ⇒ provider emits a single
    // `recreate` op with `impact:"public IP will change"`. The tool MUST
    // propagate that op into envelope.plan.ops verbatim so the agent sees the
    // destructive impact pre-approval (per F4.4 design).
    const { rest, fakeHetzner } = makeRestLoadBalancer();
    await seedLb(fakeHetzner, { location: "nbg1" });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/load-balancers",
      body: { dry_run: false, load_balancer: LB_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBeDefined();
    expect(env.plan).toBeDefined();
    const ops = env.plan!.ops as ReadonlyArray<{
      op: string;
      entity: string;
      impact?: string;
    }>;
    const recreate = ops.find((o) => o.op === "recreate");
    expect(recreate).toBeDefined();
    expect(recreate!.impact).toBe("public IP will change");
  });

  it("GET /api/v2/load-balancers body parses against z.array(LoadBalancerSchema) — seeded working store", async () => {
    const { rest, workingStore } = makeRestLoadBalancer();
    // Seed working-store with three desired LBs; the listing endpoint returns
    // them in deterministic (name-sorted) order. Each carries a complete
    // health_check (discriminated union) so the schema is exercised across
    // protocol branches.
    const LB2 = {
      ...LB_DESIRED,
      name: "api-lb",
      algorithm: "least_connections" as const,
      health_check: {
        protocol: "tcp" as const,
        port: 5432,
        interval: 10,
        timeout: 5,
        retries: 2,
      },
    };
    const LB3 = {
      ...LB_DESIRED,
      name: "db-lb",
      health_check: {
        protocol: "https" as const,
        port: 443,
        interval: 20,
        timeout: 8,
        retries: 4,
        path: "/healthz",
      },
    };
    await workingStore.put(LB_DESIRED.name, LB_DESIRED);
    await workingStore.put(LB2.name, LB2);
    await workingStore.put(LB3.name, LB3);

    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/load-balancers",
    });
    expect(r.status).toBe(200);
    const list = z.array(LoadBalancerSchema).parse(r.body);
    expect(list.map((l) => l.name)).toEqual(["api-lb", "db-lb", "web-lb"]);
    // All three protocol branches exercised across the seeded fixture.
    expect(list.map((l) => l.health_check.protocol).sort()).toEqual([
      "http",
      "https",
      "tcp",
    ]);
  });

  it("GET /api/v2/load-balancers returns [] when working-store is empty", async () => {
    const { rest } = makeRestLoadBalancer();
    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/load-balancers",
    });
    expect(r.status).toBe(200);
    const list = z.array(LoadBalancerSchema).parse(r.body);
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// Task F5.5 — REST conformance for /api/v2/ingresses
//
// Mirrors the F1.5 / F2.5 / F3.6 / F4.5 blocks: POST envelopes parse against
// WriteEnvelopeV2Schema; GET body parses against z.array(IngressSchema).
//
// Approval posture: NO APPROVAL on CREATE (a brand-new Ingress is a fresh
// DNS record creation — consistent with v1 `set_dns`); APPROVAL on
// `hostname` / `load_balancer_ref` changes (DNS records become stale,
// destructive removal class). The IDEMPOTENT no-op short-circuits to
// `applied` empty-ops with NO approval. The location-recreate / managed-cert
// kickoff side effects converge inside the IngressProvider's sub-providers
// (cert/lb/fw + DNS) — for conformance we wire real Hetzner fakes
// (`setManagedIssuanceLatency(0)` so issuance settles synchronously) and a
// trivial DNS provider (idempotent upsert). GET listing covers
// seeded + empty.
// ===========================================================================

const ING_DESIRED: Ingress = {
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

const CERT_FIXTURE_ING: CertV2 = {
  name: "web-cert",
  type: "managed",
  domains: ["web.example.com"],
};

const LB_FIXTURE_ING: LoadBalancerV2 = {
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

const FW_FIXTURE_ING: FirewallV2 = {
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

function makeFakeDns(): DnsProvider {
  return {
    name: "fake-dns",
    async observe(scope: string): Promise<DnsObservedSlice> {
      return { scope, entities: [] };
    },
    async apply(action: DnsPlanAction): Promise<DnsApplyResult> {
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

function makeRestIngress(opts?: {
  certLookup?: CertV2 | null;
  lbLookup?: LoadBalancerV2 | null;
  fwLookup?: FirewallV2 | null;
}): {
  rest: RestServer;
  workingStore: ReturnType<typeof createInMemoryWorkingIngressStore>;
  provider: ReturnType<typeof createIngressProvider>;
} {
  const fakeHetzner = createHetznerHttpFake();
  // Settle managed issuance synchronously so the cert sub-provider doesn't
  // leave the composite stuck in `pending` for the applied conformance path.
  fakeHetzner.setManagedIssuanceLatency(0);
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  // No servers / services — LB target set resolves to ∅ (strict-equality
  // no-op boundary; same posture as F4.5).
  const servers: Server[] = [];
  const services: Service[] = [];
  const certProvider = createHetznerCertificateProvider({
    http: v2http,
    // Uploaded path never reached in this fixture (managed cert only).
    secretResolver: async () =>
      "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
  });
  const lbProvider = createHetznerLoadBalancerProvider({
    http: v2http,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
  });
  const fwProvider = createHetznerFirewallProvider({
    http: v2http,
    serversProvider: async () => servers,
  });
  const dnsProvider = makeFakeDns();
  const certResolved =
    opts?.certLookup === undefined ? CERT_FIXTURE_ING : opts.certLookup;
  const lbResolved =
    opts?.lbLookup === undefined ? LB_FIXTURE_ING : opts.lbLookup;
  const fwResolved =
    opts?.fwLookup === undefined ? FW_FIXTURE_ING : opts.fwLookup;
  const provider = createIngressProvider({
    certificateProvider: certProvider,
    loadBalancerProvider: lbProvider,
    firewallProvider: fwProvider,
    dnsProvider,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
    certificateLookup: async () => certResolved,
    firewallLookup: async () => fwResolved,
    loadBalancerLookup: async () => lbResolved,
  });
  const workingStore = createInMemoryWorkingIngressStore();
  let idn = 0;
  // F5.3 only synthesises destructive `destroy` items on DNS-touch changes
  // (hostname / load_balancer_ref). The default isSensitive (op-based,
  // `destroy` is sensitive by default) is correct here — same posture as
  // F1.5 firewall.
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set(["resolve_selector", "set_ingress"]),
    setIngress: {
      pool,
      provider,
      approvalGate: gate,
      workingStore,
    },
  });
  return { rest, workingStore, provider };
}

describe("Task F5.5 — REST contract-v2 conformance for /api/v2/ingresses", () => {
  it("POST /api/v2/ingresses (dry_run:true) → planned envelope parses against WriteEnvelopeV2Schema", async () => {
    const { rest } = makeRestIngress();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: true, ingress: ING_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan).toBeDefined();
    expect(env.plan!.cost_estimate).toEqual({
      monthly_delta_eur: 0,
      breakdown: [],
    });
    expect(env.plan!.policy_violations).toEqual([]);
  });

  it("POST /api/v2/ingresses (non-dry_run, NEW ingress) → applied envelope (no Approval — fresh DNS create, consistent with v1 set_dns)", async () => {
    // A brand-new Ingress is a fresh A/AAAA record creation; nothing existing
    // is being invalidated ⇒ no Approval. The applied envelope parses against
    // the cross-package schema verbatim.
    const { rest } = makeRestIngress();
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("applied");
  });

  it("POST /api/v2/ingresses (non-dry_run, HOSTNAME change) → pending_approval (DNS-destructive)", async () => {
    // Seed prior working desired with a different hostname; the F5.3 tool
    // classifies this as DNS-destructive (the OLD A/AAAA records become
    // stale) and routes through the gate.
    const { rest, workingStore } = makeRestIngress();
    await workingStore.put(ING_DESIRED.name, {
      ...ING_DESIRED,
      hostname: "old.example.com",
    });
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBeDefined();
  });

  it("POST /api/v2/ingresses (non-dry_run, idempotent no-op) → applied empty-ops", async () => {
    // The F5.3 idempotent short-circuit fires when (a) the working store
    // already holds this exact desired AND (b) the composite plan has no
    // real ops AND (c) no DNS-touch destructive change. set_ingress itself
    // NEVER drives apply() (it records intent only — same discipline as
    // F4.4); the reconciler converges Hetzner on its next cycle. So to
    // exercise the no-op branch via REST we pre-converge Hetzner state by
    // calling the IngressProvider's apply() directly, AND pre-seed the
    // working store. Then the POST sees prior !== null AND composite plan
    // = empty ⇒ short-circuit fires.
    const { rest, workingStore, provider } = makeRestIngress();
    await workingStore.put(ING_DESIRED.name, ING_DESIRED);
    await provider.apply(ING_DESIRED, null);
    const r = await restCall(rest, {
      method: "POST",
      url: "/api/v2/ingresses",
      body: { dry_run: false, ingress: ING_DESIRED },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeV2Schema.parse(r.body);
    expect(env.status).toBe("applied");
    expect(env.plan).toBeDefined();
    expect(env.plan!.ops).toEqual([]);
  });

  it("GET /api/v2/ingresses body parses against z.array(IngressSchema) — seeded working store", async () => {
    const { rest, workingStore } = makeRestIngress();
    // Seed three desired ingresses; listing is name-sorted (canonical).
    const ING2: Ingress = {
      ...ING_DESIRED,
      name: "api",
      hostname: "api.example.com",
    };
    const ING3: Ingress = {
      ...ING_DESIRED,
      name: "db",
      hostname: "db.example.com",
      firewall_ref: "db-fw",
    };
    await workingStore.put(ING_DESIRED.name, ING_DESIRED);
    await workingStore.put(ING2.name, ING2);
    await workingStore.put(ING3.name, ING3);

    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/ingresses",
    });
    expect(r.status).toBe(200);
    const list = z.array(IngressSchema).parse(r.body);
    expect(list.map((i) => i.name)).toEqual(["api", "db", "web"]);
  });

  it("GET /api/v2/ingresses returns [] when working-store is empty", async () => {
    const { rest } = makeRestIngress();
    const r = await restCall(rest, {
      method: "GET",
      url: "/api/v2/ingresses",
    });
    expect(r.status).toBe(200);
    const list = z.array(IngressSchema).parse(r.body);
    expect(list).toEqual([]);
  });
});

// ===========================================================================
// Task F6.5 — v2 listing endpoints (read-only consumption, all wired together)
//
// The per-phase blocks above each prove a SINGLE listing endpoint against its
// schema, with only its own `setX` dep wired (other deps absent ⇒ `[]`
// fallback per the backward-compat read pattern). F6.5 owns the
// COMPLETENESS guarantee: when ALL FIVE `setX` deps are wired together on a
// single RestServer (the realistic Console consumption posture), all five
// `GET /api/v2/*` listing endpoints:
//
//   1. respond 200,
//   2. return UNWRAPPED arrays (no envelope, no pagination — read endpoints
//      are direct projections of the working desired-state store),
//   3. parse against their respective canonical schemas imported from
//      `console/src/api/contract-v2.ts` (the cross-package oracle),
//   4. and the projections are isolated per-store (a Firewall seeded in the
//      firewall store doesn't bleed into the Certificate listing, etc.).
//
// This is the only integrated five-endpoint assertion in the suite and is the
// Console-facing contract Bloco A ships at end-of-F6.
// ===========================================================================

function makeRestAll5(): {
  rest: RestServer;
  stores: {
    firewall: ReturnType<typeof createInMemoryWorkingFirewallStore>;
    primaryIp: ReturnType<typeof createInMemoryWorkingPrimaryIpStore>;
    certificate: ReturnType<typeof createInMemoryWorkingCertificateStore>;
    loadBalancer: ReturnType<typeof createInMemoryWorkingLoadBalancerStore>;
    ingress: ReturnType<typeof createInMemoryWorkingIngressStore>;
  };
} {
  const servers: Server[] = [];
  const services: Service[] = [];
  const fakeHetzner = createHetznerHttpFake();
  fakeHetzner.setManagedIssuanceLatency(0);
  const v2http = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fakeHetzner.fetch,
  });
  const firewallProvider = createHetznerFirewallProvider({
    http: v2http,
    serversProvider: async () => servers,
  });
  const primaryIpProvider = createHetznerPrimaryIPProvider({
    http: v2http,
    serversProvider: async () => servers,
  });
  const certificateProvider = createHetznerCertificateProvider({
    http: v2http,
    secretResolver: async () => STUB_KEY_PEM,
  });
  const loadBalancerProvider = createHetznerLoadBalancerProvider({
    http: v2http,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
  });
  const ingressProvider = createIngressProvider({
    certificateProvider,
    loadBalancerProvider,
    firewallProvider,
    dnsProvider: makeFakeDns(),
    serversProvider: async () => servers,
    servicesProvider: async () => services,
    certificateLookup: async () => CERT_FIXTURE_ING,
    firewallLookup: async () => FW_FIXTURE_ING,
    loadBalancerLookup: async () => LB_FIXTURE_ING,
  });
  const fwStore = createInMemoryWorkingFirewallStore();
  const pipStore = createInMemoryWorkingPrimaryIpStore();
  const certStore = createInMemoryWorkingCertificateStore();
  const lbStore = createInMemoryWorkingLoadBalancerStore();
  const ingStore = createInMemoryWorkingIngressStore();
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
    [TOKEN]: {
      actor: "agent:vox",
      capabilities: [...ALL_TOOLS, ...V2_TOOLS],
    },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    v2Tools: new Set([
      "resolve_selector",
      "set_firewall",
      "set_primary_ip",
      "set_certificate",
      "set_load_balancer",
      "set_ingress",
    ]),
    setFirewall: {
      pool,
      provider: firewallProvider,
      approvalGate: gate,
      workingStore: fwStore,
      serversProvider: async () => servers,
    },
    setPrimaryIp: {
      pool,
      provider: primaryIpProvider,
      approvalGate: gate,
      workingStore: pipStore,
      serversProvider: async () => servers,
    },
    setCertificate: {
      pool,
      provider: certificateProvider,
      approvalGate: gate,
      workingStore: certStore,
    },
    setLoadBalancer: {
      pool,
      provider: loadBalancerProvider,
      approvalGate: gate,
      workingStore: lbStore,
    },
    setIngress: {
      pool,
      provider: ingressProvider,
      approvalGate: gate,
      workingStore: ingStore,
    },
  });
  return {
    rest,
    stores: {
      firewall: fwStore,
      primaryIp: pipStore,
      certificate: certStore,
      loadBalancer: lbStore,
      ingress: ingStore,
    },
  };
}

describe("Task F6.5 — v2 listing endpoints (Console-facing completeness)", () => {
  it("all five GET /api/v2/* listings return [] when stores are empty (single RestServer, all setX wired)", async () => {
    const { rest } = makeRestAll5();
    const endpoints: ReadonlyArray<{ url: string; schema: z.ZodTypeAny }> = [
      { url: "/api/v2/firewalls", schema: z.array(FirewallSchema) },
      { url: "/api/v2/primary-ips", schema: z.array(PrimaryIPSchema) },
      { url: "/api/v2/certificates", schema: z.array(CertificateSchema) },
      { url: "/api/v2/load-balancers", schema: z.array(LoadBalancerSchema) },
      { url: "/api/v2/ingresses", schema: z.array(IngressSchema) },
    ];
    for (const { url, schema } of endpoints) {
      const r = await restCall(rest, { method: "GET", url });
      expect(r.status, `GET ${url} → 200`).toBe(200);
      const list = schema.parse(r.body) as unknown[];
      expect(list, `GET ${url} → []`).toEqual([]);
    }
  });

  it("all five GET /api/v2/* listings return ONLY their own store's seeded entities (no cross-store bleed)", async () => {
    const { rest, stores } = makeRestAll5();
    // One entity per kind, distinct names — listings must be isolated per store.
    await stores.firewall.put(FW.name, FW);
    await stores.primaryIp.put(PIP.name, PIP);
    await stores.certificate.put(CERT_MANAGED.name, CERT_MANAGED);
    await stores.loadBalancer.put(LB_DESIRED.name, LB_DESIRED);
    await stores.ingress.put(ING_DESIRED.name, ING_DESIRED);

    const rFw = await restCall(rest, { method: "GET", url: "/api/v2/firewalls" });
    expect(rFw.status).toBe(200);
    const fws = z.array(FirewallSchema).parse(rFw.body);
    expect(fws.map((f) => f.name)).toEqual([FW.name]);

    const rPip = await restCall(rest, { method: "GET", url: "/api/v2/primary-ips" });
    expect(rPip.status).toBe(200);
    const pips = z.array(PrimaryIPSchema).parse(rPip.body);
    expect(pips.map((p) => p.name)).toEqual([PIP.name]);

    const rCerts = await restCall(rest, { method: "GET", url: "/api/v2/certificates" });
    expect(rCerts.status).toBe(200);
    const certs = z.array(CertificateSchema).parse(rCerts.body);
    expect(certs.map((c) => c.name)).toEqual([CERT_MANAGED.name]);

    const rLbs = await restCall(rest, { method: "GET", url: "/api/v2/load-balancers" });
    expect(rLbs.status).toBe(200);
    const lbs = z.array(LoadBalancerSchema).parse(rLbs.body);
    expect(lbs.map((l) => l.name)).toEqual([LB_DESIRED.name]);

    const rIng = await restCall(rest, { method: "GET", url: "/api/v2/ingresses" });
    expect(rIng.status).toBe(200);
    const ings = z.array(IngressSchema).parse(rIng.body);
    expect(ings.map((i) => i.name)).toEqual([ING_DESIRED.name]);
  });

  it("all five GET /api/v2/* listings reject unauthenticated reads (deny-before-read, parity with v2 write endpoints)", async () => {
    const { rest } = makeRestAll5();
    const urls = [
      "/api/v2/firewalls",
      "/api/v2/primary-ips",
      "/api/v2/certificates",
      "/api/v2/load-balancers",
      "/api/v2/ingresses",
    ];
    for (const url of urls) {
      const req = new FakeReq({ method: "GET", url, headers: {} });
      const res = new FakeRes();
      await rest.handle(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      );
      await res.done;
      expect(res.statusCode, `GET ${url} unauth → 403`).toBe(403);
    }
  });
});

