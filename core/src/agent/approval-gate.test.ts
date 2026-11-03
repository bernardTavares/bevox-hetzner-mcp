/**
 * core/src/agent/approval-gate.test.ts
 *
 * Task 4.3 — the REAL Approval Gate lifecycle. TDD teeth:
 *
 *   ReconcileGate seam (drop-in for passThroughGate):
 *     1. non-sensitive item → approved (pure pass-through, denied empty);
 *     2. sensitive item, no decision → denied + a persisted `pending` record
 *        (TTL default 24h via injected clock) + a "pending_approval" event;
 *     3. re-evaluating the SAME withheld sensitive item every cycle keeps it
 *        denied, creates NO duplicate record and emits NO new event (no flap);
 *     4. once APPROVED, the next cycle's evaluate() returns it in `approved`;
 *
 *   webhook resolution path:
 *     5. resolveApproval(approved) → status approved + "approved" event;
 *     6. resolveApproval(rejected, reason) → terminal `cancelled` + reason
 *        recorded + "rejected" event;
 *     7. resolving an already-terminal approval is an idempotent SAFE NO-OP
 *        (no throw, no new event, returns the existing record);
 *     8. unknown id / blank resolver → ReconcileError("precondition");
 *
 *   poll / TTL expiry path (injected clock advanced — NO real time):
 *     9. sweepExpired() before TTL → nothing;
 *    10. sweepExpired() after TTL → pending becomes terminal `cancelled`
 *        (reason "expired") + an "expired" event; a second sweep is a no-op;
 *    11. webhook AFTER expiry is the idempotent no-op (terminal wins);
 *
 *   reconciler integration (real gate plugged into reconcile.ts unchanged):
 *    12. a sensitive plan item is WITHHELD (recorded "denied"), the cycle does
 *        NOT block/destroy, and stays steadily withheld every cycle until a
 *        webhook approval flips the NEXT cycle to applied — fail-safe + the
 *        Fase-2 idempotency guarantee is not flapped.
 *
 * DB tests use the pg harness (resetSchema + runMigrations per test); the
 * clock is injected (no real timers/sleeps); ids are injected (deterministic).
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
  createApprovalGate,
  defaultIsSensitive,
  defaultSensitiveOps,
  type Clock,
} from "./approval-gate.js";
import { reconcile } from "../reconciler/reconcile.js";
import { ReconcileError } from "../domain/errors.js";
import type { PlanItem } from "../domain/entities.js";
import type { GateContext } from "../reconciler/reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { queryEvents, appendEvent } from "../store/state-events.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";
import type pg from "pg";

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

// --- injected, advanceable clock (no real time anywhere in the suite) ------

function makeClock(startMs: number): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

let idCounter = 0;
function idFactory(): string {
  idCounter += 1;
  return `apr_test-${idCounter}`;
}
beforeEach(() => {
  idCounter = 0;
});

const CTX: GateContext = { scope: "servers", actor: "agent:vox" };

const SENSITIVE: PlanItem = {
  op: "destroy",
  entity: "server:app-1",
  change: "destroy server app-1",
  impact: "irreversible: deletes the server",
};
const SAFE: PlanItem = {
  op: "create",
  entity: "server:app-2",
  change: "create server app-2",
  impact: "adds a server",
};

const TTL = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sensitivity predicate (injected, minimal — full table is Task 4.4)
// ---------------------------------------------------------------------------

describe("defaultIsSensitive / defaultSensitiveOps", () => {
  it("flags destructive ops and passes safe ops through", () => {
    expect(defaultSensitiveOps.has("destroy")).toBe(true);
    expect(defaultSensitiveOps.has("remove")).toBe(true);
    expect(defaultSensitiveOps.has("restore")).toBe(true);
    expect(defaultIsSensitive(SENSITIVE)).toBe(true);
    expect(defaultIsSensitive(SAFE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReconcileGate seam
// ---------------------------------------------------------------------------

describe("evaluate(): ReconcileGate seam", () => {
  it("non-sensitive item is approved (pure pass-through)", async () => {
    const gate = createApprovalGate({
      pool,
      clock: makeClock(0),
      idFactory,
    });
    const d = await gate.evaluate([SAFE], CTX);
    expect(d.approved).toEqual([SAFE]);
    expect(d.denied).toEqual([]);
    // No approval record created for a safe op.
    expect(await gate.listApprovals()).toEqual([]);
  });

  it("sensitive item with no decision → denied + persisted pending (24h TTL) + event", async () => {
    const clock = makeClock(1_000_000);
    const gate = createApprovalGate({ pool, clock, idFactory });

    const d = await gate.evaluate([SENSITIVE], CTX);
    expect(d.approved).toEqual([]);
    expect(d.denied).toEqual([SENSITIVE]);

    const recs = await gate.listApprovals();
    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.id).toBe("apr_test-1");
    expect(rec.status).toBe("pending");
    expect(rec.actor).toBe("agent:vox");
    expect(rec.scope).toBe("servers");
    expect(rec.op).toBe("destroy");
    expect(rec.entity).toBe("server:app-1");
    // TTL default 24h via the INJECTED clock.
    expect(new Date(rec.expiresAt).getTime()).toBe(1_000_000 + TTL);

    const events = await queryEvents(pool, { result: "pending_approval" });
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("agent:vox");
    expect(events[0]!.entity).toBe("server:app-1");
  });

  it("re-evaluating the same withheld item every cycle: still denied, NO duplicate, NO new event (no flap)", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });

    for (let i = 0; i < 5; i++) {
      const d = await gate.evaluate([SENSITIVE], CTX);
      expect(d.denied).toEqual([SENSITIVE]);
      expect(d.approved).toEqual([]);
    }
    // Exactly ONE record, exactly ONE pending_approval event after 5 cycles.
    expect(await gate.listApprovals()).toHaveLength(1);
    const events = await queryEvents(pool, { result: "pending_approval" });
    expect(events).toHaveLength(1);
  });

  it("after webhook approval the next evaluate() returns the item in approved", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX); // creates apr_test-1 pending
    await gate.resolveApproval("apr_test-1", "approved", "agent:human");

    const d = await gate.evaluate([SENSITIVE], CTX);
    expect(d.approved).toEqual([SENSITIVE]);
    expect(d.denied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Webhook resolution path
// ---------------------------------------------------------------------------

describe("resolveApproval(): webhook path", () => {
  it("approved → status approved + 'approved' event", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    const rec = await gate.resolveApproval(
      "apr_test-1",
      "approved",
      "agent:human",
    );
    expect(rec.status).toBe("approved");
    expect(rec.resolver).toBe("agent:human");
    expect(rec.resolvedAt).not.toBeNull();

    const events = await queryEvents(pool, { result: "approved" });
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("agent:human");
  });

  it("rejected → terminal cancelled + reason recorded + 'rejected' event", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    const rec = await gate.resolveApproval(
      "apr_test-1",
      "rejected",
      "agent:human",
      "too risky right now",
    );
    expect(rec.status).toBe("cancelled");
    expect(rec.reason).toBe("too risky right now");

    const events = await queryEvents(pool, { result: "rejected" });
    expect(events).toHaveLength(1);

    // Still withheld forever — NEVER auto-destructed.
    const d = await gate.evaluate([SENSITIVE], CTX);
    expect(d.denied).toEqual([SENSITIVE]);
  });

  it("resolving an already-terminal approval is an idempotent safe no-op", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);
    await gate.resolveApproval("apr_test-1", "approved", "agent:human");

    // Second resolve (double webhook) — no throw, no new event, same record.
    const again = await gate.resolveApproval(
      "apr_test-1",
      "rejected",
      "agent:other",
      "late",
    );
    expect(again.status).toBe("approved"); // unchanged — first decision wins
    expect(again.resolver).toBe("agent:human");

    const approvedEvents = await queryEvents(pool, { result: "approved" });
    expect(approvedEvents).toHaveLength(1); // not re-emitted
    const rejectedEvents = await queryEvents(pool, { result: "rejected" });
    expect(rejectedEvents).toHaveLength(0);
  });

  // Separation of duties (spec 2026-11-03-approval-separation-of-duties):
  // the requester (CTX actor "agent:vox") may never resolve its own approval.
  it("requester approving its OWN pending approval → fatal, stays pending, no event", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX); // apr_test-1 requested by agent:vox

    const err = await gate
      .resolveApproval("apr_test-1", "approved", "agent:vox")
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcileError);
    expect((err as ReconcileError).errorClass).toBe("fatal");

    const rec = await gate.getApproval("apr_test-1");
    expect(rec?.status).toBe("pending");
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(0);
    // ...and the item is still withheld on the next cycle.
    const d = await gate.evaluate([SENSITIVE], CTX);
    expect(d.denied).toEqual([SENSITIVE]);
  });

  it("requester rejecting its OWN pending approval → refused the same way", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    await expect(
      gate.resolveApproval("apr_test-1", "rejected", "agent:vox", "nah"),
    ).rejects.toBeInstanceOf(ReconcileError);
    expect((await gate.getApproval("apr_test-1"))?.status).toBe("pending");
    expect(await queryEvents(pool, { result: "rejected" })).toHaveLength(0);
  });

  it("requester resolving an ALREADY-TERMINAL approval → idempotent no-op (unchanged)", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);
    await gate.resolveApproval("apr_test-1", "approved", "agent:human");

    const again = await gate.resolveApproval("apr_test-1", "approved", "agent:vox");
    expect(again.status).toBe("approved");
    expect(again.resolver).toBe("agent:human");
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(1);
  });

  it("unknown id → precondition; blank resolver → precondition", async () => {
    const gate = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    await expect(
      gate.resolveApproval("apr_does-not-exist", "approved", "agent:human"),
    ).rejects.toBeInstanceOf(ReconcileError);
    await expect(
      gate.resolveApproval("apr_test-1", "approved", "  "),
    ).rejects.toBeInstanceOf(ReconcileError);
  });
});

// ---------------------------------------------------------------------------
// Poll / TTL expiry path (injected clock — no real timers)
// ---------------------------------------------------------------------------

describe("sweepExpired(): poll / TTL path", () => {
  it("before TTL: nothing expires", async () => {
    const clock = makeClock(0);
    const gate = createApprovalGate({ pool, clock, idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    clock.advance(TTL - 1);
    expect(await gate.sweepExpired()).toEqual([]);
    expect((await gate.getApproval("apr_test-1"))!.status).toBe("pending");
  });

  it("after TTL: pending → cancelled (reason 'expired') + event; second sweep is a no-op", async () => {
    const clock = makeClock(0);
    const gate = createApprovalGate({ pool, clock, idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    clock.advance(TTL);
    const expired = await gate.sweepExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("cancelled");
    expect(expired[0]!.reason).toBe("expired");

    const events = await queryEvents(pool, { result: "expired" });
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("system");

    // Idempotent: a second sweep claims nothing, emits nothing.
    expect(await gate.sweepExpired()).toEqual([]);
    expect(await queryEvents(pool, { result: "expired" })).toHaveLength(1);
  });

  it("webhook AFTER expiry is the idempotent no-op (terminal wins, never flaps)", async () => {
    const clock = makeClock(0);
    const gate = createApprovalGate({ pool, clock, idFactory });
    await gate.evaluate([SENSITIVE], CTX);

    clock.advance(TTL);
    await gate.sweepExpired();

    const rec = await gate.resolveApproval(
      "apr_test-1",
      "approved",
      "agent:human",
    );
    expect(rec.status).toBe("cancelled"); // expiry already terminal — no-op
    // No spurious "approved" event.
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Reconciler integration — real gate, reconcile.ts UNCHANGED
// ---------------------------------------------------------------------------

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

/**
 * A fake provider with EMPTY reality. The desired manifest declares
 * server:app-1, so plan() emits a `create` for it. Provisioning a server is
 * the sensitive op for THIS test (plan() never emits remove/destroy for
 * orphans — Task 2.9 fail-safe — so `create` is the realistic sensitive
 * action that flows through the unchanged reconciler). The sensitivity
 * predicate is INJECTED per this test (not hardcoded — the full per-tool
 * table is Task 4.4).
 */
