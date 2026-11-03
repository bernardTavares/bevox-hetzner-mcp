/**
 * core/src/reconciler/apply.test.ts
 *
 * Task 2.6 — drives applyPlan(): per-action apply + post-verify, with
 * error-class-driven control flow and FAIL-SAFE partial semantics.
 *
 * Central guarantees under test (spec §"idempotência por design";
 * §"fail-safe, nunca fail-deleting"; §"sem rollback automático destrutivo"):
 *   - actions execute in the (already topo-ordered) plan order;
 *   - every applied action is followed by provider.verify();
 *   - a `precondition` failure aborts THAT action and marks its transitive
 *     DEPENDENTS skipped, but INDEPENDENT actions still run;
 *   - NO destructive rollback on partial failure — already-applied resources
 *     are left intact; the report enumerates applied/failed/skipped + class;
 *   - applying an already-converged plan is a NO-OP (idempotent; underpins 2.8).
 */

import { describe, it, expect } from "vitest";

import { applyPlan } from "./apply.js";
import { dependencyEdges } from "./plan.js";
import { ReconcileError } from "../domain/errors.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { PlanItem } from "../domain/entities.js";
import type { DesiredState } from "../domain/desired-state.js";

// ---------------------------------------------------------------------------
// A programmable in-memory fake Provider (pure; no network / DB).
//   - records apply() call order;
//   - applied entities become "real" so verify() returns true;
//   - per-entity hooks can make apply() throw a chosen ReconcileError, or make
//     verify() lie (return false after a successful apply → post-apply drift).
// ---------------------------------------------------------------------------

interface FakeOpts {
  /** entity → error to throw from apply() instead of converging. */
  failApply?: Record<string, ReconcileError>;
  /** entity → force verify() to return false even after a successful apply. */
  verifyFalse?: Set<string>;
}

