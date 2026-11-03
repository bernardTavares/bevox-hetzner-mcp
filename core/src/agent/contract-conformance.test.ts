/**
 * core/src/agent/contract-conformance.test.ts
 *
 * Task 4.6 — CONTRACT CONFORMANCE (downstream truth oracle).
 *
 * Unlike Tasks 4.5 / 4.5b — which parse the real REST output against a
 * BY-VALUE MIRROR of the frozen console schemas (the envelope.ts/errors.ts
 * mirror precedent) — this file imports the **LIVE** console schemas directly
 * from `../../../console/src/api/contract.js`. `contract.ts` is the single
 * downstream source of truth the Console consumes; its only runtime dependency
 * is `zod`, which `core` already has. This is the cross-package oracle that
 * surfaces any drift the by-value mirrors could hide: if a mirror diverged
 * from the live contract, this test fails and the fix is ALWAYS in the core
 * (the contract is frozen — never edited here).
 *
 * Real responses are driven IN-PROCESS through the genuine
 * `createRestServer().handle` path (the exact harness/wiring style of
 * rest.test.ts / rest.secrets.test.ts: injected CredentialStore, ToolCatalog,
 * ApprovalGate, injected clock + id factory, deterministic pg harness, real
 * secrets-describe seam). The parsed thing is the genuine REST output, not a
 * hand-built fixture.
 *
 * Endpoints × LIVE contract schemas asserted:
 *   GET  /api/state                       → StateSchema
 *   GET  /api/diff?source=working         → PlanItemSchema[]
 *   GET  /api/events?actor=               → StateEventSchema[]
 *   GET  /api/health                      → HealthReportSchema
 *   GET  /api/approvals                   → ApprovalSchema[]
 *   GET  /api/secrets                     → SecretSchema[] (.strict, NO value)
 *   POST /api/services dry_run:true       → WriteEnvelopeSchema (planned, plan>0)
 *   POST /api/destroy                     → WriteEnvelopeSchema (pending_approval, apr_)
 *   POST /api/services bad body           → WriteEnvelopeSchema (error + ApiError)
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

// LIVE downstream truth — the actual console contract, not a mirror.
import {
  StateSchema,
  WriteEnvelopeSchema,
  ApprovalSchema,
  HealthReportSchema,
  SecretSchema,
  StateEventSchema,
  PlanItemSchema,
  BackupEntrySchema,
} from "../../../console/src/api/contract.js";

import { ALL_TOOLS } from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import { createToolCatalog } from "./tools.js";
import { createInjectedCredentialStore } from "./auth.js";
import { createRestServer, type RestServer } from "./rest.js";
import { aggregateHealth, type HealthSource } from "./health.js";
import { CircuitBreaker } from "../reconciler/circuit-breaker.js";
import { ReconcileError } from "../domain/errors.js";
import {
  createStubSecretResolver,
  type SecretResolver,
  type SecretMeta,
} from "../store/secrets.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { createBackupProvider } from "../providers/backup-restic.js";
import type {
  ResticSnapshot,
  ResticTransport,
} from "../providers/backup-restic-transport.js";
import { putState as putWorkingState } from "../store/working-store.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

// ===========================================================================
// In-process HTTP request/response doubles (NO port bound) — copied verbatim
// from rest.test.ts so the exact handler path is exercised deterministically.
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
// Network-free catalog/gate fakes (mirror rest.test.ts so REST stays in sync)
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

/** describe()-only resolver: refs/usage metadata, no values ever. */
function makeSecretResolver(): {
  resolver: SecretResolver;
  refs: readonly string[];
} {
  const meta: Record<string, SecretMeta> = {
    "secret:bevox-harness": {
      name: "bevox-harness",
      keys: ["API_KEY", "DB_URL", "JWT_SECRET"],
      used_by: ["service:bevox-harness", "service:bevox-backend"],
    },
    "secret:bevox-web": {
      name: "bevox-web",
      keys: ["SENTRY_DSN"],
      used_by: ["service:bevox-web"],
    },
  };
  return {
    refs: Object.keys(meta),
    resolver: {
      describe(ref: string): SecretMeta {
        const m = meta[ref];
        if (!m) throw new Error(`unknown ref ${ref}`);
        return m;
      },
      describeSchema() {
        return createStubSecretResolver().describeSchema();
      },
      async resolve(): Promise<never> {
        throw new Error("resolve() MUST NOT be called on a read route");
      },
    },
  };
}

/**
 * Minimal in-process restic fake (the src-owned ResticTransport seam, same
 * shape as backup-restic.test.ts). ZERO real restic; deterministic. Used to
 * drive the GENUINE 5.3 BackupProvider behind `GET /api/backups` so the
 * oracle parses a real provider output, not a fabricated fixture. Holds a
 * secret the real transport would have — it MUST never leak into BackupEntry.
 */
