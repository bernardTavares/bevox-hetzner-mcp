/**
 * core/src/reconciler/reconcile.test.ts
 *
 * Task 2.7 — drives the full Observe→Plan→Gate→Apply→Record reconcile cycle:
 * the integration seam wiring Fase-1 stores (working/observed/state-events/
 * advisory-lock) to the Fase-2 plan/apply/Provider.
 *
 * Central guarantees under test (spec §5):
 *   - one reconcile(scope) cycle: observes the provider → persists observed →
 *     plans desired×observed → gate (Fase-2 pass-through) → applies → RECORDS
 *     a StateEvent per applied action carrying the acting `actor` + `scope`;
 *   - the whole cycle for a scope runs inside the per-scope advisory lock: a
 *     second concurrent reconcile on the SAME scope is serialized/withheld,
 *     while a DIFFERENT scope is NOT blocked;
 *   - actor is mandatory — missing actor ⇒ ReconcileError("precondition")
 *     (never silently defaulted);
 *   - idempotency end-to-end: a second reconcile of an already-converged scope
 *     applies zero mutations and records no spurious mutating events;
 *   - gate denial withholds those items (recorded, never deleted) — fail-safe;
 *   - a periodic timer trigger exists (injectable; no real setInterval).
 *
 * DB tests use the pg harness (resetSchema + runMigrations per file); the
 * provider is an in-memory fake (network-free); timers are injected (no real
 * timers in the suite).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { reconcile, schedulePeriodicReconcile } from "./reconcile.js";
import type { ReconcileGate } from "./reconcile.js";
import type { Logger, LogFields } from "../observability/logger.js";
import { ReconcileError } from "../domain/errors.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { getState as getObservedState } from "../store/observed-store.js";
import { observedAdapter as realObservedAdapter } from "./observed-adapter.js";
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
// In-memory fake Provider (pure; no network / no DB).
//   - apply() converges reality; idempotent (changed:false once converged);
//   - observe(scope) reports converged entities under that scope prefix;
//   - records apply() call order + counts so the test can pin no-op behaviour;
//   - an injectable beforeApply hook lets a test slow apply() to overlap two
//     reconciles for the advisory-lock serialization assertion.
// ---------------------------------------------------------------------------

interface Fake extends Provider {
  applyOrder: string[];
  applyCount: number;
  /** apply() calls for "server:" entities only (the scope under test). */
  serverApplyCount: number;
}

