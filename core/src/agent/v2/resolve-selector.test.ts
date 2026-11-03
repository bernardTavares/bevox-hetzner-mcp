/**
 * core/src/agent/v2/resolve-selector.test.ts
 *
 * Task 0.4 — TDD teeth for `resolveServerSelector` and the
 * `POST /api/v2/selectors/resolve` REST surface.
 *
 * Two layers are exercised here:
 *   - PURE: `resolveServerSelector(selector, servers)` against in-memory
 *     `Server[]` — proves grammar (label key-presence, exact name, AND
 *     conjunction, fail-safe on garbage input, determinism).
 *   - REST: `POST /api/v2/selectors/resolve` against observed-state seeded
 *     into the pg harness — proves the wire shape and that the endpoint
 *     reads the SAME observed `Server[]` as `get_state`. The plan's
 *     canonical failing test is the first REST case (`label: app`).
 *
 * The REST surface is authn-gated like every other read (deny-before-write).
 * Body is `{ selector }`; response is the unwrapped `{ matched: string[] }`
 * shape (sorted ascending for determinism).
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

import { ALL_TOOLS } from "../capability.js";
import { createApprovalGate, type Clock } from "../approval-gate.js";
import { createToolCatalog } from "../tools.js";
import { createInjectedCredentialStore } from "../auth.js";
import { createRestServer, type RestServer } from "../rest.js";
import type { ReconcileGate } from "../../reconciler/reconcile.js";
import type { DesiredState } from "../../domain/desired-state.js";
import type { Server, State } from "../../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../../providers/provider.js";
import { putState as putObservedState } from "../../store/observed-store.js";
import {
  getTestPool,
  resetSchema,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations } from "../../store/db.js";
import { resolveServerSelector } from "./resolve-selector.js";

// ---------------------------------------------------------------------------
// PURE helper tests (no DB, no HTTP)
// ---------------------------------------------------------------------------

function mkServer(name: string, labels: Record<string, string> = {}): Server {
  return {
    name,
    type: "cx22",
    location: "nbg1",
    image: "ubuntu-24.04",
    ssh_keys: [],
    labels,
    network: "net-a",
    status: "healthy",
  };
}

describe("Task 0.4 — resolveServerSelector (pure)", () => {
  it("{ label: <key> } matches servers that have that label key (presence-check)", () => {
    const servers = [
      mkServer("s1", { app: "x" }),
      mkServer("s2", {}),
      mkServer("s3", { app: "y" }),
    ];
    expect(resolveServerSelector({ label: "app" }, servers)).toEqual(["s1", "s3"]);
  });

  it("{ name: <name> } matches exact server name only", () => {
    const servers = [mkServer("s1"), mkServer("s2"), mkServer("s10")];
    expect(resolveServerSelector({ name: "s1" }, servers)).toEqual(["s1"]);
    expect(resolveServerSelector({ name: "nonexistent" }, servers)).toEqual([]);
  });

  it("conjunction: multiple keys are AND-ed (every clause must match)", () => {
    const servers = [
      mkServer("s1", { app: "x", region: "eu" }),
      mkServer("s2", { app: "y" }),
      mkServer("s3", { region: "us" }),
    ];
    // label-key "app" presence AND additional label-key "region" presence ⇒
    // only s1 has both (s2 lacks region; s3 lacks app).
    expect(
      resolveServerSelector({ label: "app", region: "eu" }, servers),
    ).toEqual(["s1"]);
    // name + label-key presence (label key only — value ignored)
    expect(
      resolveServerSelector({ name: "s1", label: "region" }, servers),
    ).toEqual(["s1"]);
  });

  it("returns names sorted ascending (deterministic)", () => {
    const servers = [
      mkServer("zeta", { app: "x" }),
      mkServer("alpha", { app: "x" }),
      mkServer("mu", { app: "x" }),
    ];
    expect(resolveServerSelector({ label: "app" }, servers)).toEqual([
      "alpha",
      "mu",
      "zeta",
    ]);
  });

  it("fail-safe: empty/null/garbage selector ⇒ [] (never throws)", () => {
    const servers = [mkServer("s1", { app: "x" })];
    expect(resolveServerSelector({}, servers)).toEqual([]);
    expect(resolveServerSelector(null, servers)).toEqual([]);
    expect(resolveServerSelector(undefined, servers)).toEqual([]);
    // garbage value types
    expect(resolveServerSelector({ label: 42 } as never, servers)).toEqual([]);
    expect(resolveServerSelector({ name: true } as never, servers)).toEqual([]);
  });

  it("empty server list ⇒ [] for any selector", () => {
    expect(resolveServerSelector({ label: "app" }, [])).toEqual([]);
    expect(resolveServerSelector({ name: "s1" }, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REST surface (POST /api/v2/selectors/resolve) — exercises the live wire
// ---------------------------------------------------------------------------

// Minimal in-process IncomingMessage/ServerResponse doubles (mirrors the
// pattern rest.test.ts established — deterministic, no port race).
class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private bodyText: string;
  private sent = false;
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
    this.bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.sent) return;
    this.sent = true;
    if (this.bodyText !== "") yield Buffer.from(this.bodyText, "utf8");
  }
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  chunks: Buffer[] = [];
  ended = false;
  resolveDone!: () => void;
  done: Promise<void>;
  constructor() {
    this.done = new Promise<void>((r) => {
      this.resolveDone = r;
    });
  }
  writeHead(code: number, headers?: Record<string, string | number>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }
  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) {
      this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    this.ended = true;
    this.resolveDone();
  }
  get headersSent(): boolean {
    return this.statusCode !== 0;
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  json(): unknown {
    const t = this.text;
    return t === "" ? undefined : JSON.parse(t);
  }
}

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.query("DELETE FROM observed_state WHERE scope LIKE 'sel-%'");
});

const FIXED = new Date("2026-05-20T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };
const TOKEN = "tok-vox";

function makeFakeProvider(): Provider {
  return {
    name: "fake",
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
}

function observedAdapter(slice: ObservedSlice): State {
  return {
    servers: [],
    networks: [],
    volumes: [],
    services: [],
    dns: [],
    backups: [],
    // slice unused — observed reads in this test go through observed-store
    // directly (the route reads from the seeded pg snapshot).
    ...(slice.scope ? {} : {}),
  };
}

function makeServer(): { rest: RestServer } {
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock,
    idFactory: () => `apr_test_${++idn}`,
  });
  const provider = makeFakeProvider();
  const catalog = createToolCatalog({
    pool,
    provider,
    observedAdapter,
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
    [TOKEN]: { actor: "agent:vox", capabilities: [...ALL_TOOLS] },
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

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

async function seedServers(scope: string, servers: Server[]): Promise<void> {
  await putObservedState(pool, scope, { ...EMPTY_STATE, servers });
}

describe("Task 0.4 — POST /api/v2/selectors/resolve", () => {
  it("resolves { label: app } against current observed Servers (plan's canonical test)", async () => {
    const { rest } = makeServer();
    await seedServers("sel-canonical", [
      mkServer("s1", { app: "x" }),
      mkServer("s2", {}),
    ]);
    const r = await call(rest, {
      method: "POST",
      url: "/api/v2/selectors/resolve?scope=sel-canonical",
      body: { selector: { label: "app" } },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ matched: ["s1"] });
  });

  it("matches the same servers the pure helper would (REST ↔ helper parity)", async () => {
    const { rest } = makeServer();
    const servers = [
      mkServer("alpha", { app: "x", region: "eu" }),
      mkServer("beta", { app: "y" }),
      mkServer("gamma", { region: "us" }),
    ];
    await seedServers("sel-parity", servers);

    // Run several selector cases; assert the REST result equals the pure
    // helper's result on the same fixture (single-source-of-truth invariant
    // the spec-filha §1 calls out).
    for (const selector of [
      { label: "app" },
      { name: "alpha" },
      { label: "region", name: "alpha" },
      {},
      { name: "nonexistent" },
    ]) {
      const r = await call(rest, {
        method: "POST",
        url: "/api/v2/selectors/resolve?scope=sel-parity",
        body: { selector },
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ matched: resolveServerSelector(selector, servers) });
    }
  });

  it("missing/invalid credential ⇒ 403 contract error, NO StateEvent", async () => {
    const { rest } = makeServer();
    await seedServers("sel-authz", [mkServer("s1", { app: "x" })]);
    const r = await call(rest, {
      method: "POST",
      url: "/api/v2/selectors/resolve?scope=sel-authz",
      token: null,
      body: { selector: { label: "app" } },
    });
    expect(r.status).toBe(403);
    const ev = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(ev.rows[0].n).toBe(0);
  });

  it("empty selector ⇒ { matched: [] } (fail-safe)", async () => {
    const { rest } = makeServer();
    await seedServers("sel-empty", [mkServer("s1", { app: "x" })]);
    const r = await call(rest, {
      method: "POST",
      url: "/api/v2/selectors/resolve?scope=sel-empty",
      body: { selector: {} },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ matched: [] });
  });
});