class FakeRestic implements ResticTransport {
  /** Secret material a real transport would hold; must never cross the seam. */
  readonly password = "RESTIC_PASSWORD_super_secret";
  private readonly snaps = new Map<string, ResticSnapshot[]>();
  private seq = 0;
  constructor(seed?: Record<string, ResticSnapshot[]>) {
    for (const [t, s] of Object.entries(seed ?? {})) {
      this.snaps.set(t, [...s]);
    }
  }
  async snapshots(target: string): Promise<readonly ResticSnapshot[]> {
    return [...(this.snaps.get(target) ?? [])];
  }
  async backup(target: string): Promise<ResticSnapshot> {
    const snap: ResticSnapshot = {
      id: `snap-${++this.seq}`,
      time: "2026-05-18T00:00:00Z",
      sizeBytes: 1234,
      tags: [target],
    };
    const list = this.snaps.get(target) ?? [];
    list.push(snap);
    this.snaps.set(target, list);
    return snap;
  }
  async restore(): Promise<void> {
    /* mechanics only — never reached without approval (always-policy) */
  }
}

function makeServer(opts?: {
  desiredByScope?: Map<string, DesiredState>;
  secrets?: { resolver: SecretResolver; refs: readonly string[] };
  /** When set, wires the GENUINE 5.3 BackupProvider behind GET /api/backups. */
  backups?: {
    transport: ResticTransport;
    policies: readonly {
      target: string;
      schedule: string;
      retention: string;
      repo: string;
    }[];
  };
  /** When set, wires the OPTIONAL 6.4 health-aggregation seam. */
  health?: HealthSource;
}): { rest: RestServer } {
  const desiredByScope =
    opts?.desiredByScope ?? new Map<string, DesiredState>();
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
  });
  // GET /api/backups wiring: the genuine 5.3 BackupProvider.listBackup over
  // the declared backup policies (the exact shape the agent layer composes).
  const backupsDep = opts?.backups
    ? {
        list: async () => {
          const bp = createBackupProvider({
            transport: opts.backups!.transport,
          });
          return Promise.all(
            opts.backups!.policies.map((p) => bp.listBackup(p)),
          );
        },
      }
    : undefined;
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    secrets: opts?.secrets,
    backups: backupsDep,
    health: opts?.health,
  });
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
// Conformance — real REST output parses against the LIVE console schemas
// ===========================================================================

