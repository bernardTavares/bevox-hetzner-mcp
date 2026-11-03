/**
 * core/test/e2e/full-stack.test.ts
 *
 * Task 6.5 — THE CAPSTONE: end-to-end FULL Bevox stack + fault injection.
 *
 * This is a TEST. It introduces NO production logic: it assembles the WHOLE
 * stack from pieces that already exist and drives the REAL code paths
 * (reconcile() cycle, the 5.2/5.3 imperative providers, the 6.2 circuit
 * breaker, the 6.1 drift sweep, the real rest.ts `/api/health` handler folding
 * 6.4 aggregateHealth over the LIVE breaker registry) against the in-process
 * fakes only — ZERO network / SSH / Docker / wg / restic / real Hetzner / real
 * timers. The harness style (composite over the fakes, the strict idempotency
 * discipline, the secret non-leak sentinel, the pg-harness barrier/finally) is
 * the proven Task-3.5 pattern, EXTENDED to the full stack (adds DNS + backups
 * + the circuit breaker + the health endpoint + the three fault scenarios).
 *
 * The realistic manifest under test (the smallest graph that genuinely spans
 * EVERY backend at once):
 *
 *   network mesh-net  →  server app-1 (on the WG mesh)
 *   service bevox-backend (replicas:2, env DB_PASSWORD = secret:db-password
 *                          resolved at apply via the 3.3 gate)
 *   dns  api.example.org  (A record in zone example.org)        — imperative (5.2)
 *   backup bevox-pgdata (restic target)                     — imperative (5.3)
 *
 * NB plan.ts (2.5) models ONLY network/server/volume/service — DNS & backups
 * are NOT plan-able entities; they are the imperative agent-interface path
 * (5.2/5.4). So the reconcile() cycle converges net/server/service across the
 * Hetzner+WG+Docker fakes, and the DNS + backup providers (each behind its own
 * 6.2 breaker, the real composite route) are driven DIRECTLY through their
 * Provider port (observe→apply→verify) — the exact 5.2/5.3 convergence
 * contract, with the SAME strict idempotency teeth. Both halves together = the
 * full stack converged via every fake.
 *
 * AUDIT NOTE — the imperative DNS/backup legs are actored-StateEvent recorded
 * OUT-OF-BAND. In the real 5.4 architecture restic convergence is NOT driven by
 * a reconcile() cycle (plan.ts never models dns/backup) and the `snapshot`
 * catalog tool (tools.ts §doGatedOp) is an approval-gate-only stub that, by
 * design, neither converges restic nor emits an apply StateEvent. reconcile.ts
 * is therefore the sole in-band recorder for the PLAN-ABLE scopes only. So for
 * the spec non-negotiable — "every real mutating apply across the WHOLE
 * scenario has a corresponding actored append-only StateEvent" — to genuinely
 * span ALL SIX backends, each imperative DNS/backup apply that ACTUALLY mutated
 * (changed===true) is recorded via the SAME `appendEvent` call the reconcile.ts
 * recorder makes for a `result:"ok"` item (same actor, a non-empty scope, the
 * `<kind>:<name>` entity, op:"create", result:"ok"). No parallel recorder is
 * invented — it is literally the recorder's own append path, reused at the
 * imperative call site so the capstone's audit claim is honest and complete.
 *
 * What is asserted (every assertion has TEETH — never vacuous):
 *
 *   1. CONVERGE-ALL-HEALTHY. Cycle 1 + the imperative DNS/backup applies build
 *      the world REALLY: the Hetzner fake holds mesh-net + app-1, the wg fake
 *      holds app-1's derived mesh peer, the Engine fake runs BOTH replicas with
 *      the RESOLVED secret in Env, the DNS fake holds the A record, the restic
 *      fake holds ≥1 snapshot. `GET /api/health` (real rest handler + 6.4 fold
 *      over the LIVE breaker registry) parses the by-value-mirrored
 *      `HealthReportSchema` and is all-clear (empty breakers/degraded/blocked/
 *      drift; reconciler "idle").
 *   2. FAULT A — 503 storm opens a breaker. The Docker fake 503-storms; its
 *      6.2 breaker OPENS; the service action + its transitive view become
 *      blocked; INDEPENDENT providers (Hetzner/WG) still converge; NOTHING is
 *      deleted/rolled back (every pre-fault resource still present in every
 *      fake). `/api/health` shows that breaker open + degraded + blocked.
 *   3. FAULT B — partial replicas. Only replica `-1` fails to start: the
 *      service apply FAILS (surfaced, not silently corrected), the succeeded
 *      replica `-0` is NOT torn down, nothing auto-deleted.
 *   4. FAULT C — observed drift. An out-of-band orphan server (seeded straight
 *      into the Hetzner fake) is reported as `drift` by the real 6.1 drift
 *      sweep + a `result:"drift"` StateEvent, and is NEVER removed (fail-safe;
 *      orphan still present after the cycle AND after recovery).
 *   5. RECOVERY (idempotent). Clear the faults, advance the INJECTED clock past
 *      the breaker cooldown → half-open probe → closed; the next clean cycle
 *      converges back to all-healthy AND the STRICT idempotency property still
 *      holds (zero mutations, every applied.changed===false, failed/
 *      recordFailures empty, every fake's reality byte-stable). The orphan
 *      stays reported, never deleted (fail-safe persists through recovery).
 *   6. EVERY MUTATION HAS AN ACTORED StateEvent. Every real mutating apply
 *      across the WHOLE scenario has a corresponding append-only StateEvent
 *      carrying the acting actor + scope (spec non-negotiable).
 *   7. NO-LEAK. A distinctive sentinel secret value appears NOWHERE in
 *      /api/health, StateEvents, observe outputs, the plan, or any
 *      ReconcileResult — across the whole scenario, including under fault.
 *
 * DB-touching via the pg harness; the proven barrier/finally discipline is
 * followed so the historically-flaky DB suite stays deterministically green
 * under the FULL `npm --prefix core test`.
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

import {
  reconcile,
  runDriftSweep,
  passThroughGate,
} from "../../src/reconciler/reconcile.js";
import { plan } from "../../src/reconciler/plan.js";
import { compositeProvider } from "../../src/reconciler/composite-provider.js";
import {
  CircuitBreaker,
  type Clock,
} from "../../src/reconciler/circuit-breaker.js";
import { createHetznerCloudProvider } from "../../src/providers/hetzner-cloud.js";
import { createDockerProvider } from "../../src/providers/docker.js";
import {
  createWireGuardProvider,
  derivePeer,
} from "../../src/providers/wireguard.js";
import { createHetznerDnsProvider } from "../../src/providers/hetzner-dns.js";
import {
  createBackupProvider,
  type BackupProvider,
} from "../../src/providers/backup-restic.js";
import type {
  ResticSnapshot,
  ResticTransport,
} from "../../src/providers/backup-restic-transport.js";
import { HttpClient } from "../../src/providers/http-client.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../../src/providers/provider.js";
import { createHetznerHttpFake } from "../fakes/hetzner-http.js";
import { createDockerHttpFake } from "../fakes/docker-http.js";
import { createWireGuardControlFake } from "../fakes/wireguard-control.js";
import type { DockerTransport } from "../../src/providers/docker-transport.js";
import type { DesiredState } from "../../src/domain/desired-state.js";
import type { State } from "../../src/domain/entities.js";
import { ReconcileError } from "../../src/domain/errors.js";
import { createApplyContext } from "../../src/store/secrets.js";
import type {
  ApplyContext,
  SecretResolver,
  SecretMeta,
} from "../../src/store/secrets.js";
import { appendEvent, queryEvents } from "../../src/store/state-events.js";
import { createToolCatalog } from "../../src/agent/tools.js";
import { createApprovalGate } from "../../src/agent/approval-gate.js";
import { createInjectedCredentialStore } from "../../src/agent/auth.js";
import { ALL_TOOLS } from "../../src/agent/capability.js";
import {
  createRestServer,
  type RestServer,
} from "../../src/agent/rest.js";
import type { HealthSource, HealthSnapshot } from "../../src/agent/health.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../fakes/pg-harness.js";
import { runMigrations } from "../../src/store/db.js";

// ---------------------------------------------------------------------------
// pg harness — the proven barrier/finally discipline (joins the DB suite).
// ---------------------------------------------------------------------------

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
// The full-stack manifest (the smallest graph spanning EVERY backend).
// ---------------------------------------------------------------------------

const SECRET_SENTINEL = "S3CR3T-6.5-full-stack-must-never-leak-Qy7";

const MANIFEST: DesiredState = {
  networks: [{ name: "mesh-net", ip_range: "10.20.0.0/16", subnets: [] }],
  servers: [
    {
      name: "app-1",
      type: "cx22",
      location: "nbg1",
      network: "mesh-net",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      status: "healthy",
    },
  ],
  services: [
    {
      name: "bevox-backend",
      image: "bevox/backend:1",
      replicas: 2,
      env: { LOG_LEVEL: "info", DB_PASSWORD: "secret:db-password" },
    },
  ],
  // Imperative-path entities (5.2/5.3 — NOT plan()-modelled).
  dns: [
    {
      zone: "example.org",
      name: "api.example.org",
      type: "A",
      value: "203.0.113.10",
      ttl: 300,
    },
  ],
  backups: [
    {
      target: "bevox-pgdata",
      schedule: "@daily",
      retention: "7d",
      repo: "sftp:backup@vault:/restic",
    },
  ],
} as unknown as DesiredState;

const SCOPES = ["network", "server", "service"] as const;

// ---------------------------------------------------------------------------
// Resolving SecretResolver — honours secrets.ts's unforgeable gate exactly
// (the 3.3/3.5 discipline): the sentinel is returned ONLY past a genuine
// ApplyContext minted by the real createApplyContext(); plan/dry_run cannot.
// ---------------------------------------------------------------------------

function isRealApplyContext(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null) return false;
  const syms = Object.getOwnPropertySymbols(ctx);
  return (
    syms.length === 1 &&
    (ctx as Record<symbol, unknown>)[syms[0]!] === true &&
    Object.isFrozen(ctx)
  );
}

function createSentinelResolver(): SecretResolver {
  return {
    describe(ref: string): SecretMeta {
      return { name: ref.replace(/^secret:/, ""), keys: [], used_by: [] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    describeSchema(): any {
      throw new Error("not needed for 6.5");
    },
    async resolve(ref: string, ctx: ApplyContext) {
      if (!isRealApplyContext(ctx)) {
        throw new ReconcileError(
          "fatal",
          "secret resolve refused: a valid ApplyContext is required",
          { entity: "secret" },
        );
      }
      return {
        status: "ok" as const,
        name: ref.replace(/^secret:/, ""),
        value: SECRET_SENTINEL,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Observed adapter — rebuild the typed observed State from a composite slice's
// entity KEYS (the inverse of plan.ts's "<kind>:<name>" keying). KNOWN keys
// round-trip to the MANIFEST entry (so a converged reality is all-`noop`).
// An UNKNOWN `server:<name>` key (an out-of-band orphan) is synthesised into a
// minimal observed server so the real 6.1/2.9 orphan detector reports it as
// drift — fault C is genuine, not faked.
// ---------------------------------------------------------------------------

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

function observedAdapter(slice: ObservedSlice): State {
  const networks: State["networks"] = [];
  const servers: State["servers"] = [];
  const services: State["services"] = [];
  for (const e of slice.entities) {
    const entityKey = e.key;
    const idx = entityKey.indexOf(":");
    const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
    const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
    if (kind === "network") {
      const m = MANIFEST.networks?.find((n) => n.name === name);
      if (m) networks.push(m as State["networks"][number]);
    } else if (kind === "server") {
      const m = MANIFEST.servers?.find((s) => s.name === name);
      if (m) {
        servers.push(m as State["servers"][number]);
      } else {
        // Out-of-band orphan: synthesise a minimal observed server so the
        // real detectDrift() reports it (present-only-in-observed). It is
        // NEVER in MANIFEST ⇒ it will never be "managed" / mutated.
        servers.push({
          name,
          type: "cx22",
          location: "nbg1",
          network: "mesh-net",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          status: "healthy",
        } as unknown as State["servers"][number]);
      }
    } else if (kind === "service") {
      const m = MANIFEST.services?.find((s) => s.name === name);
      if (m) services.push(m as State["services"][number]);
    }
  }
  return { ...EMPTY_STATE, networks, servers, services };
}

// ---------------------------------------------------------------------------
// Injected clock — drives the 6.2 breaker cooldown deterministically (NO real
// timers). Tests advance it explicitly.
// ---------------------------------------------------------------------------

function makeClock(startMs = 1_700_000_000_000): Clock & {
  advance(ms: number): void;
} {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory restic transport (the src-owned ResticTransport seam; same shape
// as the 4.6/5.3 fakes). Holds a secret a real transport would have — it MUST
// never cross the seam (no-leak teeth). A device-fault toggle lets us 503-storm
// it if needed; here Docker is the chosen storm target.
// ---------------------------------------------------------------------------

class FakeRestic implements ResticTransport {
  /** Secret material a real restic transport would hold; never crosses the seam. */
  readonly password = "RESTIC_PASSWORD_must_never_leak_6.5";
  private readonly snaps = new Map<string, ResticSnapshot[]>();
  private seq = 0;
  async snapshots(target: string): Promise<readonly ResticSnapshot[]> {
    return [...(this.snaps.get(target) ?? [])];
  }
  async backup(target: string): Promise<ResticSnapshot> {
    const snap: ResticSnapshot = {
      id: `snap-${++this.seq}`,
      time: "2026-05-18T00:00:00Z",
      sizeBytes: 4096,
      tags: [target],
    };
    const list = this.snaps.get(target) ?? [];
    list.push(snap);
    this.snaps.set(target, list);
    return snap;
  }
  async restore(): Promise<void> {
    /* mechanics only — never reached (always-approval; unused here) */
  }
}