function makeFakeProvider() {
  const reality = new Set<string>();
  const calls: { entity: string; op: string }[] = [];
  return {
    name: "fake",
    calls,
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
      calls.push({ entity: action.entity, op: action.op });
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
}

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

// Desired declares one server → plan() emits a `create` for server:app-1.
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

// ---------------------------------------------------------------------------
// Atomicity teeth — transition + StateEvent commit-or-fail together
// ---------------------------------------------------------------------------

describe("atomicity: transition + StateEvent are one transaction", () => {
  it("ensurePending: event-write failure rolls back the INSERT (no orphan pending row, no event)", async () => {
    let calls = 0;
    const failingAppend: typeof appendEvent = async (db, ev) => {
      calls += 1;
      throw new Error("injected event-write failure");
      // eslint-disable-next-line no-unreachable
      return appendEvent(db, ev);
    };
    const gate = createApprovalGate({
      pool,
      clock: makeClock(0),
      idFactory,
      appendEventFn: failingAppend,
    });

    // evaluate() → ensurePending() → INSERT then event; event throws → the
    // whole txn ROLLs back. evaluate propagates the error (no silent swallow).
    await expect(gate.evaluate([SENSITIVE], CTX)).rejects.toThrow(
      "injected event-write failure",
    );
    expect(calls).toBe(1);

    // ROLLED BACK: no orphaned pending row, no pending_approval event.
    expect(await gate.listApprovals()).toEqual([]);
    expect(
      await queryEvents(pool, { result: "pending_approval" }),
    ).toHaveLength(0);

    // A subsequent healthy gate (real appendEvent) creates exactly one
    // pending + exactly one event — state was truly clean.
    const healthy = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    const d = await healthy.evaluate([SENSITIVE], CTX);
    expect(d.denied).toEqual([SENSITIVE]);
    expect(await healthy.listApprovals()).toHaveLength(1);
    expect(
      await queryEvents(pool, { result: "pending_approval" }),
    ).toHaveLength(1);
  });

  it("resolveApproval: event-write failure rolls back the UPDATE (row stays pending), then a real resolve works and emits exactly one event", async () => {
    // Seed a pending via a healthy gate.
    const healthy = createApprovalGate({ pool, clock: makeClock(0), idFactory });
    await healthy.evaluate([SENSITIVE], CTX); // apr_test-1 pending

    let calls = 0;
    const failingAppend: typeof appendEvent = async (db, ev) => {
      calls += 1;
      throw new Error("injected event-write failure");
      // eslint-disable-next-line no-unreachable
      return appendEvent(db, ev);
    };
    const broken = createApprovalGate({
      pool,
      clock: makeClock(0),
      idFactory,
      appendEventFn: failingAppend,
    });

    await expect(
      broken.resolveApproval("apr_test-1", "approved", "agent:human"),
    ).rejects.toThrow("injected event-write failure");
    expect(calls).toBe(1);

    // ROLLED BACK: the approval is STILL pending (state + event failed together).
    expect((await healthy.getApproval("apr_test-1"))!.status).toBe("pending");
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(0);

    // A subsequent real resolve succeeds and emits exactly one event.
    const rec = await healthy.resolveApproval(
      "apr_test-1",
      "approved",
      "agent:human",
    );
    expect(rec.status).toBe("approved");
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(1);
  });

  it("sweepExpired: event-write failure rolls back the UPDATE (row stays pending), then a real sweep cancels it with exactly one event", async () => {
    const seedClock = makeClock(0);
    const healthy = createApprovalGate({
      pool,
      clock: seedClock,
      idFactory,
    });
    await healthy.evaluate([SENSITIVE], CTX); // apr_test-1 pending

    let calls = 0;
    const failingAppend: typeof appendEvent = async (db, ev) => {
      calls += 1;
      throw new Error("injected event-write failure");
      // eslint-disable-next-line no-unreachable
      return appendEvent(db, ev);
    };
    const brokenClock = makeClock(TTL); // past TTL → sweep would claim it
    const broken = createApprovalGate({
      pool,
      clock: brokenClock,
      idFactory,
      appendEventFn: failingAppend,
    });

    await expect(broken.sweepExpired()).rejects.toThrow(
      "injected event-write failure",
    );
    expect(calls).toBe(1);

    // ROLLED BACK: still pending, no expired event.
    expect((await healthy.getApproval("apr_test-1"))!.status).toBe("pending");
    expect(await queryEvents(pool, { result: "expired" })).toHaveLength(0);

    // A real sweep (clock past TTL) now cancels it with exactly one event.
    const realSweep = createApprovalGate({
      pool,
      clock: makeClock(TTL),
      idFactory,
    });
    const expired = await realSweep.sweepExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.status).toBe("cancelled");
    expect(await queryEvents(pool, { result: "expired" })).toHaveLength(1);
  });

  it("single-winner webhook-vs-sweep still holds: the losing 0-row transition emits NO event and throws NO error", async () => {
    const clock = makeClock(0);
    const gate = createApprovalGate({ pool, clock, idFactory });
    await gate.evaluate([SENSITIVE], CTX); // apr_test-1 pending

    // Webhook resolves first (winner).
    const won = await gate.resolveApproval(
      "apr_test-1",
      "approved",
      "agent:human",
    );
    expect(won.status).toBe("approved");

    // Sweep runs after TTL: the row is already terminal, the guarded UPDATE
    // matches 0 rows → NO error, NO "expired" event (single winner preserved).
    clock.advance(TTL);
    const swept = await gate.sweepExpired();
    expect(swept).toEqual([]);
    expect(await queryEvents(pool, { result: "expired" })).toHaveLength(0);
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(1);

    // Idempotent double-resolve: no extra event, no error, state unchanged.
    const again = await gate.resolveApproval(
      "apr_test-1",
      "rejected",
      "agent:other",
      "late",
    );
    expect(again.status).toBe("approved");
    expect(await queryEvents(pool, { result: "approved" })).toHaveLength(1);
    expect(await queryEvents(pool, { result: "rejected" })).toHaveLength(0);
  });
});