describe("Task 4.6 — REST conforms to the LIVE console contract.ts", () => {
  it("GET /api/state → StateSchema (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/state" });
    expect(r.status).toBe(200);
    expect(() => StateSchema.parse(r.body)).not.toThrow();
  });

  it("GET /api/diff?source=working → PlanItemSchema[] (live)", async () => {
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

  it("GET /api/events?actor= → StateEventSchema[] (live)", async () => {
    const { rest } = makeServer();
    await call(rest, { method: "GET", url: "/api/health" }); // emit an event
    const r = await call(rest, {
      method: "GET",
      url: "/api/events?actor=agent:vox",
    });
    expect(r.status).toBe(200);
    const events = z.array(StateEventSchema).parse(r.body);
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/health → HealthReportSchema (live, no health seam → placeholder)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/health" });
    expect(r.status).toBe(200);
    // Backward-compat: absent seam ⇒ the 4.4 catalog placeholder body, which
    // still parses the LIVE schema and is all-clear (no flap).
    const h = HealthReportSchema.parse(r.body);
    expect(h.circuit_breakers).toEqual([]);
    expect(h.degraded).toEqual([]);
    expect(h.blocked).toEqual([]);
    expect(h.drift).toEqual([]);
  });

  it("GET /api/health → REAL aggregation under a GENUINE breaker fault parses the LIVE schema with NON-EMPTY content (6.4)", async () => {
    // Drive a GENUINE 6.2 CircuitBreaker to OPEN via real failing applies —
    // the snapshot the aggregator folds is the live breaker projection, not a
    // hand-built fixture.
    const failing: Provider = {
      name: "hetzner-cloud",
      async observe(scope) {
        return { scope, entities: [] };
      },
      async apply(): Promise<ApplyResult> {
        throw new ReconcileError("transient", "upstream 503", {
          entity: "server:db-1",
        });
      },
      async verify() {
        return false;
      },
    };
    const breaker = new CircuitBreaker(failing, {
      maxFailures: 2,
      cooldownMs: 60_000,
      clock,
    });
    for (let i = 0; i < 2; i++) {
      await expect(
        breaker.apply({ op: "create", entity: "server:db-1" } as PlanAction),
      ).rejects.toBeInstanceOf(ReconcileError);
    }
    const snap = breaker.snapshot();
    expect(snap.state).toBe("open"); // genuinely tripped, not faked

    // A read-only HealthSource over the live breaker + the dependent it
    // blocked (apply.ts skip path) + an observed drift + reconciler state.
    const SECRET = "JWT_SECRET_super_secret_value";
    const source: HealthSource = {
      snapshot() {
        return {
          breakers: [snap],
          blocked: [
            {
              entity: "service:bevox-backend",
              reason:
                'blocked: depends on "server:db-1" (breaker open, withheld)',
            },
          ],
          drift: [
            { entity: "server:ghost-1", detail: "present-only-in-observed" },
          ],
          reconciler: {
            state: "running",
            lastCycleAt: FIXED,
            lastResult: "1 failed, 1 blocked",
            nextCycleInMs: 300_000,
            totalCycles: 7,
          },
        };
      },
    };
    const { rest } = makeServer({ health: source });
    const r = await call(rest, { method: "GET", url: "/api/health" });
    expect(r.status).toBe(200);

    // THE TEETH: the genuine REST body parses the LIVE imported schema AND is
    // non-empty under the real fault (a placeholder all-empty body would NOT
    // satisfy these expectations).
    const h = HealthReportSchema.parse(r.body);
    expect(h.circuit_breakers).toEqual([snap]); // exact frozen element shape
    expect(h.circuit_breakers[0]!.state).toBe("open");
    expect(h.degraded).toEqual([
      { entity: "hetzner-cloud", detail: expect.stringContaining("open") },
    ]);
    expect(h.blocked).toEqual([
      {
        entity: "service:bevox-backend",
        reason: expect.stringContaining("breaker open"),
      },
    ]);
    expect(h.drift).toEqual([
      { entity: "server:ghost-1", detail: "present-only-in-observed" },
    ]);
    expect(h.reconciler).toEqual({
      state: "running",
      last_cycle: FIXED.toISOString(),
      last_result: "1 failed, 1 blocked",
      next_cycle_in: "300s",
      total_cycles: 7,
    });

    // No-leak sentinel: even under fault NO secret value appears anywhere in
    // the health body (1.9/3.3 discipline; the source never carries one).
    const flat = JSON.stringify(r.body);
    expect(flat).not.toContain(SECRET);
    expect(flat).not.toContain("password");
  });

  it("GET /api/health denies before snapshot() on a missing credential (deny-before-write, 6.4)", async () => {
    let snapped = false;
    const source: HealthSource = {
      snapshot() {
        snapped = true;
        return {};
      },
    };
    const { rest } = makeServer({ health: source });
    const r = await call(rest, {
      method: "GET",
      url: "/api/health",
      token: null,
    });
    expect(r.status).toBe(403);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
    // The aggregator seam was NEVER touched (authn-gate ran first).
    expect(snapped).toBe(false);
    // No secret/credential hint leaks in the error body.
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("GET /api/health → all-clear healthy snapshot still parses the LIVE schema (no flap, 6.4)", async () => {
    const source: HealthSource = {
      snapshot() {
        return { reconciler: { state: "idle", totalCycles: 0 } };
      },
    };
    const { rest } = makeServer({ health: source });
    const r1 = await call(rest, { method: "GET", url: "/api/health" });
    const r2 = await call(rest, { method: "GET", url: "/api/health" });
    expect(r1.status).toBe(200);
    const h = HealthReportSchema.parse(r1.body);
    expect(h.circuit_breakers).toEqual([]);
    expect(h.degraded).toEqual([]);
    expect(h.blocked).toEqual([]);
    expect(h.drift).toEqual([]);
    expect(h.reconciler).toEqual({
      state: "idle",
      last_cycle: "",
      last_result: "",
      next_cycle_in: "",
      total_cycles: 0,
    });
    // Pure fold ⇒ identical output every call (no flap).
    expect(r2.body).toEqual(r1.body);
  });

  it("aggregateHealth: a closed breaker mid-failure-run is degraded but not blocked (unit, 6.4)", () => {
    // closed breaker with a non-zero consecutive-failure run ⇒ degraded.
    const h = aggregateHealth({
      breakers: [
        { name: "docker", state: "closed", failures: 1, max_failures: 3 },
      ],
    });
    expect(h.degraded).toEqual([
      { entity: "docker", detail: expect.stringContaining("1/3") },
    ]);
    expect(h.blocked).toEqual([]);
    // A fully-closed, zero-failure breaker is NOT degraded (transparent).
    const clear = aggregateHealth({
      breakers: [
        { name: "docker", state: "closed", failures: 0, max_failures: 3 },
      ],
    });
    expect(clear.degraded).toEqual([]);
  });

  it("GET /api/approvals → ApprovalSchema[] (live)", async () => {
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
  });

  it("GET /api/secrets → SecretSchema[] (.strict, NO value, ever)", async () => {
    const { rest } = makeServer({ secrets: makeSecretResolver() });
    const r = await call(rest, { method: "GET", url: "/api/secrets" });
    expect(r.status).toBe(200);
    const items = r.body as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const s of items) {
      // .strict() rejects any value-like field; live schema is the oracle.
      expect(() => SecretSchema.parse(s)).not.toThrow();
      // explicit no-value regression guard (mirrors 1.9/3.3/4.5b).
      expect(s).not.toHaveProperty("value");
    }
  });

  it("POST /api/services dry_run:true → planned WriteEnvelope, plan>0 (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      body: {
        name: "bevox-harness",
        image: "registry/bevox-harness:v12",
        replicas: 1,
        dry_run: true,
      },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan?.length).toBeGreaterThan(0);
  });

  it("POST /api/destroy → pending_approval WriteEnvelope w/ approval_id (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/destroy",
      body: { entity: "server:a" },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });

  // -- Task 5.4 — DNS + backup endpoints, against the LIVE contract ---------

  it("POST /api/dns → set_dns (none-policy) → applied WriteEnvelope (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/dns",
      body: {
        zone: "example.net",
        name: "api",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
      },
    });
    expect(r.status).toBe(200);
    // none-policy: applied directly, NO approval opened (still authz+audited).
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("POST /api/backups/:target/snapshot → none-policy applied WriteEnvelope (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/backups/volume:pg-data/snapshot",
      body: {},
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  it("POST /api/backups/:target/restore → pending_approval w/ apr_ id (live, existing 4.3 gate)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/backups/volume:pg-data/restore",
      body: { snapshot: "snap-1" },
    });
    expect(r.status).toBe(200);
    const env = WriteEnvelopeSchema.parse(r.body);
    // always-policy → routed through the EXISTING 4.3 gate (no parallel
    // approval logic): NOTHING restored, an approval is opened.
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
    const apr = await pool.query(
      "SELECT op, status FROM approvals WHERE op = 'restore'",
    );
    expect(apr.rows.length).toBe(1);
    expect(apr.rows[0].status).toBe("pending");
  });

  it("GET /api/backups → BackupEntrySchema[] via the genuine 5.3 provider (live, NO secret)", async () => {
    const transport = new FakeRestic({
      "pg-data": [
        { id: "snap-1", time: "2026-05-17T00:00:00Z", sizeBytes: 10 },
        { id: "snap-2", time: "2026-05-18T00:00:00Z", sizeBytes: 20 },
      ],
    });
    const { rest } = makeServer({
      backups: {
        transport,
        policies: [
          {
            target: "pg-data",
            schedule: "0 3 * * *",
            retention: "7d",
            repo: "s3:backups/pg-data",
          },
        ],
      },
    });
    const r = await call(rest, { method: "GET", url: "/api/backups" });
    expect(r.status).toBe(200);
    const items = r.body as unknown[];
    expect(items.length).toBe(1);
    for (const item of items) {
      // LIVE contract schema is the oracle — a real provider body, not a
      // fixture. last_run = chronological max snapshot timestamp.
      const entry = BackupEntrySchema.parse(item);
      expect(entry.snapshots.length).toBe(2);
      expect(entry.last_run).toBe("2026-05-18T00:00:00Z");
      // Explicit no-secret/no-password regression guard (5.3 boundary,
      // mirrors the /api/secrets no-value teeth).
      const flat = JSON.stringify(item);
      expect(flat).not.toContain("RESTIC_PASSWORD");
      expect(flat).not.toContain(transport.password);
      expect(item).not.toHaveProperty("password");
    }
  });

  it("GET /api/backups → [] when the backups dep is absent (backward-compatible)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, { method: "GET", url: "/api/backups" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("GET /api/backups denies before listing on a missing credential (deny-before-write)", async () => {
    const { rest } = makeServer({
      backups: {
        transport: new FakeRestic(),
        policies: [
          { target: "x", schedule: "@daily", retention: "7d", repo: "r" },
        ],
      },
    });
    const r = await call(rest, {
      method: "GET",
      url: "/api/backups",
      token: null,
    });
    expect(r.status).toBe(403);
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
  });

  describe("v1 FROZEN — additive v2 must not pollute v1 surface", () => {
    it("ALL_TOOLS length stays 12 byte-for-byte after v2 additions", () => {
      expect(ALL_TOOLS).toHaveLength(12);
    });
  });

  it("error → status:error + ApiError {retryable:boolean} (live)", async () => {
    const { rest } = makeServer();
    const r = await call(rest, {
      method: "POST",
      url: "/api/services",
      body: { bad: true },
    });
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("error");
    expect(env.error).toMatchObject({ retryable: expect.any(Boolean) });
    expect(typeof env.error!.code).toBe("string");
    expect(typeof env.error!.message).toBe("string");
    expect(typeof env.error!.entity).toBe("string");
  });
});
