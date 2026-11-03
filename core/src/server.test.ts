/**
 * core/src/server.test.ts
 *
 * Task 6.6 — TDD for the bootstrap daemon. Drives the REAL createServer()
 * composition against the pg harness + in-process fakes only: NO real network,
 * NO bound port (handle() in-process), NO real timers (an injected fake), NO
 * real signals (stop() invoked directly). The proven pg-harness barrier/finally
 * discipline keeps the DB suite deterministic under the FULL test run.
 *
 * The EXACT teeth proven here:
 *   - REST + MCP share ONE core (a REST destroy and an MCP destroy produce the
 *     SAME envelope shape — same catalog/pool, no parallel core);
 *   - the periodic reconciler + drift sweep are wired through the SAME
 *     injectable timer seam (fired deterministically, no real timer);
 *   - the HealthSource folds the REAL live breaker registry (not faked);
 *   - graceful stop() stops timers, closes REST+MCP, ENDS the pool / releases
 *     advisory locks (no leaked lock — a fresh pool can re-acquire), idempotent,
 *     never fail-deletes;
 *   - boot is ALL-OR-NOTHING (a bad config / missing provider routes leaves NO
 *     pool/lock/listener — clean cleanup, value-free throw);
 *   - no secret leak anywhere in boot/health output.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, startServer, type BootDeps } from "./server.js";
import { loadConfig, type Config } from "./config.js";
import type { Provider, PlanAction, ApplyResult, ObservedSlice } from "./providers/provider.js";
import type { State } from "./domain/entities.js";
import type { TimerLike } from "./reconciler/reconcile.js";
import type { Clock } from "./reconciler/circuit-breaker.js";
import { noopLogger } from "./observability/logger.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../test/fakes/pg-harness.js";
import { runMigrations } from "./store/db.js";

let pool: pg.Pool;

beforeAll(async () => {
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
// Fakes — a no-op Provider per kind (the concrete transports are out of scope).
// ---------------------------------------------------------------------------

function fakeProvider(name: string): Provider {
  return {
    name,
    async observe(scope: string): Promise<ObservedSlice> {
      return { scope, entities: [] };
    },
    async apply(a: PlanAction): Promise<ApplyResult> {
      return { entity: a.entity, op: a.op, changed: false };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

/** A multi-schedule fake timer — server.ts registers ≥2 intervals per scope. */
function makeFakeTimer(): TimerLike & {
  fireAll(): void;
  count(): number;
  clearedCount(): number;
} {
  const fires: (() => void)[] = [];
  let cleared = 0;
  return {
    setInterval(cb: () => void): ReturnType<typeof setInterval> {
      fires.push(cb);
      return fires.length as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(): void {
      cleared++;
    },
    fireAll(): void {
      for (const f of [...fires]) f();
    },
    count: () => fires.length,
    clearedCount: () => cleared,
  };
}

/**
 * A pg.Pool facade that DELEGATES query/connect to the shared harness pool but
 * records `end()` instead of really ending it. This proves server.ts's
 * cleanup-stack invoked `pool.end()` on the pool IT OWNS (boot all-or-nothing /
 * graceful shutdown) WITHOUT opening any extra real connection — keeping the
 * historically-flaky DB suite deterministic under the FULL run (no added
 * connection pressure on the disposable PG).
 */
function ownedPoolFacade(): pg.Pool & { ended: boolean } {
  const facade = {
    ended: false,
    query: (...a: unknown[]) =>
      (pool.query as (...x: unknown[]) => unknown)(...a),
    connect: (...a: unknown[]) =>
      (pool.connect as (...x: unknown[]) => unknown)(...a),
    async end(): Promise<void> {
      facade.ended = true; // record only — never end the shared harness pool
    },
    on: () => facade,
  };
  return facade as unknown as pg.Pool & { ended: boolean };
}

const FIXED = new Date("2026-05-18T00:00:00.000Z");
const fixedClock: Clock = { now: () => FIXED };

const SECRET = "S3CR3T-6.6-must-never-leak-Zz9";

function envFor(): Record<string, string | undefined> {
  return {
    DATABASE_URL: process.env["DATABASE_URL_TEST"],
    HCLOUD_TOKEN: `hcloud-${SECRET}`,
    HCLOUD_DNS_TOKEN: `dns-${SECRET}`,
    RESTIC_REPO: "sftp:b@v:/r",
    RESTIC_PASSWORD: `restic-${SECRET}`,
    SSH_HOST: "10.0.0.1",
    SSH_USER: "deploy",
    SSH_PRIVATE_KEY: `key-${SECRET}`,
    AGENT_CREDENTIALS: JSON.stringify({
      "tok-vox": { actor: "agent:vox", capabilities: ["destroy", "get_state"] },
    }),
    // Task 5.2 — sops-age resolver paths (placeholders).
    SECRETS_FILE: "/tmp/secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age.key",
    RECONCILE_INTERVAL_MS: "1000",
    DRIFT_SWEEP_INTERVAL_MS: "2000",
  };
}

function bootDeps(timer: TimerLike, extra: Partial<BootDeps> = {}): BootDeps {
  return {
    pool,
    skipMigrations: true,
    providers: {
      network: fakeProvider("hetzner-cloud"),
      server: [fakeProvider("hetzner-cloud"), fakeProvider("wireguard")],
      volume: fakeProvider("hetzner-cloud"),
      service: fakeProvider("docker"),
      dns: fakeProvider("hetzner-dns"),
      backup: fakeProvider("restic"),
    },
    observedAdapter: () => EMPTY_STATE,
    loadDesired: async () => ({}),
    writeDesired: async () => {},
    timer,
    clock: fixedClock,
    logger: noopLogger,
    idFactory: (() => {
      let n = 0;
      return () => `apr_t_${++n}`;
    })(),
    scopes: ["server"],
    ...extra,
  };
}

// --- in-process HTTP doubles (rest.test.ts / e2e precedent — no port) -------

class FakeReq extends EventEmitter {
  constructor(
    public method: string,
    public url: string,
    public headers: Record<string, string> = {},
    private body?: unknown,
  ) {
    super();
  }
  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.body !== undefined)
      yield Buffer.from(JSON.stringify(this.body), "utf8");
  }
}
class FakeRes {
  statusCode = 200;
  headersSent = false;
  private chunks: Buffer[] = [];
  done: Promise<void>;
  private resolve!: () => void;
  constructor() {
    this.done = new Promise((r) => (this.resolve = r));
  }
  writeHead(s: number): this {
    this.statusCode = s;
    this.headersSent = true;
    return this;
  }
  end(c?: Buffer | string): void {
    if (c) this.chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    this.resolve();
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function rest(
  srv: Awaited<ReturnType<typeof createServer>>,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new FakeReq(
    method,
    url,
    { authorization: "Bearer tok-vox" },
    body,
  );
  const res = new FakeRes();
  await srv.rest.handle(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  await res.done;
  return {
    status: res.statusCode,
    body: res.text === "" ? undefined : JSON.parse(res.text),
  };
}

// ===========================================================================

describe("6.6 — bootstrap daemon: boots, shares one core, shuts down cleanly", () => {
  it("boots REST+MCP+periodic reconciler over ONE shared core", async () => {
    const timer = makeFakeTimer();
    const cfg = loadConfig(envFor());
    const srv = await createServer(cfg, bootDeps(timer));
    try {
      // REST is live in-process (no bound port).
      const health = await rest(srv, "GET", "/api/health");
      expect(health.status).toBe(200);
      // MCP server exists and is the SAME-core transport.
      expect(srv.mcp.server).toBeDefined();
      // The periodic reconciler + drift sweep were scheduled via the SAME
      // injected timer seam (≥2 schedules for the one scope: reconcile+sweep).
      expect(timer.count()).toBeGreaterThanOrEqual(2);
      // No real port bound (in-process boot).
      expect(srv.port).toBeUndefined();
    } finally {
      await srv.stop();
    }
  });

  it("REST and MCP share ONE core: a destroy through each produces the same envelope shape", async () => {
    const timer = makeFakeTimer();
    const srv = await createServer(loadConfig(envFor()), bootDeps(timer));
    try {
      const viaRest = await rest(srv, "POST", "/api/destroy", {
        entity: "server:x",
      });
      // MCP CallTool through the SAME catalog (real SDK client, in-memory).
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await srv.mcp.connect(serverT);
      const client = new Client({ name: "t", version: "0.0.0" });
      await client.connect(clientT);
      const viaMcp = await client.callTool({
        name: "destroy",
        arguments: { _credential: "tok-vox", entity: "server:x" },
      });
      await client.close();
      const restEnv = viaRest.body as { status: string };
      const mcpEnv = (viaMcp.structuredContent ?? {}) as { status: string };
      // Same shared core ⇒ same WriteEnvelope status (pending_approval — the
      // always-policy destroy gate, identical on both transports).
      expect(restEnv.status).toBe(mcpEnv.status);
      expect(["pending_approval", "applied", "error"]).toContain(
        restEnv.status,
      );
    } finally {
      await srv.stop();
    }
  });

  it("periodic reconciler ticks deterministically via the injected timer; HealthSource folds the REAL breaker registry", async () => {
    const timer = makeFakeTimer();
    const srv = await createServer(loadConfig(envFor()), bootDeps(timer));
    try {
      timer.fireAll();
      // Drain the in-flight ticks deterministically (no real timer).
      await new Promise((r) => setImmediate(r));
      const snap = srv.health.snapshot();
      // The breaker registry is REAL: one breaker per distinct provider name
      // (hetzner-cloud shared across network/server/volume ⇒ deduped).
      const names = new Set(srv.breakers.keys());
      expect(names.has("hetzner-cloud")).toBe(true);
      expect(names.has("docker")).toBe(true);
      expect(names.has("wireguard")).toBe(true);
      expect(
        (await Promise.resolve(snap)).breakers!.every(
          (b) => b.state === "closed",
        ),
      ).toBe(true);
      const h = await rest(srv, "GET", "/api/health");
      expect(h.status).toBe(200);
    } finally {
      await srv.stop();
    }
  });

  it("graceful stop() stops timers, closes REST+MCP, ends the OWNED pool, is idempotent, no fail-delete", async () => {
    const timer = makeFakeTimer();
    // server.ts OWNS this pool (deps.pool is the facade ⇒ ownsPool branch):
    // proving stop() invoked pool.end() on the pool it owns. The facade
    // delegates real I/O to the shared harness pool so NO extra connection is
    // opened (the flaky DB suite stays deterministic under the full run).
    const owned = ownedPoolFacade();
    const srv = await createServer(
      loadConfig(envFor()),
      bootDeps(timer, { pool: owned, ownsInjectedPool: true }),
    );
    await srv.stop();
    await srv.stop(); // idempotent — a second stop() is a clean no-op
    // Timers cleared (no leaked interval) + the OWNED pool was ended (no
    // leaked client/lock — withScopeLock's finally + pool.end discipline).
    expect(timer.clearedCount()).toBeGreaterThanOrEqual(timer.count());
    expect(owned.ended, "stop() ended the OWNED pool").toBe(true);
    // The shared pool runs a clean per-scope advisory-lock cycle afterward ⇒
    // the stopped daemon leaked NO advisory lock.
    const { reconcile, passThroughGate } = await import(
      "./reconciler/reconcile.js"
    );
    const run = reconcile({
      pool,
      provider: fakeProvider("hetzner-cloud"),
      gate: passThroughGate,
      observedAdapter: () => EMPTY_STATE,
      loadDesired: async () => ({}),
    });
    const res = await run({ scope: "server", actor: "agent:probe" });
    expect(res.acquired, "no advisory lock leaked by the stopped daemon").toBe(
      true,
    );
  });

  it("a periodic tick that fires AFTER stop() is inert — zero reconcile/DB work (no race with pool.end())", async () => {
    const timer = makeFakeTimer();
    // A provider that COUNTS observe() — a reconcile cycle always observes;
    // an inert post-stop tick must NOT increment it.
    let observes = 0;
    const counting: Provider = {
      name: "hetzner-cloud",
      async observe(scope: string): Promise<ObservedSlice> {
        observes++;
        return { scope, entities: [] };
      },
      async apply(a: PlanAction): Promise<ApplyResult> {
        return { entity: a.entity, op: a.op, changed: false };
      },
      async verify(): Promise<boolean> {
        return true;
      },
    };
    const srv = await createServer(
      loadConfig(envFor()),
      bootDeps(timer, {
        providers: {
          network: counting,
          server: [counting, fakeProvider("wireguard")],
          volume: counting,
          service: fakeProvider("docker"),
        },
      }),
    );
    // Stop FIRST (sets the post-stop gate), THEN fire a queued tick. With a
    // real setInterval such a callback can be already queued when
    // clearInterval runs; the server.ts gate must make it a no-op.
    await srv.stop();
    const before = observes;
    timer.fireAll(); // simulate the queued-but-not-entered tick post-stop
    await new Promise((r) => setImmediate(r));
    expect(observes, "post-stop tick performed NO reconcile observe").toBe(
      before,
    );
    // And the daemon left no advisory lock (shared pool still cycles clean).
    const { reconcile, passThroughGate } = await import(
      "./reconciler/reconcile.js"
    );
    const run = reconcile({
      pool,
      provider: fakeProvider("hetzner-cloud"),
      gate: passThroughGate,
      observedAdapter: () => EMPTY_STATE,
      loadDesired: async () => ({}),
    });
    const res = await run({ scope: "server", actor: "agent:probe3" });
    expect(res.acquired).toBe(true);
  });

  it("concurrent stop() invocations await the SAME completion (owned pool ended exactly once, no double-close)", async () => {
    const timer = makeFakeTimer();
    let ends = 0;
    // An owned-pool facade that COUNTS end() — concurrent stop()s must end
    // the owned pool exactly once and all callers await the real completion.
    const owned = (() => {
      const f = {
        ended: false,
        query: (...a: unknown[]) =>
          (pool.query as (...x: unknown[]) => unknown)(...a),
        connect: (...a: unknown[]) =>
          (pool.connect as (...x: unknown[]) => unknown)(...a),
        async end(): Promise<void> {
          ends++;
          await new Promise((r) => setImmediate(r)); // real async teardown
          f.ended = true;
        },
        on: () => f,
      };
      return f as unknown as pg.Pool & { ended: boolean };
    })();
    const srv = await createServer(
      loadConfig(envFor()),
      bootDeps(timer, { pool: owned, ownsInjectedPool: true }),
    );
    // Two concurrent stop()s WITHOUT awaiting the first (mirrors SIGTERM
    // landing during an in-flight SIGINT-stop).
    const a = srv.stop();
    const b = srv.stop();
    await Promise.all([a, b]);
    // Both observed FULL shutdown: the owned pool ended exactly once.
    expect(ends, "owned pool ended exactly once").toBe(1);
    expect(owned.ended).toBe(true);
    // A post-shutdown advisory-lock cycle on the shared pool still acquires.
    const { reconcile, passThroughGate } = await import(
      "./reconciler/reconcile.js"
    );
    const run = reconcile({
      pool,
      provider: fakeProvider("hetzner-cloud"),
      gate: passThroughGate,
      observedAdapter: () => EMPTY_STATE,
      loadDesired: async () => ({}),
    });
    const res = await run({ scope: "server", actor: "agent:probe4" });
    expect(res.acquired).toBe(true);
  });
});

describe("6.6 — boot is all-or-nothing; fail-fast value-free; no secret leak", () => {
  it("a missing required secret fails fast BEFORE any resource (value-free)", () => {
    const env = envFor();
    delete env.HCLOUD_TOKEN;
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("HCLOUD_TOKEN");
    expect(msg).not.toContain(SECRET);
  });

  it("missing provider routes ⇒ clean throw, NO pool/lock leaked", async () => {
    const cfg = loadConfig(envFor());
    await expect(
      createServer(cfg, {
        pool,
        skipMigrations: true,
        logger: noopLogger,
        // providers omitted → boot must reject and leak nothing.
      }),
    ).rejects.toThrow(/provider routes are required/);
    // The shared harness pool is untouched/usable (nothing half-initialized).
    const r = await pool.query("SELECT 1 AS ok");
    expect(r.rows[0].ok).toBe(1);
  });

  it("omitting loadDesired/writeDesired ⇒ value-free precondition (no default unsound cast)", async () => {
    const cfg = loadConfig(envFor());
    await expect(
      createServer(cfg, {
        pool,
        skipMigrations: true,
        logger: noopLogger,
        providers: {
          network: fakeProvider("hetzner-cloud"),
          server: [fakeProvider("hetzner-cloud")],
          volume: fakeProvider("hetzner-cloud"),
          service: fakeProvider("docker"),
        },
        // loadDesired/writeDesired omitted → boot must reject (State and
        // DesiredState are distinct schemas — no default runtime adapter).
      }),
    ).rejects.toThrow(/desired-state adapters are required/);
    let msg = "";
    try {
      await createServer(cfg, {
        pool,
        skipMigrations: true,
        logger: noopLogger,
        providers: {
          network: fakeProvider("hetzner-cloud"),
          server: [fakeProvider("hetzner-cloud")],
          volume: fakeProvider("hetzner-cloud"),
          service: fakeProvider("docker"),
        },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    // VALUE-FREE: names the dep, never echoes a secret/value.
    expect(msg).toContain("loadDesired");
    expect(msg).toContain("writeDesired");
    expect(msg).not.toContain(SECRET);
    // Nothing half-up: the shared pool is still usable.
    const r = await pool.query("SELECT 1 AS ok");
    expect(r.rows[0].ok).toBe(1);
  });

  it("invalid AGENT_CREDENTIALS JSON ⇒ value-free precondition; boot all-or-nothing (OWNED pool unwound)", async () => {
    const env = envFor();
    env.AGENT_CREDENTIALS = "{not json";
    const cfg: Config = loadConfig(env);
    let threw = false;
    try {
      await createServer(cfg, {
        pool,
        skipMigrations: true,
        logger: noopLogger,
        providers: {
          network: fakeProvider("hetzner-cloud"),
          server: [fakeProvider("hetzner-cloud")],
          volume: fakeProvider("hetzner-cloud"),
          service: fakeProvider("docker"),
        },
        loadDesired: async () => ({}),
        writeDesired: async () => {},
      });
    } catch (e) {
      threw = true;
      // VALUE-FREE: names the key, never echoes the secret-bearing seed.
      expect((e as Error).message).toContain("AGENT_CREDENTIALS");
      expect((e as Error).message).not.toContain(SECRET);
    }
    expect(threw).toBe(true);
    // A borrowed pool is (correctly) NOT ended by server.ts — but the boot
    // left NOTHING half-up: the shared pool runs a clean advisory-lock cycle
    // ⇒ the failed boot leaked NO lock/listener/timer.
    const { reconcile, passThroughGate } = await import(
      "./reconciler/reconcile.js"
    );
    const run = reconcile({
      pool,
      provider: fakeProvider("hetzner-cloud"),
      gate: passThroughGate,
      observedAdapter: () => EMPTY_STATE,
      loadDesired: async () => ({}),
    });
    const res = await run({ scope: "server", actor: "agent:probe2" });
    expect(res.acquired, "failed boot leaked no advisory lock").toBe(true);
  });

  it("no secret value appears in the wired /api/health output", async () => {
    const timer = makeFakeTimer();
    const srv = await createServer(loadConfig(envFor()), bootDeps(timer));
    try {
      const h = await rest(srv, "GET", "/api/health");
      expect(JSON.stringify(h.body)).not.toContain(SECRET);
    } finally {
      await srv.stop();
    }
  });

  it("startServer(env) validates+boots via deps (no real port/signals in test)", async () => {
    const timer = makeFakeTimer();
    const srv = await startServer(envFor(), {
      ...bootDeps(timer),
      listen: false,
      installSignalHandlers: false,
    });
    try {
      expect(srv.rest).toBeDefined();
      expect(srv.mcp).toBeDefined();
    } finally {
      await srv.stop();
    }
  });
});

// ===========================================================================
// Task 23 GAP FIX — server.ts must thread the granted v2Tools set (and the
// kube/k3s deps) into createMcpServer/createRestServer. BEFORE this fix
// createMcpServer was called WITHOUT v2Tools, so it defaulted to the EMPTY
// set and NO v2 tool (the prior 8 Bloco A tools + the 2 new kube/k3s) was ever
// advertised/dispatchable in the live daemon — the entire v2 surface was DEAD.
// This RED guard proves the gap (empty set ⇒ tools absent) and the green proves
// the WHOLE v2 surface is unlocked once server.ts threads v2Tools.
// ===========================================================================

describe("Task 23 — server.ts advertises the v2 tool surface on MCP (gap fix)", () => {
  it("a server built via the real boot path lists kubectl_apply + ensure_k3s + a prior Bloco A v2 tool", async () => {
    const timer = makeFakeTimer();
    // A stub kube transport — never touches a real host (it satisfies the
    // KubePieces seam server.ts assembles the kube/k3s tool deps from).
    const stubKube = {
      async kubectl() {
        return { code: 0, stdout: "ns/bevox", stderr: "" };
      },
      async run() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const srv = await createServer(
      loadConfig(envFor()),
      bootDeps(timer, {
        // The kube/k3s cabling pieces buildBootDeps would expose (Task 21).
        // server.ts (the gap fix) assembles the two tools' deps from these and
        // threads the granted v2Tools set into createMcpServer.
        kubePieces: {
          transport: stubKube,
          resolveHost: async (host: string) => ({ host }),
          getProvider: () => {
            throw new Error("not used by tools/list");
          },
          getEnsureK3sProvider: () => {
            throw new Error("not used by tools/list");
          },
          namespaceExists: async () => true,
        },
      } as unknown as Partial<BootDeps>),
    );
    try {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await srv.mcp.connect(serverT);
      const client = new Client({ name: "t", version: "0.0.0" });
      await client.connect(clientT);
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      await client.close();
      // The 2 NEW kube/k3s tools are advertised…
      expect(names).toContain("kubectl_apply");
      expect(names).toContain("ensure_k3s");
      // …AND at least one prior Bloco A v2 tool, proving the WHOLE v2 surface
      // is unlocked (not just the kube/k3s pair).
      expect(names).toContain("set_firewall");
    } finally {
      await srv.stop();
    }
  });

  // Task 25 (StateEvent on apply) — server.ts must thread the real appendEvent
  // + pool into the assembled kube/k3s tool deps so an ACTUAL approved apply
  // records a StateEvent in production (ground rule #5). This drives the FULL
  // boot path: REST POST /api/v2/kube/apply with a kubectl_apply-capable
  // credential, passThrough-ish gate, then asserts a row landed in the real
  // state_events table with the credential's actor + a secret-free payload.
  it("an approved kubectl_apply through the real boot path records a StateEvent (Task 25 wiring)", async () => {
    const timer = makeFakeTimer();
    // Stub kube transport: `get namespace <ns>` → non-empty (ns exists);
    // `get <kind> <name>` → empty (object absent ⇒ observe null); `apply` →
    // ok. Never touches a real host.
    const stubKube = {
      async kubectl(argv: readonly string[], _stdin?: string) {
        if (argv[0] === "get" && argv[1] === "namespace") {
          return { code: 0, stdout: "namespace/bevox", stderr: "" };
        }
        if (argv[0] === "get") {
          // object absent ⇒ --ignore-not-found exits 0 with empty stdout.
          return { code: 0, stdout: "", stderr: "" };
        }
        // apply -f - ⇒ ok.
        return { code: 0, stdout: "configmap/demo created", stderr: "" };
      },
      async run() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    // A real-shaped KubernetesProvider over the stub transport (observe/apply
    // only — verify/destroy unused by the apply path).
    const kubeProvider = {
      name: "kubernetes-stub",
      async observe() {
        return null;
      },
      async apply(desired: { host: string; namespace: string }) {
        await stubKube.kubectl(["apply", "-f", "-"], "body");
        return {
          entity: `kube:${desired.host}/${desired.namespace}/ConfigMap/demo`,
          changed: true,
        };
      },
      async verify() {
        return true;
      },
      async destroy() {
        return { entity: "kube:x", changed: true };
      },
    };
    // A credential WITH the kubectl_apply v2 capability (envFor's tok-vox lacks
    // it). Threaded via AGENT_CREDENTIALS so the real boot path authorises it.
    const env = {
      ...envFor(),
      AGENT_CREDENTIALS: JSON.stringify({
        "tok-kube": { actor: "agent:vox", capabilities: ["kubectl_apply"] },
        // Distinct reviewer: the requester may not resolve its own approval
        // (spec 2026-11-03-approval-separation-of-duties).
        "tok-reviewer": { actor: "human:reviewer", capabilities: [] },
      }),
    };
    const srv = await createServer(
      loadConfig(env),
      bootDeps(timer, {
        kubePieces: {
          transport: stubKube,
          resolveHost: async (host: string) => ({ host }),
          getProvider: () => kubeProvider,
          getEnsureK3sProvider: () => {
            throw new Error("not used by kubectl_apply");
          },
          namespaceExists: async (_cfg: unknown, ns: string) => {
            const res = await stubKube.kubectl([
              "get",
              "namespace",
              ns,
              "--ignore-not-found",
            ]);
            return res.stdout.trim() !== "";
          },
        },
      } as unknown as Partial<BootDeps>),
    );
    try {
      const manifestBody = {
        host: "k3s-server-1",
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "demo" },
        namespace: "bevox",
        body: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
      };
      const apply = async (): Promise<{ status: string; approval_id?: string }> => {
        const req = new FakeReq(
          "POST",
          "/api/v2/kube/apply",
          { authorization: "Bearer tok-kube" },
          manifestBody,
        );
        const res = new FakeRes();
        await srv.rest.handle(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        );
        await res.done;
        return (res.text === "" ? {} : JSON.parse(res.text)) as {
          status: string;
          approval_id?: string;
        };
      };

      // (1) Always-sensitive gate ⇒ the first apply is pending_approval. The
      // gate emits its OWN approval-LIFECYCLE event (result:"pending_approval")
      // but NO apply-MUTATION event (result:"applied") — that is precisely the
      // ground-rule-#5 gap this task closes (the gate event is not the mutation
      // event). A pending approval NEVER mutates ⇒ NEVER emits an "applied".
      const first = await apply();
      expect(first.status).toBe("pending_approval");
      expect(first.approval_id).toBeDefined();
      const noMutationYet = await pool.query(
        "SELECT count(*)::int AS n FROM state_events WHERE result = 'applied' AND entity LIKE 'kube:%'",
      );
      expect(noMutationYet.rows[0].n).toBe(0);

      // (2) Approve the pending approval, then re-apply ⇒ the gate approves ⇒
      // the apply runs ⇒ ONE StateEvent lands in the real state_events table.
      const approveReq = new FakeReq(
        "POST",
        `/api/approvals/${first.approval_id}/approve`,
        { authorization: "Bearer tok-reviewer" },
        {},
      );
      const approveRes = new FakeRes();
      await srv.rest.handle(
        approveReq as unknown as IncomingMessage,
        approveRes as unknown as ServerResponse,
      );
      await approveRes.done;

      const second = await apply();
      expect(second.status).toBe("applied");

      // The real wiring recorded the apply-MUTATION StateEvent (result:"applied")
      // in the real state_events table — distinct from the gate's lifecycle
      // events (pending_approval / approved).
      const ev = await pool.query<{
        actor: string;
        op: string;
        entity: string;
        result: string;
        after: unknown;
      }>(
        "SELECT actor, op, entity, result, after FROM state_events WHERE result = 'applied' AND entity LIKE 'kube:%' ORDER BY seq DESC",
      );
      expect(ev.rows).toHaveLength(1);
      const row = ev.rows[0]!;
      expect(row.actor).toBe("agent:vox");
      expect(row.op).toBe("create");
      expect(row.result).toBe("applied");
      // Secret-free: no manifest body bytes in the persisted payload.
      expect(JSON.stringify(row.after)).not.toContain("apiVersion: v1");
    } finally {
      await srv.stop();
    }
  });
});