describe("reconcile integration: real gate plugs into the 2.7 seam unchanged", () => {
  it("sensitive item is WITHHELD (recorded denied), cycle does not block/apply, steady until webhook approval then applied", async () => {
    const clock = makeClock(0);
    // INJECTED predicate: provisioning a server is sensitive for this test.
    const gate = createApprovalGate({
      pool,
      clock,
      idFactory,
      isSensitive: (i) => i.op === "create" && i.entity.startsWith("server:"),
    });
    const provider = makeFakeProvider();
    const run = reconcile({
      pool,
      provider,
      gate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => desiredOneServer,
    });

    // Cycle 1: the create of server:app-1 is sensitive → withheld.
    const r1 = await run({ scope: "server", actor: "agent:vox" });
    expect(r1.acquired).toBe(true);
    expect(r1.withheld).toEqual([{ entity: "server:app-1", op: "create" }]);
    // The non-sensitive net-a passes through; the sensitive server does NOT.
    expect(r1.applied.map((a) => a.entity)).not.toContain("server:app-1");
    // FAIL-SAFE: provider.apply() never called for the WITHHELD server.
    expect(provider.calls.map((c) => c.entity)).not.toContain("server:app-1");

    // Cycle 2 (no resolution yet): still steadily withheld, no flap.
    const r2 = await run({ scope: "server", actor: "agent:vox" });
    expect(r2.withheld).toEqual([{ entity: "server:app-1", op: "create" }]);
    expect(provider.calls.map((c) => c.entity)).not.toContain("server:app-1");
    // Still exactly one approval, one pending_approval event (deterministic).
    expect(await gate.listApprovals()).toHaveLength(1);
    expect(await queryEvents(pool, { result: "pending_approval" })).toHaveLength(
      1,
    );
    // Withheld recorded each cycle (audit trail, fail-safe).
    expect(
      (await queryEvents(pool, { result: "denied" })).length,
    ).toBeGreaterThanOrEqual(2);

    // Webhook approval, then the NEXT cycle applies (the action happens only
    // AFTER the human approves — never auto-applied before).
    await gate.resolveApproval("apr_test-1", "approved", "agent:human");
    const r3 = await run({ scope: "server", actor: "agent:vox" });
    expect(r3.applied.map((a) => a.entity)).toContain("server:app-1");
    expect(provider.calls).toContainEqual({
      entity: "server:app-1",
      op: "create",
    });
  });
});