function makeFakeProvider(opts: FakeOpts = {}): Provider & {
  applyOrder: string[];
  verifyOrder: string[];
  writeCount: number;
} {
  const reality = new Map<string, boolean>();
  const fake = {
    name: "fake",
    applyOrder: [] as string[],
    verifyOrder: [] as string[],
    writeCount: 0,

    async observe(scope: string): Promise<ObservedSlice> {
      return {
        scope,
        entities: [...reality.keys()]
          .filter((k) => reality.get(k) === true)
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      fake.verifyOrder.push(action.entity);
      if (opts.verifyFalse?.has(action.entity)) return false;
      return reality.get(action.entity) === true;
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      fake.applyOrder.push(action.entity);
      const err = opts.failApply?.[action.entity];
      if (err) throw err;
      // Idempotency: already converged ⇒ no write, changed:false.
      if (reality.get(action.entity) === true) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.set(action.entity, true);
      fake.writeCount += 1;
      return { entity: action.entity, op: action.op, changed: true };
    },
  };
  return fake;
}

// A topo-ordered plan: network → server (dep network) → volume (dep server),
// plus an INDEPENDENT network "iso" with no dependents.
const desired: DesiredState = {
  networks: [
    { name: "priv", ip_range: "10.0.0.0/16", subnets: ["10.0.1.0/24"] },
    { name: "iso", ip_range: "10.9.0.0/16", subnets: ["10.9.1.0/24"] },
  ],
  servers: [{ name: "app-1", type: "cx22", location: "nbg1", network: "priv" }],
  volumes: [{ name: "data", size: "20Gi", server: "app-1", fs: "ext4" }],
};

const NET = "network:priv";
const ISO = "network:iso";
const SRV = "server:app-1";
const VOL = "volume:data";

const items: PlanItem[] = [
  { op: "create", entity: NET, change: "c", impact: "i" },
  { op: "create", entity: ISO, change: "c", impact: "i" },
  { op: "create", entity: SRV, change: "c", impact: "i" },
  { op: "create", entity: VOL, change: "c", impact: "i" },
];

const deps = () => dependencyEdges(desired);

describe("applyPlan — order + post-verify", () => {
  it("executes actions in plan order, each followed by verify()", async () => {
    const p = makeFakeProvider();
    const report = await applyPlan(p, items, { dependencies: deps() });

    expect(p.applyOrder).toEqual([NET, ISO, SRV, VOL]);
    // verify() called once per applied action, after its apply.
    expect(p.verifyOrder).toEqual([NET, ISO, SRV, VOL]);
    expect(report.applied.map((a) => a.entity)).toEqual([NET, ISO, SRV, VOL]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});

describe("applyPlan — precondition failure: skip dependents, continue independents", () => {
  it("aborts the failed item, marks its transitive dependents skipped, runs independents", async () => {
    const p = makeFakeProvider({
      failApply: {
        [NET]: new ReconcileError("precondition", "network dep missing", {
          entity: NET,
        }),
      },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });

    // NET failed (precondition); SRV depends on NET, VOL depends on SRV →
    // both transitively skipped. ISO is independent → still applied.
    expect(report.failed.map((f) => f.entity)).toEqual([NET]);
    expect(report.failed[0]!.errorClass).toBe("precondition");

    const skipped = report.skipped.map((s) => s.entity).sort();
    expect(skipped).toEqual([SRV, VOL]);
    expect(report.skipped.every((s) => s.reason.includes("upstream"))).toBe(
      true,
    );

    expect(report.applied.map((a) => a.entity)).toEqual([ISO]);

    // FAIL-SAFE: no destructive rollback — ISO (the one success) stays applied.
    expect(await p.verify({ op: "create", entity: ISO, desired: {} })).toBe(
      true,
    );
    // The failed action performed NO write.
    expect(p.writeCount).toBe(1); // only ISO
  });
});

describe("applyPlan — error-class control flow", () => {
  it("transient (post provider retries) fails the item, skips dependents, continues independents", async () => {
    const p = makeFakeProvider({
      failApply: {
        [SRV]: new ReconcileError("transient", "still 503 after retries", {
          entity: SRV,
        }),
      },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });

    expect(report.applied.map((a) => a.entity).sort()).toEqual([ISO, NET]);
    expect(report.failed.map((f) => f.entity)).toEqual([SRV]);
    expect(report.failed[0]!.errorClass).toBe("transient");
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
  });

  it("conflict is recorded as failed needing attention, never auto-corrected; independents continue", async () => {
    const p = makeFakeProvider({
      failApply: {
        [SRV]: new ReconcileError("conflict", "drift on server", {
          entity: SRV,
        }),
      },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });

    expect(report.failed.map((f) => f.entity)).toEqual([SRV]);
    expect(report.failed[0]!.errorClass).toBe("conflict");
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
    expect(report.applied.map((a) => a.entity).sort()).toEqual([ISO, NET]);
  });

  it("fatal fails the item + dependents but does NOT roll back and continues independents", async () => {
    const p = makeFakeProvider({
      failApply: {
        [SRV]: new ReconcileError("fatal", "permanent misconfig", {
          entity: SRV,
        }),
      },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });

    expect(report.failed.map((f) => f.entity)).toEqual([SRV]);
    expect(report.failed[0]!.errorClass).toBe("fatal");
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
    // Independent ISO + already-applied NET are NOT rolled back.
    expect(report.applied.map((a) => a.entity).sort()).toEqual([ISO, NET]);
    expect(await p.verify({ op: "create", entity: NET, desired: {} })).toBe(
      true,
    );
  });

  it("partial is a terminal in-apply failure (NOT retried here): fails the item, skips dependents, continues independents", async () => {
    const p = makeFakeProvider({
      failApply: {
        [SRV]: new ReconcileError("partial", "partial write on server", {
          entity: SRV,
        }),
      },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });

    // SRV fails with class "partial" — apply() does NOT retry it (the
    // provider/HTTP layer owns retry; a second layer here = double-retry).
    expect(report.failed.map((f) => f.entity)).toEqual([SRV]);
    expect(report.failed[0]!.errorClass).toBe("partial");
    // Transitive dependent VOL skipped — same terminal treatment as the
    // other classes; 2.7/2.8 MUST NOT assume in-apply retry for "partial".
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
    // Independent ISO + already-applied NET still applied (no rollback).
    expect(report.applied.map((a) => a.entity).sort()).toEqual([ISO, NET]);
  });

  it("a non-ReconcileError thrown from apply() is classified (default fatal) and handled, never rethrown", async () => {
    const p = makeFakeProvider({
      // plain Error → classify() default ⇒ fatal
      failApply: { [SRV]: new Error("boom") as unknown as ReconcileError },
    });
    const report = await applyPlan(p, items, { dependencies: deps() });
    expect(report.failed.map((f) => f.entity)).toEqual([SRV]);
    expect(report.failed[0]!.errorClass).toBe("fatal");
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
  });
});

describe("applyPlan — post-apply verify inconsistency", () => {
  it("apply succeeds but verify() is false → recorded failed (class conflict), NOT rolled back", async () => {
    const p = makeFakeProvider({ verifyFalse: new Set([SRV]) });
    const report = await applyPlan(p, items, { dependencies: deps() });

    const srvFail = report.failed.find((f) => f.entity === SRV);
    expect(srvFail).toBeDefined();
    expect(srvFail!.errorClass).toBe("conflict");
    // dependents skipped, independents applied, no rollback of NET/ISO.
    expect(report.skipped.map((s) => s.entity)).toEqual([VOL]);
    expect(report.applied.map((a) => a.entity).sort()).toEqual([ISO, NET]);
  });
});

describe("applyPlan — idempotent no-op over an already-converged plan", () => {
  it("re-applying a converged plan performs no writes and verify stays true", async () => {
    const p = makeFakeProvider();

    const first = await applyPlan(p, items, { dependencies: deps() });
    expect(first.failed).toEqual([]);
    expect(p.writeCount).toBe(4);

    const second = await applyPlan(p, items, { dependencies: deps() });
    expect(second.failed).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.applied.map((a) => a.entity)).toEqual([NET, ISO, SRV, VOL]);
    // Every applied item reports changed:false; NO new writes.
    expect(second.applied.every((a) => a.changed === false)).toBe(true);
    expect(p.writeCount).toBe(4); // unchanged — true no-op
  });

  it("a noop plan item is a no-op (no apply, no verify) and reported applied/changed:false", async () => {
    const p = makeFakeProvider();
    const noopItems: PlanItem[] = [
      { op: "noop", entity: NET, change: "already", impact: "none" },
    ];
    const report = await applyPlan(p, noopItems, { dependencies: deps() });
    expect(p.applyOrder).toEqual([]);
    expect(p.verifyOrder).toEqual([]);
    expect(report.applied).toEqual([
      { entity: NET, op: "noop", changed: false },
    ]);
  });

  it("a drift plan item is reported (not applied), never corrected/deleted (fail-safe)", async () => {
    const p = makeFakeProvider();
    const driftItems: PlanItem[] = [
      { op: "drift", entity: "server:orphan", change: "x", impact: "y" },
    ];
    const report = await applyPlan(p, driftItems);
    expect(p.applyOrder).toEqual([]);
    expect(report.drift.map((d) => d.entity)).toEqual(["server:orphan"]);
    expect(report.applied).toEqual([]);
    expect(report.failed).toEqual([]);
  });
});

describe("applyPlan — dependents derived from plan() edges, not guessed", () => {
  it("without a dependencies map, only the failed item itself fails (no false skips)", async () => {
    const p = makeFakeProvider({
      failApply: {
        [NET]: new ReconcileError("fatal", "x", { entity: NET }),
      },
    });
    // No ctx.dependencies ⇒ apply cannot know SRV/VOL depend on NET, so it
    // must NOT mis-skip them; they run independently (fail-safe: never
    // silently mis-skip an item we cannot prove is a dependent).
    const report = await applyPlan(p, items);
    expect(report.failed.map((f) => f.entity)).toEqual([NET]);
    expect(report.skipped).toEqual([]);
    expect(report.applied.map((a) => a.entity).sort()).toEqual([
      ISO,
      SRV,
      VOL,
    ]);
  });
});
