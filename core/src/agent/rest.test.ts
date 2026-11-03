/**
 * core/src/agent/rest.test.ts
 *
 * Task 4.5 — TDD teeth for the REST API. Every row of the frozen
 * `console/CONTRACT.md` Tool→Endpoint table is wired with the EXACT
 * method/path/query; every response is parsed against a by-value mirror of the
 * frozen contract Zod schemas (the established envelope.ts/errors.ts mirror
 * precedent — the cross-package oracle is Task 4.6, but 4.5 catches divergence
 * early here).
 *
 * The handler is exercised IN-PROCESS via a minimal IncomingMessage/
 * ServerResponse double — NO real port is bound (deterministic, no port race).
 * The DB uses the pg harness; the gate clock + approval ids are injected
 * (no real timers).
 *
 * Teeth asserted (the exact contract guarantees):
 *   - every read/write row → correct tool, contract-shaped body, schema-parses;
 *   - destructive ops (destroy/restore) → pending_approval via the 4.3 gate;
 *   - dry_run:true on a conditional write → planned (no mutation);
 *   - reads never mutate (no approval, no working_state write);
 *   - missing/invalid credential → contract error + correct status + NO tool
 *     executed (deny-before-write: no StateEvent, no approval row);
 *   - no secret/token leak in any body;
 *   - approvals list/approve/reject project onto the FROZEN ApprovalSchema;
 *   - path params are authoritative for the routed resource id.
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

import { ALL_TOOLS } from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import { createToolCatalog } from "./tools.js";
import { createInjectedCredentialStore } from "./auth.js";
import { createDesiredStateSeam } from "../store/desired-state-seam.js";
import { createRestServer, type RestServer } from "./rest.js";
import { compositeProvider } from "../reconciler/composite-provider.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { putState as putWorkingState } from "../store/working-store.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

// ===========================================================================
// By-value mirror of the FROZEN console/src/api/contract.ts schemas (the
// envelope.ts/errors.ts precedent — no console-package import; the 4.6 oracle
// owns the cross-package live-schema check). These MUST stay byte-faithful.
// ===========================================================================

const StatusEnum = z.enum([
  "pending",
  "applying",
  "healthy",
  "degraded",
  "drift",
  "error",
]);
const ServerSchema = z.object({
  name: z.string(),
  type: z.string(),
  location: z.string(),
  image: z.string(),
  ssh_keys: z.array(z.string()),
  labels: z.record(z.string()),
  network: z.string(),
  status: StatusEnum,
});
const NetworkSchema = z.object({
  name: z.string(),
  ip_range: z.string(),
  subnets: z.array(z.string()),
});
const VolumeSchema = z.object({
  name: z.string(),
  size: z.string(),
  server: z.string().optional(),
  fs: z.string(),
  status: StatusEnum.optional(),
});
const ServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  replicas: z.number(),
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
  status: StatusEnum.optional(),
});
const DnsRecordSchema = z.object({
  zone: z.string(),
  name: z.string(),
  type: z.string().min(1),
  value: z.string(),
  ttl: z.number(),
});
const BackupPolicySchema = z.object({
  target: z.string(),
  schedule: z.string(),
  retention: z.string(),
  repo: z.string(),
});
const StateEventSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  op: z.string(),
  entity: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  result: z.string(),
});
const PlanOpEnum = z.enum([
  "create",
  "add",
  "update",
  "scale",
  "drift",
  "remove",
  "destroy",
  "noop",
  "upsert",
  "snapshot",
  "restore",
]);
const PlanItemSchema = z.object({
  op: PlanOpEnum,
  entity: z.string(),
  change: z.string(),
  impact: z.string(),
});
const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  entity: z.string(),
});
const WriteEnvelopeSchema = z.object({
  status: z.enum(["planned", "pending_approval", "applied", "error"]),
  plan: z.array(PlanItemSchema).optional(),
  approval_id: z.string().optional(),
  error: ErrorSchema.optional(),
});
const ApprovalSchema = z.object({
  id: z.string(),
  action: z.string(),
  entity: z.string(),
  actor: z.string(),
  requested_at: z.string(),
  ttl_remaining: z.string(),
  impact: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
});
const CircuitBreakerSchema = z.object({
  name: z.string(),
  state: z.string(),
  failures: z.number().optional(),
  max_failures: z.number().optional(),
  last_failure: z.string().optional(),
});
const HealthReportSchema = z.object({
  circuit_breakers: z.array(CircuitBreakerSchema),
  degraded: z.array(z.object({ entity: z.string(), detail: z.string() })),
  blocked: z.array(z.object({ entity: z.string(), reason: z.string() })),
  drift: z.array(z.object({ entity: z.string(), detail: z.string() })),
  reconciler: z.object({
    state: z.string(),
    last_cycle: z.string(),
    last_result: z.string(),
    next_cycle_in: z.string(),
    total_cycles: z.number(),
  }),
});
const StateSchema = z.object({
  servers: z.array(ServerSchema),
  networks: z.array(NetworkSchema),
  volumes: z.array(VolumeSchema),
  services: z.array(ServiceSchema),
  dns: z.array(DnsRecordSchema),
  backups: z.array(BackupPolicySchema),
});

// ===========================================================================
// In-process HTTP request/response doubles (NO port bound)
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
  // async-iterable body so rest.ts `for await (chunk of req)` works.
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
// Fakes (network-free) — mirror tools.test.ts so REST/catalog stay in sync
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

function makeServer(opts?: {
  desiredByScope?: Map<string, DesiredState>;
  provider?: Provider;
}): { rest: RestServer } {
  // Spec §4.5 (rev b): test harness mirrors entrypoint-wiring's production
  // seam (cross-scope read union + write strip-to-own). Tests that seed via
  // the optional desiredByScope opt write directly to the Map, bypassing
  // strip-to-own; that's intentional (lets tests pre-populate per-kind silos
  // without going through writeDesired).
  const seam = createDesiredStateSeam();
  const desiredByScope = opts?.desiredByScope ?? seam.desiredByScope;
  const loadDesired =
    opts?.desiredByScope !== undefined
      ? async (scope: string): Promise<DesiredState> =>
          desiredByScope.get(scope) ?? {}
      : seam.loadDesired;
  const writeDesired =
    opts?.desiredByScope !== undefined
      ? async (scope: string, desired: DesiredState): Promise<void> => {
          desiredByScope.set(scope, desired);
        }
      : seam.writeDesired;
  const provider = opts?.provider ?? makeFakeProvider();
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
    loadDesired,
    writeDesired,
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
  return { rest };
}

async function call(
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

// ===========================================================================
// 0. Read endpoints — exact path/query → tool, contract-schema-parsed
// ===========================================================================

describe("read endpoints (CONTRACT.md Tool→Endpoint table)", () => {
  it("GET /api/state → get_state, parses StateSchema, mutates nothing", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/state" });
    expect(r.status).toBe(200);
    expect(() => StateSchema.parse(r.body)).not.toThrow();
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("GET /api/diff?source=working → diff, parses PlanItem[]", async () => {
    const { rest } = makeServer();
    await putWorkingState(pool, "server", {
      ...EMPTY,
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          status: "pending",
        },
      ],
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16", subnets: [] }],
    });
    const r = await call(rest, {
      method: "GET",
      url: "/api/diff?source=working",
    });
    expect(r.status).toBe(200);
    expect(() => z.array(PlanItemSchema).parse(r.body)).not.toThrow();
  });

  it("GET /api/events?actor=&entity=&result= → events, parses StateEvent[]", async () => {
    const { rest } = makeServer();
    await call(rest, { method: "GET", url: "/api/health" }); // generate an event
    const r = await call(rest, {
      method: "GET",
      url: "/api/events?actor=agent:vox",
    });
    expect(r.status).toBe(200);
    expect(() => z.array(StateEventSchema).parse(r.body)).not.toThrow();
    expect((r.body as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/health → health, parses HealthReportSchema", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/health" });
    expect(r.status).toBe(200);
    expect(() => HealthReportSchema.parse(r.body)).not.toThrow();
  });
});

// ===========================================================================
// 1. Write endpoints — exact path/method → tool, WriteEnvelope-shaped
// ===========================================================================

describe("write endpoints (CONTRACT.md Tool→Endpoint table)", () => {
  it("POST /api/servers → provision_server → pending_approval (always-gated)", async () => {
    const desiredByScope = new Map<string, DesiredState>([
      ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
    ]);
    const { rest } = makeServer({ desiredByScope });
    const r = await call(rest, {
      method: "POST",
      url: "/api/servers",
      body: { name: "app-1", type: "cx22", location: "nbg1", network: "net-a" },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("POST /api/services → deploy_service apply (non-sensitive) → applied", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      body: {
        name: "bevox-web",
        image: "registry/bevox-web:v1",
        replicas: 1,
        dry_run: false,
      },
    });
    expect(r.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("applied");
  });

  it("POST /api/services with dry_run:true → planned (no mutation)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      body: {
        name: "bevox-harness",
        image: "registry/bevox-harness:v12",
        replicas: 2,
        env: { TOKEN: "secret:bevox-harness" },
        dry_run: true,
      },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan!.length).toBeGreaterThanOrEqual(1);
    // no-leak: no resolved secret value in the body.
    const blob = JSON.stringify(r.body);
    expect(blob).not.toMatch(/secret-value|decrypted|RESOLVED/i);
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
  });

  it("POST /api/services/:name/scale → scale_service (path param authoritative)", async () => {
    const { rest } = makeServer();
    await call(rest, {
      method: "POST",
      url: "/api/services",
      body: { name: "bevox-web", image: "registry/bevox-web:v1", replicas: 1 },
    });
    const r = await call(rest, {
      method: "POST",
      url: "/api/services/bevox-web/scale",
      body: { replicas: 3 },
    });
    expect(r.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("applied");
  });

  it("POST /api/dns → set_dns (none-policy) → applied, no approval", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/dns",
      body: { zone: "example.net", name: "api", type: "A", value: "1.2.3.4", ttl: 300 },
    });
    expect(r.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("POST /api/backups/:target/snapshot → snapshot (none-policy) → applied", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/backups/volume:pg-data/snapshot",
      body: {},
    });
    expect(r.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("applied");
  });

  it("POST /api/backups/:target/restore → restore (always-gated) → pending_approval", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/backups/volume:pg-data/restore",
      body: { snapshot: "snap-1" },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("POST /api/destroy → destroy (always-gated) → pending_approval, never auto-destructs", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:app-1" },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  it("POST /api/apply → apply_manifest (conditional, non-sensitive) → applied", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/apply",
      body: { manifest: { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] } },
    });
    expect(r.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("applied");
  });

  // Regression guard for the apply_manifest meta-scope fix:
  // spec docs/specs/2026-05-26-apply-manifest-meta-scope.md §3.2.
  //
  // The existing "POST /api/apply → apply_manifest" test above uses a single
  // makeFakeProvider() injected into the catalog, so observe("manifest")
  // returns an empty entities[] (no entity key starts with "manifest:") —
  // accidentally papering over the production bug. In production, server.ts
  // wires compositeProvider({...}) whose observe("manifest") fell through
  // targetsFor() and threw `unsupported scope/kind "manifest"` on the apply
  // path. The REST route scope literal IS "manifest" (rest.ts route table),
  // which is forwarded into reconcileToEnvelope("manifest", ...). This test
  // reproduces the production wiring (composite + scope="manifest") through
  // the full REST → executeTool path and asserts the precondition no longer
  // fires.
  it("POST /api/apply with dry_run:false and a composite provider does not 400 on scope=manifest (meta-scope)", async () => {
    const provider = compositeProvider({
      network: makeFakeProvider(),
      server: [makeFakeProvider()],
      volume: makeFakeProvider(),
      service: makeFakeProvider(),
    });
    const { rest } = makeServer({ provider });
    const r = await call(rest, {
      method: "POST",
      url: "/api/apply",
      body: {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          servers: [
            {
              name: "app-1",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: false,
      },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    // Sentinel: NEVER the precondition we are fixing.
    expect(env.error?.code).not.toBe("precondition");
    expect(env.error?.message ?? "").not.toMatch(/unsupported scope.kind "manifest"/);
    expect(env.error?.entity).not.toBe("manifest");
    // Acceptance: conditional tool either applied directly OR withheld for
    // approval; never error.
    expect(["applied", "pending_approval"]).toContain(env.status);
  });

  // Spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §9 #1
  // (capstone — enabled by Task 2.2 cross-scope read union):
  // POST a multi-kind manifest, then GET /api/diff?source=working —
  // diff(scope=server) MUST surface the pending plan action for the
  // declared server. The cross-scope union in entrypoint-wiring's
  // loadDesired makes server.network ref resolvable against the
  // network silo, so plan() validates instead of throwing
  // precondition. Pins the bevox-meta-api caminho A unblock.
  it("POST /api/apply (multi-kind) → GET /api/diff?source=working surfaces the per-scope pending plan", async () => {
    const { rest } = makeServer();
    const applyRes = await call(rest, {
      method: "POST",
      url: "/api/apply",
      body: {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          servers: [
            {
              name: "app-1",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: false,
      },
    });
    expect(applyRes.status).toBe(200);
    expect(WriteEnvelopeSchema.parse(applyRes.body).status).toBe("applied");

    // diff route scope is "server" per CONTRACT.md (rest.ts:475).
    // After fan-out + cross-scope union, loadDesired("server") returns
    // {servers:[app-1], networks:[net-a]}; observed empty → plan emits
    // create actions; plan validates server.network ref via the union.
    const diffRes = await call(rest, {
      method: "GET",
      url: "/api/diff?source=working",
    });
    expect(diffRes.status).toBe(200);
    const items = diffRes.body as Array<{ entity: string }>;
    expect(items.some((i) => i.entity === "server:app-1")).toBe(true);
  });
});

// ===========================================================================
// 2. Credential seam — deny-before-write, contract-shaped, no execution
// ===========================================================================

describe("credential seam (4.2) — deny-before-write", () => {
  it("missing Authorization → contract error envelope, 403, NO tool executed", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      token: null,
      body: { entity: "server:app-1" },
    });
    expect(r.status).toBe(403);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
    expect(env.error!.code).toBe("fatal");
    // deny-before-write: NO StateEvent, NO approval row.
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("unknown token → fatal error envelope, 403, no execution", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      token: "nope",
      body: { name: "x", image: "y", replicas: 1 },
    });
    expect(r.status).toBe(403);
    expect(WriteEnvelopeSchema.parse(r.body).error!.code).toBe("fatal");
  });

  it("authenticated but missing the tool capability → fatal error (catalog authz)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "GET",
      url: "/api/state",
      token: "tok-empty",
    });
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
    expect(env.error!.code).toBe("fatal");
    expect(r.status).toBe(403);
  });

  it("never leaks the token in the response body", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      token: "super-secret-token",
      body: { name: "x", image: "y", replicas: 1 },
    });
    expect(JSON.stringify(r.body)).not.toContain("super-secret-token");
  });
});

// ===========================================================================
// 3. Approvals endpoints — list/approve/reject project onto FROZEN schema
// ===========================================================================

describe("approvals endpoints (4.3 webhook/poll path)", () => {
  it("GET /api/approvals → list projected onto ApprovalSchema", async () => {
    const { rest } = makeServer();
    // open a pending approval via an always-gated destroy.
    await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:app-1" },
    });
    const r = await call(rest, { method: "GET", url: "/api/approvals" });
    expect(r.status).toBe(200);
    const list = z.array(ApprovalSchema).parse(r.body);
    expect(list.length).toBe(1);
    expect(list[0]!.status).toBe("pending");
    expect(list[0]!.ttl_remaining).toMatch(/s$/);
  });

  it("POST /api/approvals/:id/approve → approved, projects ApprovalSchema", async () => {
    const { rest } = makeServer();
    const d = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:app-1" },
    });
    const id = (d.body as { approval_id: string }).approval_id;
    const r = await call(rest, {
      method: "POST",
      url: `/api/approvals/${encodeURIComponent(id)}/approve`,
      body: {},
    });
    expect(r.status).toBe(200);
    const ap = ApprovalSchema.parse(r.body);
    expect(ap.status).toBe("approved");
    expect(ap.id).toBe(id);
  });

  it("resolver identity comes from the verified credential (actorOf), NOT the request body", async () => {
    const { rest } = makeServer();
    const d = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:audit-1" },
    });
    const id = (d.body as { approval_id: string }).approval_id;
    // Authenticate as agent:vox but include misleading body actor/resolver
    // fields — they MUST be ignored; the recorded resolver is the verified
    // credential's actor via the brand-guarded actorOf.
    const r = await call(rest, {
      method: "POST",
      url: `/api/approvals/${encodeURIComponent(id)}/approve`,
      token: TOKEN, // resolves to actor "agent:vox"
      body: { actor: "agent:attacker", resolver: "agent:attacker" },
    });
    expect(r.status).toBe(200);
    expect(ApprovalSchema.parse(r.body).status).toBe("approved");
    // The append-only trail records the AUTHENTICATED actor, never the body.
    const row = await pool.query<{ resolver: string }>(
      "SELECT resolver FROM approvals WHERE id = $1",
      [id],
    );
    expect(row.rows[0]!.resolver).toBe("agent:vox");
    expect(row.rows[0]!.resolver).not.toBe("agent:attacker");
  });

  it("POST /api/approvals/:id/reject → rejected (cancelled→rejected projection)", async () => {
    const { rest } = makeServer();
    const d = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:db-1" },
    });
    const id = (d.body as { approval_id: string }).approval_id;
    const r = await call(rest, {
      method: "POST",
      url: `/api/approvals/${encodeURIComponent(id)}/reject`,
      body: { reason: "not now" },
    });
    expect(r.status).toBe(200);
    expect(ApprovalSchema.parse(r.body).status).toBe("rejected");
  });
});

// ===========================================================================
// 4. Routing / fail-safe
// ===========================================================================

describe("routing & fail-safe", () => {
  it("unknown endpoint → 404 with a contract-shaped error envelope", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/nope" });
    expect(r.status).toBe(404);
    expect(WriteEnvelopeSchema.parse(r.body).status).toBe("error");
  });

  it("malformed JSON body → contract error, 400, no execution", async () => {
    const { rest } = makeServer();
    const req = new FakeReq({
      method: "POST",
      url: "/api/services",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // inject a non-JSON body
    (req as unknown as { [Symbol.asyncIterator]: unknown })[
      Symbol.asyncIterator
    ] = async function* () {
      yield Buffer.from("{not json", "utf8");
    };
    const res = new FakeRes();
    await rest.handle(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    await res.done;
    expect(res.statusCode).toBe(400);
    expect(WriteEnvelopeSchema.parse(res.json()).error!.code).toBe(
      "precondition",
    );
  });

  it("an authorized-but-failed write → contract error envelope, mapped status", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/servers",
      body: { name: "", type: "", location: "", network: "" },
    });
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