// ---------------------------------------------------------------------------
// Always-sensitive sentinel (Task 6.1) — REGRESSION GUARD for run_migrations
//
// `run_migrations` (v2 spec §1.3) ALWAYS routes through the Approval Gate
// regardless of the per-tool sensitivity table — the runner wires the gate
// with `isSensitive: () => true`. The gate is generic by construction, so an
// arbitrary `migrations:<svc>:<db>` PlanItem MUST flow through the same
// pending → approved → applied lifecycle every v1 entity uses. This test is
// the sentinel that future refactors cannot regress that contract (a hidden
// op-allowlist or entity-prefix filter would silently break the runner).
// ---------------------------------------------------------------------------

describe("always-sensitive — run_migrations synthetic PlanItem", () => {
  it("withholds the migrations:<svc>:<db> item on first call; approved retry passes", async () => {
    // INJECTED predicate: every item is sensitive (the runner's wiring).
    const gate = createApprovalGate({
      pool,
      clock: makeClock(0),
      idFactory,
      isSensitive: () => true,
    });
    const item: PlanItem = {
      op: "create",
      entity: "migrations:postgres:bevox_harness",
      change: "run 3 migration(s) against migrations:postgres:bevox_harness",
      impact: "applies DDL/DML — approval required",
    };
    const gctx: GateContext = {
      scope: "agent:test:service",
      actor: "agent:test",
    };

    // Cycle 1: no prior approval → withheld + pending row + apr_ id surfaced.
    const dec1 = await gate.evaluate([item], gctx);
    expect(dec1.denied).toEqual([item]);
    expect(dec1.approved).toEqual([]);
    expect(dec1.pendingApprovals).toHaveLength(1);
    const apprId = dec1.pendingApprovals![0]!.approvalId;
    expect(apprId).toMatch(/^apr_/);
    expect(dec1.pendingApprovals![0]!.entity).toBe(item.entity);
    expect(dec1.pendingApprovals![0]!.op).toBe("create");

    // Webhook approves the pending row.
    await gate.resolveApproval(apprId, "approved", "agent:human");

    // Cycle 2: same synthetic item → approved (gate is generic; the
    // `migrations:*` entity prefix is unprivileged data, not a special case).
    const dec2 = await gate.evaluate([item], gctx);
    expect(dec2.approved).toEqual([item]);
    expect(dec2.denied).toEqual([]);
  });
});
