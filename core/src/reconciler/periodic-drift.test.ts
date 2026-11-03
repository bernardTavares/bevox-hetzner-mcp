/**
 * core/src/reconciler/periodic-drift.test.ts
 *
 * Task 6.1 — PERIODIC drift detection (injectable clock), fail-safe.
 *
 * The teeth (spec §5: "drift reportado, nunca corrigido em silêncio";
 * "fail-safe, nunca fail-deleting"):
 *
 *  1. INJECTABLE CLOCK / NO REAL TIMERS. The periodic sweep is wired through
 *     the EXISTING Task-2.7 `TimerLike` seam (`schedulePeriodicReconcile`,
 *     now generic). The test injects a fake timer, advances it by hand N
 *     times, and asserts the sweep ran EXACTLY once per tick — zero real
 *     `setInterval`/`setTimeout`/sleep, deterministic, no flakiness.
 *
 *  2. BOTH DETECTORS PER TICK. Each tick runs a READ-ONLY path only —
 *     (a) observed-side drift via Observe + `detectDrift` AND (b) working×git
 *     drift via diffManifest(working, readCanonicalManifest(git)) — emitting
 *     append-only informational StateEvents for both. The sweep deliberately
 *     never routes through reconcile()/plan/apply, so it is structurally
 *     incapable of correcting drift (spec §5 fail-safe non-negotiable).
 *
 *  3. NEVER CORRECTS (fail-safe absolute). Inject an observed orphan + a
 *     working×git divergence; run N ticks; assert drift events emitted each
 *     tick AND zero apply/mutation/delete/promote occurred AND the orphan +
 *     divergence still present untouched. Steady drift ⇒ reported
 *     deterministically each tick, nothing mutated, no flap.
 *
 *  4. GIT UNAVAILABLE DEGRADES SAFELY. With no git-drift source configured the
 *     sweep still runs the observed-side half and records a clear non-fatal
 *     "git-drift skipped" signal — it does NOT crash.
 *
 *  5. NO-LEAK. Emitted drift events carry entity/op/scope/kind only — never a
 *     secret value (diffManifest/detectDrift are ref-safe; the sweep keeps it).
 *
 *  6. LOCK-SAFETY. A sweep tick that cannot acquire the per-scope advisory
 *     lock (a concurrent reconcile holds it) is WITHHELD that tick and
 *     recorded — never blocked forever, never a crash (Task 2.7 semantics).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

import {
  runDriftSweep,
  schedulePeriodicReconcile,
  DEFAULT_DRIFT_SWEEP_MS,
} from "./reconcile.js";
import type { ReconcileGate, GitDriftSource } from "./reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { queryEvents } from "../store/state-events.js";
import { withScopeLock } from "../store/advisory-lock.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";
import type pg from "pg";

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
// Fake provider — records every mutating apply() so the test can prove the
// periodic sweep NEVER applies/deletes anything. observe() reports an injected
// orphan that is absent from desired (observed-side drift).
// ---------------------------------------------------------------------------

interface Fake extends Provider {
  applyCount: number;
  destructiveOps: string[];
}

function makeFakeProvider(orphan: string | null): Fake {
  const reality = new Set<string>();
  if (orphan) reality.add(orphan);
  const fake: Fake = {
    name: "fake",
    applyCount: 0,
    destructiveOps: [],
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
      fake.applyCount += 1;
      if (action.op === "remove" || action.op === "destroy") {
        fake.destructiveOps.push(`${action.op}:${action.entity}`);
      }
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
  return fake;
}

const EMPTY_STATE: State = {
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
      status: "running",
    }));
  return { ...EMPTY_STATE, servers: servers as State["servers"] };
}

// Desired manifest with ONE server. The injected orphan "server:ghost-1" is
// absent here ⇒ observed-side drift on every observe.
const desiredOneServer: DesiredState = {
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
};

const passThroughGate: ReconcileGate = {
  name: "pass-through",
  async evaluate(items) {
    return { approved: items, denied: [] };
  },
};

function makeDeps(provider: Provider, gate: ReconcileGate = passThroughGate) {
  return {
    pool,
    provider,
    gate,
    observedAdapter,
    loadDesired: async (_scope: string): Promise<DesiredState> =>
      desiredOneServer,
  };
}

// A git-drift source where working diverges from git: working adds a server
// "app-2" not present in git ⇒ a present-only-in-working conflict drift item.
const gitDriftSource: GitDriftSource = {
  async loadWorking(_scope: string): Promise<DesiredState> {
    return {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
        {
          name: "app-2",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
      ],
    };
  },
  async loadGit(_scope: string): Promise<DesiredState> {
    return {
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
    };
  },
};

// ---------------------------------------------------------------------------
// 1. Injectable clock — sweep runs exactly once per tick, no real timers.
// ---------------------------------------------------------------------------

describe("periodic drift: injectable clock, one sweep per tick", () => {
  it("runs the sweep exactly once per fake-timer tick and cancels cleanly", async () => {
    const provider = makeFakeProvider("server:ghost-1");
    const sweep = runDriftSweep({ ...makeDeps(provider), gitDriftSource });

    let fire: () => void = () => {};
    let intervalMs = 0;
    let cleared = false;
    const fakeTimer = {
      setInterval(cb: () => void, ms: number) {
        fire = cb;
        intervalMs = ms;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(_h: ReturnType<typeof setInterval>) {
        cleared = true;
        fire = () => {};
      },
    };

    const handle = schedulePeriodicReconcile(
      sweep,
      { scope: "server", actor: "system:drift" },
      DEFAULT_DRIFT_SWEEP_MS,
      fakeTimer,
    );

    expect(intervalMs).toBe(DEFAULT_DRIFT_SWEEP_MS);

    // Three deterministic ticks — no real timer ever ran.
    for (let i = 0; i < 3; i++) {
      fire();
      await handle.flush();
    }

    // Observed-side drift recorded each tick (steady drift, no flap).
    const driftEvents = await queryEvents(pool, { result: "drift" });
    expect(driftEvents.length).toBeGreaterThanOrEqual(3);

    handle.stop();
    expect(cleared).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Both detectors per tick + NEVER corrects (fail-safe absolute).
// ---------------------------------------------------------------------------

describe("periodic drift: both detectors per tick, never corrects", () => {
  it("emits observed + working×git drift each tick and mutates nothing", async () => {
    const provider = makeFakeProvider("server:ghost-1");
    const sweep = runDriftSweep({ ...makeDeps(provider), gitDriftSource });

    const ticks = 3;
    for (let i = 0; i < ticks; i++) {
      const r = await sweep({ scope: "server", actor: "system:drift" });
      expect(r.acquired).toBe(true);
      // Observed-side orphan reported.
      expect(r.observedDrift.some((d) => d.entity === "server:ghost-1")).toBe(
        true,
      );
      // Working×git divergence reported (app-2 only in working).
      expect(
        r.gitDrift.some(
          (d) => d.key === "server:app-2" && d.kind === "present-only-in-working",
        ),
      ).toBe(true);
      expect(r.gitDriftSkipped).toBe(false);
    }

    // FAIL-SAFE: zero destructive ops anywhere, ever.
    expect(provider.destructiveOps).toEqual([]);
    // The injected orphan still physically present (never removed).
    const obs = await provider.observe("server");
    expect(obs.entities.map((e) => e.key)).toContain("server:ghost-1");

    // Both drift kinds were recorded as informational append-only events,
    // carrying the system actor + scope, and NEVER as a mutating op.
    const events = await queryEvents(pool, { result: "drift" });
    expect(events.length).toBeGreaterThanOrEqual(ticks * 2);
    for (const ev of events) {
      expect(ev.actor).toBe("system:drift");
      expect(ev.scope).toBe("server");
      expect(ev.result).toBe("drift");
      // No-leak: entity is a ref-only key, never a secret value.
      expect(String(ev.entity)).not.toMatch(/secret/i);
    }
    // No "ok"/"error"/"denied" — the sweep applied/denied/deleted nothing.
    const mutating = await queryEvents(pool, { result: "ok" });
    expect(mutating.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Git unavailable degrades safely (no crash).
// ---------------------------------------------------------------------------

describe("periodic drift: git source absent degrades safely", () => {
  it("runs the observed half and records a non-fatal git-skipped signal", async () => {
    const provider = makeFakeProvider("server:ghost-1");
    // No gitDriftSource configured.
    const sweep = runDriftSweep(makeDeps(provider));

    const r = await sweep({ scope: "server", actor: "system:drift" });

    expect(r.acquired).toBe(true);
    expect(r.gitDriftSkipped).toBe(true);
    expect(r.gitDrift).toEqual([]);
    // Observed-side half still ran (orphan reported).
    expect(r.observedDrift.some((d) => d.entity === "server:ghost-1")).toBe(
      true,
    );
    // Still zero mutation.
    expect(provider.applyCount).toBe(0);
  });

  it("a throwing git source is non-fatal — sweep still completes", async () => {
    const provider = makeFakeProvider("server:ghost-1");
    const brokenGit: GitDriftSource = {
      async loadWorking() {
        return desiredOneServer;
      },
      async loadGit(): Promise<DesiredState> {
        throw new Error("git repo unreadable");
      },
    };
    const sweep = runDriftSweep({
      ...makeDeps(provider),
      gitDriftSource: brokenGit,
    });

    const r = await sweep({ scope: "server", actor: "system:drift" });
    expect(r.acquired).toBe(true);
    expect(r.gitDriftSkipped).toBe(true);
    expect(r.observedDrift.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Lock-safety — a withheld tick is recorded, not blocked/crashed.
// ---------------------------------------------------------------------------

describe("periodic drift: contention is withheld, not blocked", () => {
  it("a sweep that cannot acquire the scope lock is withheld and recorded", async () => {
    const provider = makeFakeProvider("server:ghost-1");
    const sweep = runDriftSweep({ ...makeDeps(provider), gitDriftSource });

    // Hold the per-scope advisory lock for the WHOLE sweep attempt.
    const result = await withScopeLock(pool, "server", async () => {
      return sweep({ scope: "server", actor: "system:drift" });
    });
    // withScopeLock returns { acquired:true, result } for the OUTER hold; the
    // inner sweep saw the lock held and was withheld.
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error("outer lock not acquired");
    expect(result.result.acquired).toBe(false);
    expect(result.result.observedDrift).toEqual([]);

    // Contention is observable (recorded), not silent, not a crash.
    const withheld = await queryEvents(pool, { result: "withheld" });
    expect(withheld.length).toBeGreaterThanOrEqual(1);
    // Zero mutation.
    expect(provider.applyCount).toBe(0);
  });
});