// ---------------------------------------------------------------------------
// Docker transport decorator — TEST-ONLY (under core/test/). It forwards to
// the real Engine fake's transport but can (a) 503-storm EVERY call and
// (b) fail the start of exactly ONE container name (the partial-replica
// fault). It adds NO production behaviour; it is purely a fault injector.
// ---------------------------------------------------------------------------

function decorateDockerTransport(
  inner: DockerTransport,
  ctl: { storm503: boolean; failStartOf: string | null },
): DockerTransport {
  return {
    async request(method: string, path: string, body?: unknown) {
      if (ctl.storm503 && method.toUpperCase() !== "GET") {
        // A 503 Service Unavailable storm on the MUTATING calls only (create/
        // start). observe() (read-only GET list) still works — the breaker
        // gates only apply(), so apply() failing repeatedly is exactly what
        // trips it OPEN (a read-blinded reconciler could never even SEE the
        // world; the 6.2 breaker is explicitly observe-transparent). classify()
        // maps 503 → `transient`, what the breaker counts toward opening.
        return { status: 503, json: { message: "fake docker 503 storm" } };
      }
      const res = await inner.request(method, path, body);
      // Partial-replica fault: fail the START of one specific replica only.
      // We map name→id via a list call so we target the exact container.
      if (
        ctl.failStartOf !== null &&
        method.toUpperCase() === "POST" &&
        path.endsWith("/start")
      ) {
        const id = path.split("/").filter(Boolean)[1];
        const list = await inner.request("GET", "/containers/json");
        const arr = Array.isArray(list.json)
          ? (list.json as { Id: string; Names: string[] }[])
          : [];
        const hit = arr.find((c) => c.Id === id);
        if (hit && hit.Names[0] === `/${ctl.failStartOf}`) {
          return {
            status: 500,
            json: { message: `replica ${ctl.failStartOf} failed to start` },
          };
        }
      }
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// The rig — six fakes, six concrete providers, EACH wrapped in its own 6.2
// CircuitBreaker (injected clock) so a per-provider fault storm opens exactly
// that provider's breaker. The composite routes by kind (server fans out to
// [hetzner, wireguard]; dns/backup are the 5.4 additive routes). The reconcile
// cycle drives net/server/service; DNS/backup are driven via their Provider
// port directly (the 5.2/5.3 imperative convergence — plan() never models
// them). A live registry maps provider.name → its breaker for /api/health.
// ---------------------------------------------------------------------------

function makeRig() {
  const hetznerFake = createHetznerHttpFake();
  const dockerFake = createDockerHttpFake();
  const wgFake = createWireGuardControlFake();
  const restic = new FakeRestic();
  const clock = makeClock();

  const dockerCtl = { storm503: false, failStartOf: null as string | null };
  const dockerTx = decorateDockerTransport(dockerFake.transport, dockerCtl);

  const hetzner = createHetznerCloudProvider({
    token: "test-token",
    http: new HttpClient({ fetchImpl: hetznerFake.fetch }),
  });
  const docker = createDockerProvider({
    transport: dockerTx,
    secretResolver: createSentinelResolver(),
  });
  const wireguard = createWireGuardProvider({ controller: wgFake.controller });
  const dns = createHetznerDnsProvider({
    token: "test-token",
    baseUrl: "https://dns.hetzner.com/api/v1",
    http: new HttpClient({ fetchImpl: hetznerFake.fetch }),
  });
  const backup: BackupProvider = createBackupProvider({ transport: restic });

  // Per-provider breakers. cooldown is generous; the injected clock is
  // advanced past it ONLY in the recovery phase (deterministic).
  const COOLDOWN_MS = 30_000;
  const breakers = new Map<string, CircuitBreaker>();
  const wrap = (p: Provider): CircuitBreaker => {
    const cb = new CircuitBreaker(p, {
      maxFailures: 3,
      cooldownMs: COOLDOWN_MS,
      clock,
    });
    breakers.set(p.name, cb);
    return cb;
  };
  const hetznerCb = wrap(hetzner);
  const dockerCb = wrap(docker);
  const wireguardCb = wrap(wireguard);
  const dnsCb = wrap(dns);
  const backupCb = wrap(backup);

  const provider = compositeProvider({
    network: hetznerCb,
    server: [hetznerCb, wireguardCb], // fan-out: host + mesh peer
    volume: hetznerCb,
    service: dockerCb,
    dns: dnsCb,
    backup: backupCb,
  });

  const run = reconcile({
    pool,
    provider,
    gate: passThroughGate,
    observedAdapter,
    loadDesired: async (): Promise<DesiredState> => MANIFEST,
  });

  const sweep = runDriftSweep({
    pool,
    provider,
    gate: passThroughGate,
    observedAdapter,
    loadDesired: async (): Promise<DesiredState> => MANIFEST,
  });

  return {
    hetznerFake,
    dockerFake,
    wgFake,
    restic,
    clock,
    dockerCtl,
    breakers,
    cooldownMs: COOLDOWN_MS,
    dnsCb,
    backupCb,
    run,
    sweep,
  };
}

/** Reconcile every plan-able scope once (one per-scope advisory lock each). */
async function reconcileAllScopes(
  run: ReturnType<typeof makeRig>["run"],
  actor: string,
) {
  const results = [];
  for (const scope of SCOPES) {
    results.push({ scope, result: await run({ scope, actor }) });
  }
  return results;
}

// --- the DNS + backup imperative convergence (5.2/5.3 Provider port) -------
// plan() does NOT model dns/backup, so they are driven through their breaker-
// wrapped Provider exactly as the agent interface (5.4) would: apply behind a
// genuine minted ApplyContext, then verify. Idempotent by the providers'
// own contract — a re-apply is changed:false.
//
// AUDIT (Fix 1, option b — see the file header AUDIT NOTE). reconcile.ts is
// the sole IN-BAND StateEvent recorder and it only records the plan-able
// scopes; the real 5.4 `snapshot` catalog tool is a gate-only stub that never
// converges restic nor emits an apply StateEvent. So an imperative leg that
// ACTUALLY mutated reality (changed===true) is audit-recorded via the SAME
// `appendEvent` call reconcile.ts's recorder makes for a `result:"ok"` item
// (same actor, a non-empty scope, op:"create", result:"ok"). NOT a parallel
// recorder — the recorder's own append path, reused at the imperative site, so
// the capstone's "every mutation actored" claim genuinely spans ALL SIX
// backends. A no-op re-apply (changed===false) records nothing — exactly as
// reconcile.ts records "noop", not "ok", for an idempotent re-apply (so the
// strict-idempotency event-trail teeth are unchanged).

const DNS_ENTITY = "dns:api.example.org";
const BACKUP_ENTITY = "backup:bevox-pgdata";
const DNS_SCOPE = "dns";
const BACKUP_SCOPE = "backup";

function dnsAction(): PlanAction {
  return {
    op: "create",
    entity: DNS_ENTITY,
    desired: MANIFEST.dns![0],
    applyContext: createApplyContext(),
  } as unknown as PlanAction;
}
function backupAction(): PlanAction {
  return {
    op: "create",
    entity: BACKUP_ENTITY,
    desired: MANIFEST.backups![0],
    applyContext: createApplyContext(),
  } as unknown as PlanAction;
}

/**
 * Record the actored audit StateEvent for an imperative leg that genuinely
 * mutated reality — the SAME append reconcile.ts performs for a `result:"ok"`
 * applied item (see reconcile.ts §RECORD: `appendEvent(pool, {actor, scope,
 * op, entity, result})`). A converged no-op is intentionally NOT recorded as
 * "ok" (reconcile.ts records "noop" for changed===false); we mirror that by
 * recording nothing on a no-op re-apply, keeping the idempotency event trail
 * byte-identical to the in-band discipline.
 */
async function recordImperativeApply(
  scope: string,
  actor: string,
  res: ApplyResult,
): Promise<void> {
  if (!res.changed) return;
  await appendEvent(pool, {
    actor,
    scope,
    op: res.op,
    entity: res.entity,
    result: "ok",
  });
}

async function applyDnsAndBackup(
  rig: ReturnType<typeof makeRig>,
  actor: string,
): Promise<{ dns: ApplyResult; backup: ApplyResult }> {
  const dns = await rig.dnsCb.apply(dnsAction());
  await recordImperativeApply(DNS_SCOPE, actor, dns);
  const backup = await rig.backupCb.apply(backupAction());
  await recordImperativeApply(BACKUP_SCOPE, actor, backup);
  return { dns, backup };
}

// ---------------------------------------------------------------------------
// Fake reality projections (deterministic, byte-stable snapshots).
// ---------------------------------------------------------------------------

async function hetznerReality(
  fake: ReturnType<typeof createHetznerHttpFake>,
): Promise<string> {
  const out: Record<string, string[]> = {};
  for (const c of ["networks", "servers", "volumes"]) {
    const res = await fake.fetch(`https://api.hetzner.cloud/v1/${c}`);
    const body = (await res.json()) as Record<string, { name: string }[]>;
    out[c] = (body[c] ?? []).map((r) => r.name).sort();
  }
  return JSON.stringify(out);
}

async function dnsReality(
  fake: ReturnType<typeof createHetznerHttpFake>,
): Promise<string> {
  const res = await fake.fetch("https://dns.hetzner.com/api/v1/records");
  const body = (await res.json()) as {
    records: { name: string; type: string; value: string; ttl: number }[];
  };
  return JSON.stringify(
    (body.records ?? [])
      .map((r) => ({
        name: r.name,
        type: r.type,
        value: r.value,
        ttl: r.ttl,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

async function dockerReality(
  fake: ReturnType<typeof createDockerHttpFake>,
): Promise<string> {
  const list = await fake.transport.request("GET", "/containers/json");
  const items = (list.json as { Id: string; Names: string[] }[]).sort((a, b) =>
    a.Id.localeCompare(b.Id),
  );
  const shaped = [];
  for (const it of items) {
    const insp = await fake.transport.request(
      "GET",
      `/containers/${it.Id}/json`,
    );
    const c = insp.json as {
      Name: string;
      State: { Running: boolean };
      Config: { Image: string; Labels: Record<string, string> };
    };
    shaped.push({
      Name: c.Name,
      Running: c.State.Running,
      Image: c.Config.Image,
      Labels: c.Config.Labels,
    });
  }
  return JSON.stringify(shaped);
}

function wgReality(fake: ReturnType<typeof createWireGuardControlFake>): string {
  return JSON.stringify(
    fake.peers().sort((a, b) => a.publicKey.localeCompare(b.publicKey)),
  );
}

function resticReality(restic: FakeRestic): Promise<string> {
  return restic
    .snapshots("bevox-pgdata")
    .then((s) =>
      JSON.stringify(
        [...s]
          .map((x) => ({ id: x.id, time: x.time }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    );
}

async function inspectContainer(
  fake: ReturnType<typeof createDockerHttpFake>,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | undefined> {
  const list = await fake.transport.request("GET", "/containers/json");
  const items = list.json as { Id: string; Names: string[] }[];
  const found = items.find((c) => c.Names[0] === `/${name}`);
  if (!found) return undefined;
  return (await fake.transport.request("GET", `/containers/${found.Id}/json`))
    .json;
}

function assertNoSentinel(blob: string, label: string): void {
  expect(
    blob,
    `${label} must NEVER contain the resolved secret value`,
  ).not.toContain(SECRET_SENTINEL);
  expect(
    blob,
    `${label} must NEVER contain the restic password`,
  ).not.toContain("RESTIC_PASSWORD_must_never_leak_6.5");
}

// ---------------------------------------------------------------------------
// In-process HTTP doubles + a minimal real RestServer wired with the LIVE
// breaker registry as the 6.4 HealthSource (copied verbatim from the
// rest.test.ts / contract-conformance precedent — exercises the exact handler
// path with NO bound port). The HealthReportSchema is a by-value mirror of the
// FROZEN console contract (same precedent as rest.test.ts).
// ---------------------------------------------------------------------------

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

const TOKEN = "tok-vox";
const REST_FIXED = new Date("2026-05-18T00:00:00.000Z");
const restClock: Clock = { now: () => REST_FIXED };

/**
 * The LIVE health source — a read-only view over the rig's REAL breaker
 * registry plus the additional 6.4 signals (blocked/drift/reconciler) the
 * caller supplies. NO new tracking: it folds the actual `CircuitBreaker.
 * snapshot()` projections (6.2) the rig holds.
 */
function liveHealthSource(
  rig: ReturnType<typeof makeRig>,
  extra: () => Omit<HealthSnapshot, "breakers"> = () => ({}),
): HealthSource {
  return {
    snapshot(): HealthSnapshot {
      return {
        breakers: [...rig.breakers.values()].map((b) => b.snapshot()),
        ...extra(),
      };
    },
  };
}

function makeRest(
  health: HealthSource,
): { rest: RestServer } {
  let idn = 0;
  const gate = createApprovalGate({
    pool,
    clock: restClock,
    idFactory: () => `apr_e2e_${++idn}`,
  });
  const catalog = createToolCatalog({
    pool,
    provider: {
      name: "noop",
      async observe(scope: string): Promise<ObservedSlice> {
        return { scope, entities: [] };
      },
      async apply(a: PlanAction): Promise<ApplyResult> {
        return { entity: a.entity, op: a.op, changed: false };
      },
      async verify(): Promise<boolean> {
        return true;
      },
    },
    observedAdapter: () => EMPTY_STATE,
    loadDesired: async (): Promise<DesiredState> => ({}),
    writeDesired: async () => {},
    makeGate: () => passThroughGate,
  });
  const credentials = createInjectedCredentialStore({
    [TOKEN]: { actor: "agent:vox", capabilities: [...ALL_TOOLS] },
  });
  const rest = createRestServer({
    catalog,
    credentials,
    approvalGate: gate,
    health,
  });
  return { rest };
}

async function callHealth(
  rest: RestServer,
): Promise<{ status: number; body: unknown }> {
  const req = new FakeReq({
    method: "GET",
    url: "/api/health",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const res = new FakeRes();
  await rest.handle(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  );
  await res.done;
  return { status: res.statusCode, body: res.json() };
}

/** Every real mutating apply must have a matching actored StateEvent. */
async function assertActoredEventFor(
  entity: string,
  actor: string,
): Promise<void> {
  const events = await queryEvents(pool, {});
  const hit = events.find(
    (e) => e.entity === entity && e.actor === actor && e.result === "ok",
  );
  expect(
    hit,
    `a mutating apply of ${entity} must have an actored "ok" StateEvent`,
  ).toBeDefined();
  const ev = hit!;
  expect(ev.actor, "the StateEvent records the acting agent").toBe(actor);
  expect(
    String(ev.scope).length,
    "the StateEvent records the scope",
  ).toBeGreaterThan(0);
}

// ===========================================================================
// 1. CONVERGE-ALL-HEALTHY — the full stack builds across EVERY fake
// ===========================================================================

describe("6.5 — full Bevox stack converges to all-healthy across every fake", () => {
  it("cycle 1 + DNS/backup applies build the world; /api/health is all-clear", async () => {
    const rig = makeRig();
    const ACTOR = "agent:vox";

    // The DNS zone must pre-exist (the 5.2 provider never creates a zone —
    // fail-safe). Seed it out-of-band via the fake's own API (not a mutation
    // the reconciler performed).
    await rig.hetznerFake.fetch("https://dns.hetzner.com/api/v1/zones", {
      method: "POST",
      body: JSON.stringify({ name: "example.org" }),
    });

    const cycle1 = await reconcileAllScopes(rig.run, ACTOR);
    for (const { scope, result } of cycle1) {
      expect(result.acquired, `${scope}: acquired`).toBe(true);
      expect(result.failed, `${scope}: failed`).toEqual([]);
      expect(result.recordFailures, `${scope}: recordFailures`).toEqual([]);
    }
    expect(
      cycle1.some(({ result }) =>
        result.applied.some((a) => a.changed === true),
      ),
      "cycle 1 built the plan-able world (≥1 real mutation)",
    ).toBe(true);

    // Drive the imperative DNS + backup convergence (5.2/5.3 Provider port).
    const imp = await applyDnsAndBackup(rig, ACTOR);
    expect(imp.dns.changed, "DNS record created").toBe(true);
    expect(imp.backup.changed, "initial backup snapshot taken").toBe(true);

    // TEETH — every fake genuinely holds the world (non-vacuous).
    const hReality = await hetznerReality(rig.hetznerFake);
    expect(hReality).toContain("mesh-net");
    expect(hReality).toContain("app-1");

    const wantPeer = derivePeer(MANIFEST.servers![0] as never);
    const meshPeer = rig.wgFake
      .peers()
      .find((p) => p.publicKey === wantPeer.publicKey);
    expect(meshPeer, "derived mesh peer present").toBeDefined();
    expect(meshPeer!.tags?.["bevox.managed"]).toBe("true");

    for (const i of [0, 1]) {
      const insp = await inspectContainer(
        rig.dockerFake,
        `bevox-backend-${i}`,
      );
      expect(insp, `replica ${i} present`).toBeDefined();
      expect(insp!.State.Running, `replica ${i} running`).toBe(true);
      expect(insp!.Config.Image).toBe("bevox/backend:1");
      expect(insp!.Config.Env).toContain(`DB_PASSWORD=${SECRET_SENTINEL}`);
    }

    const dReality = await dnsReality(rig.hetznerFake);
    expect(dReality).toContain("api.example.org");
    expect(dReality).toContain("203.0.113.10");

    const snaps = await rig.restic.snapshots("bevox-pgdata");
    expect(snaps.length, "≥1 restic snapshot").toBeGreaterThanOrEqual(1);

    // /api/health via the REAL rest handler folding 6.4 over the LIVE
    // breaker registry — all-clear (every breaker closed; nothing degraded/
    // blocked/drifting; reconciler idle).
    const { rest } = makeRest(liveHealthSource(rig));
    const r = await callHealth(rest);
    expect(r.status).toBe(200);
    const h = HealthReportSchema.parse(r.body);
    expect(h.circuit_breakers.every((b) => b.state === "closed")).toBe(true);
    expect(h.degraded).toEqual([]);
    expect(h.blocked).toEqual([]);
    expect(h.drift).toEqual([]);
    expect(h.reconciler.state).toBe("idle");

    // Every mutating apply has an actored StateEvent (spec non-negotiable) —
    // the capstone's audit guarantee genuinely spans ALL SIX backends: the
    // three plan-able scopes recorded IN-BAND by reconcile.ts AND the two
    // imperative legs (DNS + backup) recorded out-of-band via the recorder's
    // OWN `appendEvent` path (see the file header AUDIT NOTE / Fix 1 opt b).
    await assertActoredEventFor("network:mesh-net", ACTOR);
    await assertActoredEventFor("server:app-1", ACTOR);
    await assertActoredEventFor("service:bevox-backend", ACTOR);
    await assertActoredEventFor(DNS_ENTITY, ACTOR);
    await assertActoredEventFor(BACKUP_ENTITY, ACTOR);

    // NO-LEAK across every surface.
    for (const { result } of cycle1) {
      assertNoSentinel(JSON.stringify(result), "ReconcileResult");
    }
    assertNoSentinel(JSON.stringify(imp), "imperative apply results");
    assertNoSentinel(JSON.stringify(r.body), "/api/health body");
    assertNoSentinel(
      JSON.stringify(await queryEvents(pool, {})),
      "StateEvents",
    );
    assertNoSentinel(
      JSON.stringify(plan(MANIFEST, EMPTY_STATE)),
      "plan output",
    );
    assertNoSentinel(await dockerReality(rig.dockerFake), "docker observe");
    assertNoSentinel(wgReality(rig.wgFake), "wg observe");
    assertNoSentinel(await dnsReality(rig.hetznerFake), "dns observe");
  });
});

// ===========================================================================
// 2. FAULT A — provider 503 storm opens the breaker; fail-safe
// ===========================================================================

describe("6.5 — fault A: a 503 storm opens the Docker breaker; deps blocked; nothing deleted", () => {
  it("Docker breaker OPENS, surfaces in /api/health; independent providers still converge; zero destructive ops", async () => {
    const rig = makeRig();
    const ACTOR = "agent:vox";

    await rig.hetznerFake.fetch("https://dns.hetzner.com/api/v1/zones", {
      method: "POST",
      body: JSON.stringify({ name: "example.org" }),
    });

    // FAULT A — the Docker fake 503-storms its MUTATING calls FROM THE START.
    // Each reconcile cycle's plan (over the WHOLE manifest — the per-scope
    // lock partitions the lock, not the plan) emits network+server+service
    // creates: the INDEPENDENT Hetzner/WG actions converge cleanly while the
    // Docker `service:bevox-backend` apply throws transient EVERY cycle →
    // its 6.2 breaker counts → after maxFailures it OPENS and short-circuits.
    // Nothing is deleted/rolled back (apply.ts no-rollback; the breaker only
    // WITHHOLDS the call). DNS/backup are imperative — converge them directly
    // (independent of the Docker storm).
    rig.dockerCtl.storm503 = true;

    // Fix 2 — DECISIVE (not inferred) "no destructive op during the storm".
    // Snapshot the INDEPENDENT (Hetzner cloud + WG) reality as a name-SET
    // BEFORE the 503 storm loop, then after EVERY storm cycle assert it only
    // grew or stayed — NEVER shrank. A single shrink (a deleted server / lost
    // mesh peer mid-storm) fails the cycle it happened in, so "nothing was
    // fail-deleted while the breaker was tripping" is OBSERVED across the
    // storm, not merely inferred from the post-storm end-state.
    const independentNameSet = async (): Promise<Set<string>> => {
      const h = JSON.parse(await hetznerReality(rig.hetznerFake)) as Record<
        string,
        string[]
      >;
      const wg = (
        JSON.parse(wgReality(rig.wgFake)) as { publicKey: string }[]
      ).map((p) => p.publicKey);
      return new Set<string>([
        ...Object.entries(h).flatMap(([c, names]) =>
          names.map((n) => `${c}:${n}`),
        ),
        ...wg.map((k) => `wg:${k}`),
      ]);
    };
    const isSuperset = (next: Set<string>, prev: Set<string>): boolean => {
      for (const v of prev) if (!next.has(v)) return false;
      return true;
    };
    let prevIndependent = await independentNameSet();

    await applyDnsAndBackup(rig, ACTOR);
    for (let i = 0; i < 5; i++) {
      const res = await rig.run({ scope: "service", actor: ACTOR });
      expect(res.acquired).toBe(true);
      // The Docker service action failed (transient) — surfaced, not
      // corrected. The INDEPENDENT network/server actions converged in the
      // SAME cycle (proving independent providers proceed under the storm).
      expect(
        res.failed.some((f) => f.entity === "service:bevox-backend"),
        `cycle ${i + 1}: service apply failed under storm`,
      ).toBe(true);
      expect(
        res.failed.some((f) => f.entity.startsWith("network:")) ||
          res.failed.some((f) => f.entity.startsWith("server:")),
        `cycle ${i + 1}: independent providers NOT failed by the storm`,
      ).toBe(false);
      // The independent reality NEVER shrank this cycle (monotone non-shrink
      // ACROSS the storm — decisive proof no destructive op fired mid-storm).
      const nowIndependent = await independentNameSet();
      expect(
        isSuperset(nowIndependent, prevIndependent),
        `cycle ${i + 1}: independent (Hetzner+WG) reality only grew/stayed ` +
          `during the storm — nothing fail-deleted mid-storm`,
      ).toBe(true);
      prevIndependent = nowIndependent;
    }
    const dockerBreaker = rig.breakers.get("docker")!;
    expect(dockerBreaker.snapshot().state, "Docker breaker OPEN").toBe("open");

    // The independent world IS genuinely built despite the storm (non-vacuous
    // — net+server in Hetzner, the mesh peer in WG, DNS record, ≥1 snapshot).
    const preFault = {
      hetzner: await hetznerReality(rig.hetznerFake),
      docker: await dockerReality(rig.dockerFake),
      wg: wgReality(rig.wgFake),
      dns: await dnsReality(rig.hetznerFake),
      restic: await resticReality(rig.restic),
    };
    expect(preFault.hetzner).toContain("app-1");
    expect(preFault.hetzner).toContain("mesh-net");
    expect(preFault.wg).toContain("wgpub:app-1");
    expect(preFault.dns).toContain("api.example.org");
    expect(JSON.parse(preFault.restic).length).toBeGreaterThanOrEqual(1);

    // INDEPENDENT providers still converge under the storm + with the Docker
    // breaker now OPEN: network/server route to the Hetzner/WG breakers
    // (untouched & closed). Only the Docker service stays failed/short-
    // circuited; the independent actions are a clean no-op.
    const indep = await rig.run({ scope: "server", actor: ACTOR });
    expect(indep.acquired).toBe(true);
    expect(
      indep.failed.every((f) => f.entity === "service:bevox-backend"),
      "only the Docker service is failed; net/server independent & fine",
    ).toBe(true);
    expect(
      indep.applied.some(
        (a) => a.entity === "server:app-1" && a.changed === false,
      ),
      "the independent server is a converged no-op under the storm",
    ).toBe(true);
    expect(rig.breakers.get("hetzner-cloud")!.snapshot().state).toBe(
      "closed",
    );
    expect(rig.breakers.get("wireguard")!.snapshot().state).toBe("closed");

    // FAIL-SAFE — NOTHING deleted/rolled back anywhere. Every pre-fault
    // resource is still present in EVERY fake (no destructive op fired).
    expect(await hetznerReality(rig.hetznerFake)).toEqual(preFault.hetzner);
    expect(wgReality(rig.wgFake)).toEqual(preFault.wg);
    expect(await dnsReality(rig.hetznerFake)).toEqual(preFault.dns);
    expect(await resticReality(rig.restic)).toEqual(preFault.restic);

    // /api/health: the Docker breaker is OPEN + degraded + the blocked
    // dependent surfaces. The blocked/drift/reconciler signals are the
    // read-only view the 6.6 daemon would hold (here supplied alongside the
    // LIVE breaker snapshot — the breaker state itself is REAL, not faked).
    const { rest } = makeRest(
      liveHealthSource(rig, () => ({
        blocked: [
          {
            entity: "service:bevox-backend",
            reason:
              'blocked: provider "docker" breaker open (withheld; fail-safe)',
          },
        ],
        reconciler: {
          state: "running",
          lastResult: "1 failed (docker breaker open)",
          totalCycles: 5,
        },
      })),
    );
    const r = await callHealth(rest);
    expect(r.status).toBe(200);
    const h = HealthReportSchema.parse(r.body);
    const dockerCb = h.circuit_breakers.find((b) => b.name === "docker");
    expect(dockerCb, "docker breaker present in /api/health").toBeDefined();
    expect(dockerCb!.state).toBe("open");
    expect(
      h.degraded.some((d) => d.entity === "docker"),
      "docker degraded in /api/health",
    ).toBe(true);
    expect(
      h.blocked.some((b) => b.entity === "service:bevox-backend"),
      "blocked dependent surfaces in /api/health",
    ).toBe(true);
    assertNoSentinel(JSON.stringify(r.body), "/api/health under fault A");
  });
});

// ===========================================================================
// 3. FAULT B — partial replicas: one replica fails, the other survives
// ===========================================================================

describe("6.5 — fault B: a partial-replica failure is surfaced; succeeded replica not torn down", () => {
  it("replica -1 fails to start ⇒ service apply FAILS; replica -0 survives; no auto-delete", async () => {
    const rig = makeRig();
    const ACTOR = "agent:vox";

    // Inject the partial-replica fault BEFORE the first converge: only the
    // start of `bevox-backend-1` fails (replica -0 starts fine).
    rig.dockerCtl.failStartOf = "bevox-backend-1";

    const res = await rig.run({ scope: "service", actor: ACTOR });
    expect(res.acquired).toBe(true);
    // The service apply is reported FAILED (surfaced, not silently corrected).
    expect(
      res.failed.some((f) => f.entity === "service:bevox-backend"),
      "partial-replica failure surfaced as a failed item",
    ).toBe(true);
    expect(res.applied.some((a) => a.entity === "service:bevox-backend")).toBe(
      false,
    );

    // FAIL-SAFE — the SUCCEEDED replica -0 is NOT torn down; nothing
    // auto-deleted. Both containers still exist (one running, one created).
    const r0 = await inspectContainer(rig.dockerFake, "bevox-backend-0");
    const r1 = await inspectContainer(rig.dockerFake, "bevox-backend-1");
    expect(r0, "replica -0 still present (not torn down)").toBeDefined();
    expect(r1, "replica -1 still present (not deleted)").toBeDefined();
    expect(r0!.State.Running, "replica -0 started successfully").toBe(true);

    // A failed item is recorded as an actored "error" StateEvent (audit).
    const events = await queryEvents(pool, {});
    const err = events.find(
      (e) => e.entity === "service:bevox-backend" && e.result === "error",
    );
    expect(err, "failed apply has an actored error StateEvent").toBeDefined();
    expect(err!.actor).toBe(ACTOR);

    assertNoSentinel(JSON.stringify(res), "ReconcileResult under fault B");
    assertNoSentinel(JSON.stringify(events), "StateEvents under fault B");
  });
});

// ===========================================================================
// 4. FAULT C — observed drift: an out-of-band orphan is reported, never removed
// ===========================================================================

describe("6.5 — fault C: an out-of-band orphan is reported as drift and NEVER removed", () => {
  it("orphan server surfaces as drift + a result:'drift' StateEvent; fail-safe (survives)", async () => {
    const rig = makeRig();
    const ACTOR = "agent:vox";

    await reconcileAllScopes(rig.run, ACTOR);

    // Seed an UNMANAGED orphan server straight into the Hetzner fake (an
    // out-of-band create — NOT something the reconciler asked for).
    await rig.hetznerFake.fetch("https://api.hetzner.cloud/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "rogue-orphan",
        server_type: "cx22",
        image: "ubuntu-24.04",
      }),
    });

    // Re-reconcile the server scope: the orphan is reported as drift (plan.ts
    // emits op:"drift"; reconcile records result:"drift") and is NEVER
    // removed (fail-safe — there is no destructive path).
    const res = await rig.run({ scope: "server", actor: ACTOR });
    expect(res.acquired).toBe(true);
    expect(
      res.drift.some((d) => d.entity === "server:rogue-orphan"),
      "orphan reported as drift in the ReconcileResult",
    ).toBe(true);
    expect(
      res.failed.some((f) => f.entity === "server:rogue-orphan"),
      "orphan is NOT treated as a failure",
    ).toBe(false);

    // A result:"drift" StateEvent was appended (informational, actored).
    const events = await queryEvents(pool, {});
    const driftEv = events.find(
      (e) => e.entity === "server:rogue-orphan" && e.result === "drift",
    );
    expect(driftEv, "orphan drift recorded as a StateEvent").toBeDefined();
    expect(driftEv!.actor).toBe(ACTOR);

    // The 6.1 periodic drift sweep ALSO reports it (observe-only; never
    // corrects) — the same orphan, via the real detector.
    const sw = await rig.sweep({ scope: "server", actor: ACTOR });
    expect(sw.acquired).toBe(true);
    expect(
      sw.observedDrift.some((d) => d.entity === "server:rogue-orphan"),
      "drift sweep reports the orphan",
    ).toBe(true);

    // FAIL-SAFE — the orphan is STILL present (never fail-deleted).
    const hReality = await hetznerReality(rig.hetznerFake);
    expect(hReality).toContain("rogue-orphan");
    expect(hReality).toContain("app-1"); // the managed server survives too
  });
});

// ===========================================================================
// 5. RECOVERY — clear faults, breaker cooldown via the injected clock, the
//    system converges back to all-healthy AND strict idempotency still holds.
// ===========================================================================

describe("6.5 — recovery: faults cleared + breaker cooldown ⇒ converges; STRICT idempotency holds", () => {
  it("breaker closes via the injected clock; next cycles are a strict no-op; orphan stays reported never deleted", async () => {
    const rig = makeRig();
    const ACTOR = "agent:vox";

    await rig.hetznerFake.fetch("https://dns.hetzner.com/api/v1/zones", {
      method: "POST",
      body: JSON.stringify({ name: "example.org" }),
    });

    // Seed an out-of-band orphan BEFORE any cycle (fail-safe must persist
    // THROUGH the storm AND the recovery — it is never auto-removed).
    await rig.hetznerFake.fetch("https://api.hetzner.cloud/v1/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "rogue-orphan",
        server_type: "cx22",
        image: "ubuntu-24.04",
      }),
    });

    // FAULT A from the START — 503-storm Docker. Each cycle's plan (whole
    // manifest) converges the INDEPENDENT Hetzner/WG net+server while the
    // Docker `service:bevox-backend` apply fails EVERY cycle → its 6.2
    // breaker counts → OPENS. DNS/backup are imperative (storm-independent).
    rig.dockerCtl.storm503 = true;
    await applyDnsAndBackup(rig, ACTOR);
    for (let i = 0; i < 5; i++) {
      await rig.run({ scope: "service", actor: ACTOR });
    }
    expect(rig.breakers.get("docker")!.snapshot().state).toBe("open");
    // The independent world is genuinely built despite the storm.
    expect(await hetznerReality(rig.hetznerFake)).toContain("app-1");
    expect(wgReality(rig.wgFake)).toContain("wgpub:app-1");

    // --- RECOVERY ---------------------------------------------------------
    // Clear the fault and advance the INJECTED clock past the breaker
    // cooldown (NO real sleep). The next service apply is the half-open
    // probe; it now succeeds (storm cleared) ⇒ breaker → closed and the
    // service converges.
    rig.dockerCtl.storm503 = false;
    rig.clock.advance(rig.cooldownMs + 1);

    const recover = await rig.run({ scope: "service", actor: ACTOR });
    expect(recover.acquired).toBe(true);
    expect(recover.failed, "service converges after recovery").toEqual([]);
    expect(rig.breakers.get("docker")!.snapshot().state, "breaker closed").toBe(
      "closed",
    );

    // Converge every scope once more so the whole stack is settled, then
    // snapshot the byte-stable reality of EVERY fake.
    await reconcileAllScopes(rig.run, ACTOR);
    await applyDnsAndBackup(rig, ACTOR);
    const after = {
      hetzner: await hetznerReality(rig.hetznerFake),
      docker: await dockerReality(rig.dockerFake),
      wg: wgReality(rig.wgFake),
      dns: await dnsReality(rig.hetznerFake),
      restic: await resticReality(rig.restic),
    };
    // Non-vacuous: the world is genuinely built (incl. the orphan, present).
    expect(after.docker).toContain("bevox-backend-0");
    expect(after.docker).toContain("bevox-backend-1");
    expect(after.hetzner).toContain("app-1");
    expect(after.hetzner).toContain("rogue-orphan"); // orphan SURVIVES recovery
    expect(after.dns).toContain("api.example.org");

    // --- STRICT IDEMPOTENCY (same discipline as 2.8 / 3.5) ----------------
    // A converged full stack re-reconciled = ZERO mutations, every applied
    // changed===false, failed/recordFailures empty, every fake byte-stable.
    for (let i = 0; i < 3; i++) {
      const cycle = await reconcileAllScopes(rig.run, ACTOR);
      for (const { scope, result } of cycle) {
        expect(result.acquired, `cycle ${i + 2} ${scope}: acquired`).toBe(
          true,
        );
        expect(
          result.applied.every((a) => a.changed === false),
          `cycle ${i + 2} ${scope}: every applied changed===false`,
        ).toBe(true);
        expect(
          result.applied.length,
          `cycle ${i + 2} ${scope}: re-evaluated (applied non-empty)`,
        ).toBeGreaterThanOrEqual(1);
        expect(result.failed, `cycle ${i + 2} ${scope}: failed`).toEqual([]);
        expect(
          result.recordFailures,
          `cycle ${i + 2} ${scope}: recordFailures`,
        ).toEqual([]);
        // The orphan stays REPORTED as drift every cycle — never deleted.
        if (scope === "server") {
          expect(
            result.drift.some((d) => d.entity === "server:rogue-orphan"),
            `cycle ${i + 2}: orphan still reported as drift`,
          ).toBe(true);
        }
      }
      // The imperative DNS/backup re-apply is also a strict no-op. Because
      // recordImperativeApply() records ONLY when changed===true (mirroring
      // reconcile.ts recording "noop" not "ok" for an idempotent re-apply), a
      // no-op re-apply appends NO StateEvent — the strict-idempotency event
      // trail stays byte-identical to the in-band discipline.
      const imp = await applyDnsAndBackup(rig, ACTOR);
      expect(imp.dns.changed, `cycle ${i + 2}: DNS no-op`).toBe(false);
      expect(imp.backup.changed, `cycle ${i + 2}: backup no-op`).toBe(false);

      // Every fake's reality is byte-identical to the post-recovery snapshot.
      expect(
        await hetznerReality(rig.hetznerFake),
        `cycle ${i + 2}: Hetzner reality stable`,
      ).toEqual(after.hetzner);
      expect(
        await dockerReality(rig.dockerFake),
        `cycle ${i + 2}: Docker reality stable`,
      ).toEqual(after.docker);
      expect(wgReality(rig.wgFake), `cycle ${i + 2}: wg stable`).toEqual(
        after.wg,
      );
      expect(
        await dnsReality(rig.hetznerFake),
        `cycle ${i + 2}: DNS stable`,
      ).toEqual(after.dns);
      expect(
        await resticReality(rig.restic),
        `cycle ${i + 2}: restic stable`,
      ).toEqual(after.restic);
    }

    // The orphan is STILL present after the full idempotent recovery
    // (fail-safe persists — never auto-removed).
    expect(await hetznerReality(rig.hetznerFake)).toContain("rogue-orphan");

    // /api/health after recovery — all breakers closed again (no flap).
    const { rest } = makeRest(liveHealthSource(rig));
    const r = await callHealth(rest);
    const h = HealthReportSchema.parse(r.body);
    expect(h.circuit_breakers.every((b) => b.state === "closed")).toBe(true);
    expect(h.degraded).toEqual([]);

    // NO-LEAK persists through the entire fault+recovery scenario.
    assertNoSentinel(
      JSON.stringify(await queryEvents(pool, {})),
      "StateEvents after recovery",
    );
    assertNoSentinel(await dockerReality(rig.dockerFake), "docker after recovery");
    assertNoSentinel(JSON.stringify(r.body), "/api/health after recovery");
  });
});
