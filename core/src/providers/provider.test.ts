/**
 * core/src/providers/provider.test.ts
 *
 * Task 2.1 — drives the Provider interface + the reusable idempotency
 * conformance harness.
 *
 * Central guarantee under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"): a conforming provider's apply() is idempotent.
 * Once verify() reports reality matches desired, a second apply() for the same
 * PlanAction performs NO further write. The harness asserts this via the
 * provider-agnostic `changed:false` no-op contract (it has no access to a
 * write counter); the standalone test below additionally pins idempotency by
 * write-count on the fake. With a `scope`, the harness also asserts observe()
 * teeth: the converged entity must be reported by observe(scope).
 */

import { describe, it, expect } from "vitest";
import {
  conformanceHarness,
  type Provider,
  type PlanAction,
  type ApplyResult,
  type ObservedSlice,
} from "./provider.js";

// ---------------------------------------------------------------------------
// A minimal conforming in-memory fake provider (pure; no network / DB).
// It exposes a writeCount so the test can prove apply() is a no-op the 2nd
// time once verify() is satisfied.
// ---------------------------------------------------------------------------

function makeFakeProvider(): Provider & { writeCount: number } {
  // entity-key → applied flag (the fake's "reality")
  const reality = new Map<string, boolean>();

  const fake = {
    name: "fake",
    writeCount: 0,

    async observe(_scope: string): Promise<ObservedSlice> {
      return {
        scope: _scope,
        entities: [...reality.keys()]
          .filter((k) => reality.get(k) === true)
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      return reality.get(action.entity) === true;
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      // Idempotency: if reality already matches desired, do NOT write again.
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

// A deliberately NON-idempotent provider — used to prove the harness has teeth.
function makeNonIdempotentProvider(): Provider & { writeCount: number } {
  const bad = {
    name: "bad",
    writeCount: 0,
    async observe(scope: string): Promise<ObservedSlice> {
      return { scope, entities: [] };
    },
    async verify(_action: PlanAction): Promise<boolean> {
      return true;
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      // Bug: writes unconditionally, even when verify() is already satisfied.
      bad.writeCount += 1;
      return { entity: action.entity, op: action.op, changed: true };
    },
  };
  return bad;
}

// Idempotent, but observe() never surfaces the converged entity — proves the
// new scope teeth bite (a provider that writes but does not report it).
function makeNonSurfacingProvider(): Provider {
  const reality = new Map<string, boolean>();
  const bad = {
    name: "non-surfacing",
    async observe(scope: string): Promise<ObservedSlice> {
      return { scope, entities: [] }; // never reports the entity
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.get(action.entity) === true;
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      if (reality.get(action.entity) === true) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.set(action.entity, true);
      return { entity: action.entity, op: action.op, changed: true };
    },
  };
  return bad;
}

const ACTION: PlanAction = {
  op: "create",
  entity: "server:app-1",
  desired: { name: "app-1" },
};

describe("Provider — idempotency contract", () => {
  it("apply twice for the same action is a no-op the second time", async () => {
    const p = makeFakeProvider();

    const first = await p.apply(ACTION);
    expect(first.changed).toBe(true);
    expect(p.writeCount).toBe(1);
    expect(await p.verify(ACTION)).toBe(true);

    const second = await p.apply(ACTION);
    expect(second.changed).toBe(false);
    expect(p.writeCount).toBe(1); // write-count did NOT increase
    expect(await p.verify(ACTION)).toBe(true);
  });
});

describe("conformanceHarness", () => {
  it("passes for a conforming provider", async () => {
    await conformanceHarness(() => makeFakeProvider(), ACTION);
  });

  it("rejects a non-idempotent provider (harness has teeth)", async () => {
    await expect(
      conformanceHarness(() => makeNonIdempotentProvider(), ACTION),
    ).rejects.toThrow();
  });

  it("with scope, passes when observe() surfaces the converged entity", async () => {
    await conformanceHarness(() => makeFakeProvider(), ACTION, "server");
  });

  it("with scope, rejects a provider whose observe() omits the entity (observe teeth bite)", async () => {
    await expect(
      conformanceHarness(() => makeNonSurfacingProvider(), ACTION, "server"),
    ).rejects.toThrow();
  });
});