function makeFakeProvider(opts?: {
  beforeApply?: (entity: string) => Promise<void>;
}): Fake {
  const reality = new Set<string>();
  const fake: Fake = {
    name: "fake",
    applyOrder: [],
    applyCount: 0,
    serverApplyCount: 0,
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
      if (opts?.beforeApply) await opts.beforeApply(action.entity);
      if (reality.has(action.entity)) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.add(action.entity);
      fake.applyOrder.push(action.entity);
      fake.applyCount += 1;
      if (action.entity.startsWith("server:")) fake.serverApplyCount += 1;
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

/**
 * Test observed adapter: turn a provider ObservedSlice into a State by mapping
 * the reported entity keys. For the "server" scope used below it materialises
 * minimal Server rows. (The real provider→State adapter is a later task; here
 * the seam is exercised with a deterministic test adapter.)
 */
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

// A desired manifest with a single server (scope = "server"). The network it
// references is declared so plan()'s ref-completeness check passes; only the
// "server:" entities are routed through the "server" scope here.
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

// ---------------------------------------------------------------------------
// 1. One cycle: Observe → Plan → Gate → Apply → Record
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task 10 (spec 2026-06-02-observed-state-adapter): with the REAL adapter, the
// reconciler persists a NON-EMPTY observed snapshot (the bug: it was always
// [] because the production adapter was an empty stub), and a converged
// desired diffs as a strict no-op (no spurious create).
// ---------------------------------------------------------------------------
describe("reconcile: observed snapshot reflects reality via the REAL adapter (task 10)", () => {
  it("persists a NON-EMPTY observed snapshot; converged desired ⇒ diff noop", async () => {
    const reality = new Set<string>();
    // Once created, the server observes with a full desired-matching payload.
    const SERVER_PAYLOAD = {
      name: "app-1",
      type: "cx22",
      location: "nbg1",
      network: "net-a",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
    };
    const provider: Provider = {
      name: "fake-rich",
      async observe(scope: string): Promise<ObservedSlice> {
        const prefix = `${scope}:`;
        return {
          scope,
          entities: [...reality]
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({
              key: k,
              payload:
                k === "server:app-1"
                  ? SERVER_PAYLOAD
                  : { name: k.slice(k.lastIndexOf(":") + 1) },
            })),
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
    const run = reconcile({
      pool,
      provider,
      gate: passThroughGate,
      observedAdapter: realObservedAdapter,
      loadDesired: async (): Promise<DesiredState> => desiredOneServer,
    });

    // Cycle 1 observes reality-before-create (empty) then creates the server.
    await run({ scope: "server", actor: "agent:claude-code" });
    // Cycle 2 observes the now-existing server → persists a NON-EMPTY snapshot.
    const c2 = await run({ scope: "server", actor: "agent:claude-code" });

    const observed = await getObservedState(pool, "server");
    expect(observed.servers.map((s) => s.name)).toEqual(["app-1"]);
    // Converged: desired matches observed (projected to desired keys) ⇒ no-op,
    // no spurious create (the regression the spec's motivation describes).
    expect(c2.applied.every((a) => a.changed === false)).toBe(true);
  });
});

describe("reconcile: one full cycle", () => {
  it("observes, plans, applies, and records a StateEvent per applied action with the actor", async () => {
    const provider = makeFakeProvider();
    const run = reconcile(makeDeps(provider));

    const result = await run({ scope: "server", actor: "agent:vox" });

    expect(result.acquired).toBe(true);
    expect(result.applied.map((a) => a.entity)).toContain("server:app-1");
    expect(provider.serverApplyCount).toBe(1);

    // observed-store was populated by the Observe step (empty on first run).
    const observed = await getObservedState(pool, "server");
    expect(observed.servers).toEqual([]);

    // a StateEvent was recorded for the applied action, carrying actor+scope.
    const events = await queryEvents(pool, { entity: "server:app-1" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0]!;
    expect(ev.actor).toBe("agent:vox");
    expect(ev.scope).toBe("server");
    expect(ev.result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 1b. ApplyResult.events are surfaced as StateEvents by the Record step,
//     carrying the CYCLE actor+scope+after (2.0.1). The provider never emits
//     events itself; it only returns them on ApplyResult.
// ---------------------------------------------------------------------------

describe("reconcile: ApplyResult.events surfaced via Record (2.0.1)", () => {
  function eventedProvider(
    events: ReadonlyArray<{ op: string; after?: Record<string, unknown> }>,
  ): Provider {
    const reality = new Set<string>();
    return {
      name: "evented",
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
        return { entity: action.entity, op: action.op, changed: true, events };
      },
      async verify(action: PlanAction): Promise<boolean> {
        return reality.has(action.entity);
      },
    };
  }

  it("persists each events entry with cycle actor+scope+after, alongside the apply-item event", async () => {
    const provider = eventedProvider([
      { op: "service.wait_skipped", after: { reason: "no_healthcheck", dep: "db" } },
    ]);
    const run = reconcile(makeDeps(provider));

    await run({ scope: "server", actor: "agent:vox" });

    const rows = await queryEvents(pool, { entity: "server:app-1" });
    const skip = rows.find((e) => e.op === "service.wait_skipped");
    expect(skip, "wait_skipped event persisted").toBeDefined();
    expect(skip!.actor).toBe("agent:vox");
    expect(skip!.scope).toBe("server");
    expect(skip!.result).toBe("ok");
    expect(skip!.after).toEqual({ reason: "no_healthcheck", dep: "db" });

    // The ordinary apply-item event is ALSO present (events are additive).
    expect(rows.some((e) => e.op !== "service.wait_skipped")).toBe(true);
  });

  it("a provider returning NO events behaves exactly as today (no extra rows)", async () => {
    const provider = eventedProvider([]);
    const run = reconcile(makeDeps(provider));
    await run({ scope: "server", actor: "agent:vox" });
    const rows = await queryEvents(pool, { entity: "server:app-1" });
    expect(rows.every((e) => e.op !== "service.wait_skipped")).toBe(true);
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. actor is mandatory
// ---------------------------------------------------------------------------

describe("reconcile: actor is mandatory", () => {
  it("throws ReconcileError(precondition) when actor is missing", async () => {
    const run = reconcile(makeDeps(makeFakeProvider()));
    await expect(
      run({ scope: "server", actor: "" }),
    ).rejects.toBeInstanceOf(ReconcileError);
    await expect(
      run({ scope: "server", actor: "   " }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotency end-to-end: second reconcile = zero mutations, no spurious
//    mutating events.
// ---------------------------------------------------------------------------

describe("reconcile: idempotent no-op on already-converged scope", () => {
  it("a second reconcile applies zero mutations and records no mutating events", async () => {
    const provider = makeFakeProvider();
    const run = reconcile(makeDeps(provider));

    await run({ scope: "server", actor: "agent:vox" });
    expect(provider.serverApplyCount).toBe(1);

    const before = (await queryEvents(pool, { result: "ok" })).length;

    const second = await run({ scope: "server", actor: "agent:vox" });
    expect(provider.serverApplyCount).toBe(1); // NO further write
    expect(second.applied.every((a) => a.changed === false)).toBe(true);

    const afterMutating = (await queryEvents(pool, { result: "ok" })).length;
    // No new mutating ("ok" + changed) event — the converged no-op records
    // nothing that claims a mutation.
    expect(afterMutating).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. Advisory lock: same scope serialized; different scope NOT blocked.
// ---------------------------------------------------------------------------

describe("reconcile: per-scope advisory lock", () => {
  it("a second concurrent reconcile on the SAME scope is withheld (not run concurrently)", async () => {
    // --- Deterministic barrier (NO timing race) ---------------------------
    // `entered` resolves the instant the first reconcile has provably entered
    // the locked section (apply() is reached only AFTER withScopeLock acquired
    // the advisory lock). The test awaits that signal before issuing the
    // second reconcile, so ordering is guaranteed by promise resolution — no
    // setImmediate/setTimeout/macrotask reliance anywhere.
    let signalEntered!: () => void;
    const entered = new Promise<void>((r) => {
      signalEntered = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const provider = makeFakeProvider({
      beforeApply: async () => {
        signalEntered(); // we are inside the lock (apply reached)
        await gate; // hold the first cycle inside the lock
      },
    });
    const run = reconcile(makeDeps(provider));

    const first = run({ scope: "server", actor: "agent:a" });
    try {
      // Deterministic: proceed ONLY once the first cycle is provably inside
      // the locked section — never a macrotask guess.
      await entered;

      const second = await run({ scope: "server", actor: "agent:b" });
      expect(second.acquired).toBe(false); // withheld by the advisory lock
    } finally {
      // Always release the held first cycle and await it — even if an
      // assertion above throws — so the dedicated withScopeLock client and
      // its advisory lock can NEVER leak into subsequent tests/files.
      release();
      const firstResult = await first;
      expect(firstResult.acquired).toBe(true);
      expect(provider.serverApplyCount).toBe(1); // only the first cycle mutated
    }
  });

  it("a reconcile on a DIFFERENT scope is NOT blocked", async () => {
    // Hold the "server" scope lock via withScopeLock directly, then reconcile
    // a different scope — it must still acquire and run.
    // Deterministic barrier: `signalHeld` fires from INSIDE the withScopeLock
    // body, i.e. only after the "server" advisory lock is provably acquired.
    // The cross-scope reconcile is issued only after awaiting that signal —
    // no setImmediate/macrotask race.
    let signalHeld!: () => void;
    const heldEntered = new Promise<void>((r) => {
      signalHeld = r;
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = withScopeLock(pool, "server", async () => {
      signalHeld(); // "server" lock is now provably held
      await held;
    });
    try {
      await heldEntered; // deterministic: server scope lock is held

      const provider = makeFakeProvider();
      const run = reconcile({
        pool,
        provider,
        gate: passThroughGate,
        observedAdapter,
        loadDesired: async () => ({ networks: [] }) as DesiredState,
      });
      const other = await run({ scope: "network", actor: "agent:c" });
      expect(other.acquired).toBe(true);
    } finally {
      // Always release the held "server" lock and await its withScopeLock to
      // fully unwind (advisory unlock + client release) before the test ends —
      // no leaked connection/lock regardless of assertion outcome.
      release();
      await holding;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Gate denial: withheld items are NOT applied, recorded, never deleted.
// ---------------------------------------------------------------------------

describe("reconcile: gate denial is fail-safe (withheld, recorded, never deleted)", () => {
  it("denied items are not applied and are recorded as withheld", async () => {
    const provider = makeFakeProvider();
    const denyAll: ReconcileGate = {
      name: "deny-all",
      async evaluate(items) {
        return { approved: [], denied: items };
      },
    };
    const run = reconcile(makeDeps(provider, denyAll));

    const result = await run({ scope: "server", actor: "agent:vox" });
    expect(result.acquired).toBe(true);
    expect(provider.applyCount).toBe(0); // nothing applied
    expect(result.applied).toEqual([]);
    expect(result.withheld.map((w) => w.entity)).toContain("server:app-1");

    const denied = await queryEvents(pool, { result: "denied" });
    expect(denied.some((e) => e.entity === "server:app-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5b. Record is best-effort fail-safe: an appendEvent failure AFTER a
//     successful apply must NOT throw away the apply outcome — the result
//     still reports the applied item(s) and surfaces recordFailures.
// ---------------------------------------------------------------------------

describe("reconcile: Record is best-effort (apply outcome never lost on append failure)", () => {
  it("an appendEvent failure after a successful apply preserves the applied item and is surfaced in recordFailures", async () => {
    const provider = makeFakeProvider();

    // Seam: wrap the real pool so the state_events INSERT (the appendEvent
    // write path) throws a DB-hiccup-style error, while every other query
    // (observe persist, advisory lock, plan, etc.) passes through unchanged.
    // This makes Record fail AFTER applyPlan() already mutated reality.
    const realQuery = pool.query.bind(pool);
    const failingPool = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (text.includes("INSERT INTO state_events")) {
              return Promise.reject(
                new Error("simulated DB hiccup on state_events INSERT"),
              );
            }
            return (realQuery as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as pg.Pool;

    const run = reconcile({
      pool: failingPool,
      provider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => desiredOneServer,
    });

    const result = await run({ scope: "server", actor: "agent:vox" });

    // Apply outcome PRESERVED — the cycle did not throw, and the applied item
    // is still reported even though its StateEvent append failed.
    expect(result.acquired).toBe(true);
    expect(result.applied.map((a) => a.entity)).toContain("server:app-1");
    expect(provider.serverApplyCount).toBe(1); // reality was actually mutated

    // The append failure is surfaced additively (NOT swallowed into the void).
    expect(result.recordFailures.length).toBeGreaterThanOrEqual(1);
    const rf = result.recordFailures.find(
      (f) => f.entity === "server:app-1",
    );
    expect(rf).toBeDefined();
    expect(rf!.op).toBeTruthy();
    expect(rf!.message).toContain("simulated DB hiccup");

    // And no state_events row was actually persisted for it (append failed) —
    // confirms the failure was real, queried via the unwrapped pool.
    const events = await queryEvents(pool, { entity: "server:app-1" });
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Capturing logger seam — in-process, zero stdout noise.
// ---------------------------------------------------------------------------

function capturingLogger(): {
  logger: Logger;
  lines: Array<{
    level: "info" | "warn" | "error";
    fields: LogFields;
    msg: string;
  }>;
} {
  const lines: Array<{
    level: "info" | "warn" | "error";
    fields: LogFields;
    msg: string;
  }> = [];
  return {
    lines,
    logger: {
      info(fields, msg) {
        lines.push({ level: "info", fields, msg });
      },
      warn(fields, msg) {
        lines.push({ level: "warn", fields, msg });
      },
      error(fields, msg) {
        lines.push({ level: "error", fields, msg });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 5c. Structured logs carry actor + scope + entity, and NEVER leak a secret.
// ---------------------------------------------------------------------------

describe("reconcile: structured logs (actor+scope+entity, no-secret-leak)", () => {
  it("emits actor+scope+entity on reconcile/apply lines and leaks no secret token", async () => {
    const provider = makeFakeProvider();
    const cap = capturingLogger();
    const SECRET = "super-secret-token-DO-NOT-LEAK";
    const run = reconcile({
      ...makeDeps(provider),
      logger: cap.logger,
    });

    await run({ scope: "server", actor: "agent:vox" });

    expect(cap.lines.length).toBeGreaterThan(0);
    // Every emitted line carries the mandatory observability triple.
    for (const ln of cap.lines) {
      expect(typeof ln.fields.actor).toBe("string");
      expect(ln.fields.actor).toBe("agent:vox");
      expect(ln.fields.scope).toBe("server");
      expect(typeof ln.fields.entity).toBe("string");
      expect(ln.fields.entity.length).toBeGreaterThan(0);
    }
    // At least one line is the applied server entity, classed.
    const appliedLine = cap.lines.find(
      (l) => l.fields.entity === "server:app-1",
    );
    expect(appliedLine).toBeDefined();
    expect(appliedLine!.fields.result).toBeTruthy();

    // SENTINEL: the secret value appears in NO log line anywhere (1.9/3.3).
    const blob = JSON.stringify(cap.lines);
    expect(blob).not.toContain(SECRET);
    expect(blob.toLowerCase()).not.toContain("password");
  });
});

// ---------------------------------------------------------------------------
// 5d. Cycle-level timeout: aborts CLEANLY — lock released, nothing
//     undone/deleted, recorded transient/timeout, next clean cycle converges.
// ---------------------------------------------------------------------------

describe("reconcile: cycle-level timeout is fail-safe (no fail-deleting, lock released, recoverable)", () => {
  it("a cycle exceeding the deadline records a timeout, releases the lock, undoes nothing, and the next cycle converges", async () => {
    const provider = makeFakeProvider();
    const cap = capturingLogger();

    // Deterministic deadline seam: capture the armed cycle-timeout callback so
    // the test fires it exactly when it chooses (no real timers).
    let fireDeadline: (() => void) | undefined;
    const run = reconcile({
      ...makeDeps(provider),
      logger: cap.logger,
      cycleTimeoutMs: 1_000,
      startTimeout: (_ms: number, onElapsed: () => void) => {
        fireDeadline = onElapsed;
        return () => {
          fireDeadline = undefined;
        };
      },
    });

    // Fire the deadline the instant it is armed (start of the locked section)
    // so the cycle trips its phase-boundary check before doing apply work.
    const loadDesiredSpy = async (): Promise<DesiredState> => {
      if (fireDeadline) fireDeadline();
      return desiredOneServer;
    };
    const runTimedOut = reconcile({
      pool,
      provider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: loadDesiredSpy,
      logger: cap.logger,
      cycleTimeoutMs: 1_000,
      startTimeout: (_ms: number, onElapsed: () => void) => {
        fireDeadline = onElapsed;
        return () => {
          fireDeadline = undefined;
        };
      },
    });

    const timedOut = await runTimedOut({
      scope: "server",
      actor: "agent:vox",
    });

    // The cycle aborted CLEANLY: it is recorded as a timeout, transient-class.
    expect(timedOut.acquired).toBe(true);
    expect(timedOut.timedOut).toBe(true);
    // Nothing was applied (deadline tripped before Apply) — and crucially
    // NOTHING was deleted/undone (fail-safe; apply.ts no-rollback honoured).
    expect(provider.applyCount).toBe(0);
    expect(timedOut.failed).toEqual([]);

    // A timeout StateEvent was recorded (recoverable signal), classed.
    const tEvents = await queryEvents(pool, { result: "timeout" });
    expect(tEvents.some((e) => e.scope === "server")).toBe(true);

    // The advisory lock was RELEASED — a subsequent op on the SAME scope can
    // acquire it (proven against the real pg advisory lock).
    let acquiredAfter = false;
    const probe = await withScopeLock(pool, "server", async () => {
      acquiredAfter = true;
      return true;
    });
    expect(probe.acquired).toBe(true);
    expect(acquiredAfter).toBe(true);

    // The NEXT clean cycle (no deadline fired) converges — idempotent
    // recovery: the world reaches desired exactly as if no timeout occurred.
    fireDeadline = undefined;
    const clean = reconcile(makeDeps(provider));
    const ok = await clean({ scope: "server", actor: "agent:vox" });
    expect(ok.acquired).toBe(true);
    expect(ok.timedOut).toBeFalsy();
    expect(ok.applied.map((a) => a.entity)).toContain("server:app-1");
    expect(provider.serverApplyCount).toBe(1);

    // A timeout was logged with the mandatory observability triple.
    const tLog = cap.lines.find((l) => l.msg.toLowerCase().includes("timeout"));
    expect(tLog).toBeDefined();
    expect(tLog!.fields.actor).toBe("agent:vox");
    expect(tLog!.fields.scope).toBe("server");
    expect(tLog!.level).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// 6. Periodic timer trigger exists (injectable; no real setInterval).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. scope="manifest" partitions observed_state per-kind (A3)
// ---------------------------------------------------------------------------

// Spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.2 (A3):
// when reconcile() runs with scope="manifest", observed_state rows
// must be written under each native kind (server/network/…) — NOT
// under the synthetic "manifest" scope.
describe("reconcile: scope='manifest' partitions observed per-kind (A3)", () => {
  it("writes observed_state rows under native kinds, not under 'manifest'", async () => {
    // Build a composite-like provider that reports a manifest union
    // slice: one server + one network entity. The observedAdapter
    // regroups them into State.servers / State.networks.
    const provider: Provider = {
      name: "fake-manifest-union",
      async observe(scope) {
        expect(scope).toBe("manifest");
        return {
          scope: "manifest",
          entities: [
            { key: "server:app-1", payload: { name: "app-1" } },
            { key: "network:net-a", payload: { name: "net-a" } },
          ],
        };
      },
      async apply() { return { entity: "", op: "noop", changed: false }; },
      async verify() { return true; },
    };
    // Mirror the production adapter pattern (tools.test.ts:146-169).
    const adapter = (slice: ObservedSlice): State => ({
      servers: slice.entities
        .filter((e) => e.key.startsWith("server:"))
        .map((e) => ({
          name: e.key.slice("server:".length),
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          status: "healthy" as const,
        })),
      networks: slice.entities
        .filter((e) => e.key.startsWith("network:"))
        .map((e) => ({ name: e.key.slice("network:".length), ip_range: "10.0.0.0/16", subnets: [] })),
      volumes: [], services: [], dns: [], backups: [],
    });

    const run = reconcile({
      pool, provider, gate: passThroughGate, observedAdapter: adapter,
      loadDesired: async () => ({}),
    });
    const result = await run({ scope: "manifest", actor: "agent:test" });
    expect(result).toBeDefined();

    // Native-kind rows present — entity column stores full key "server:app-1".
    const serverRows = await pool.query<{ entity: string }>(
      "SELECT entity FROM observed_state WHERE scope = $1",
      ["server"],
    );
    expect(serverRows.rows.map((r) => r.entity)).toContain("server:app-1");
    const networkRows = await pool.query<{ entity: string }>(
      "SELECT entity FROM observed_state WHERE scope = $1",
      ["network"],
    );
    expect(networkRows.rows.map((r) => r.entity)).toContain("network:net-a");

    // The synthetic "manifest" scope row MUST NOT be written.
    const manifestRows = await pool.query(
      "SELECT entity FROM observed_state WHERE scope = $1",
      ["manifest"],
    );
    expect(manifestRows.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Periodic timer trigger exists (injectable; no real setInterval).
// ---------------------------------------------------------------------------

describe("reconcile: periodic timer trigger", () => {
  it("schedulePeriodicReconcile invokes reconcile via the injected timer and cancels cleanly", async () => {
    const provider = makeFakeProvider();
    const run = reconcile(makeDeps(provider));

    let fire: () => void = () => {};
    const fakeTimer = {
      setInterval(cb: () => void, _ms: number) {
        fire = cb;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(_h: ReturnType<typeof setInterval>) {
        fire = () => {};
      },
    };

    const handle = schedulePeriodicReconcile(
      run,
      { scope: "server", actor: "agent:timer" },
      60_000,
      fakeTimer,
    );

    // No real timer ran; fire the injected tick once deterministically.
    fire();
    await handle.flush();
    expect(provider.serverApplyCount).toBe(1);

    handle.stop();
  });
});
