/**
 * core/src/reconciler/drift.test.ts
 *
 * Task 2.9 — THE FAIL-SAFE GUARANTEE (spec §5: "fail-safe, nunca
 * fail-deleting"; "drift reportado, nunca corrigido em silêncio").
 *
 * Two layers of assertion, with teeth:
 *
 *  1. UNIT (pure): `detectDrift(desired, observed)` reports an observed
 *     resource ABSENT from desired as a `conflict`-class DriftItem and NOTHING
 *     ELSE — it performs no mutation, does not touch its arguments, and the
 *     item shape matches the established Fase-1 `ManifestDriftItem` precedent
 *     (key / entityKind / kind / errorClass:"conflict" / observed value). It
 *     uses the shared store-escaped `entityKey` so the orphan key cannot
 *     mismatch the desired↔observed key convention.
 *
 *  2. END-TO-END (DB, via the proven reconcile harness): after a real
 *     reconcile cycle where observed contains an orphan absent from desired,
 *     the orphan STILL physically exists in the fake world, a drift item +
 *     informational `result:"drift"` StateEvent was produced, and ZERO
 *     destructive ops (`remove`/`destroy`) were emitted or applied anywhere.
 *     Re-running the cycle keeps reporting the orphan and STILL applies zero
 *     mutations (idempotency of drift reporting preserved).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

import { detectDrift } from "./drift.js";
import { plan } from "./plan.js";
import { reconcile, passThroughGate } from "./reconcile.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { queryEvents } from "../store/state-events.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";
import type pg from "pg";

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

/** A minimal observed Network row (observed State requires `subnets`). */
function obsNet(name: string, ipRange: string): State["networks"][number] {
  return {
    name,
    ip_range: ipRange,
    subnets: [],
  } as State["networks"][number];
}

// ---------------------------------------------------------------------------
// 1. UNIT — detectDrift is a pure report-only orphan detector
// ---------------------------------------------------------------------------

describe("detectDrift: observed resource absent from desired → conflict drift only", () => {
  it("reports the orphan as a conflict-class DriftItem and nothing else", () => {
    const desired: DesiredState = {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
    };
    const orphanServer = {
      name: "ghost-1",
      type: "cx22",
      location: "nbg1",
      network: "net-a",
      image: "ubuntu-24.04",
      status: "running",
    };
    const observed: State = {
      ...EMPTY_STATE,
      networks: [obsNet("net-a", "10.0.0.0/16")],
      servers: [orphanServer as State["servers"][number]],
    };

    const drift = detectDrift(desired, observed);

    // Exactly one drift item: the orphan server. The matched network is NOT
    // drift (it is in desired).
    expect(drift).toHaveLength(1);
    const item = drift[0]!;
    expect(item.key).toBe("server:ghost-1");
    expect(item.entityKind).toBe("server");
    expect(item.kind).toBe("present-only-in-observed");
    expect(item.errorClass).toBe("conflict");
    expect(item.observed).toEqual(orphanServer);
  });

  it("is pure: identical inputs → no drift; arguments are not mutated", () => {
    const desired: DesiredState = {
      servers: [
        { name: "app-1", type: "cx22", location: "nbg1", network: "net-a" },
      ],
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
    };
    const observed: State = {
      ...EMPTY_STATE,
      networks: [obsNet("net-a", "10.0.0.0/16")],
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
        } as State["servers"][number],
      ],
    };
    const desiredSnapshot = JSON.stringify(desired);
    const observedSnapshot = JSON.stringify(observed);

    expect(detectDrift(desired, observed)).toEqual([]);

    // No mutation of either argument.
    expect(JSON.stringify(desired)).toBe(desiredSnapshot);
    expect(JSON.stringify(observed)).toBe(observedSnapshot);
  });

  it("never emits a remove/destroy op and plan() surfaces the orphan as op:drift", () => {
    const desired: DesiredState = {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
    };
    const observed: State = {
      ...EMPTY_STATE,
      networks: [obsNet("net-a", "10.0.0.0/16")],
      servers: [
        {
          name: "ghost-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
        } as State["servers"][number],
      ],
    };

    const items = plan(desired, observed);
    const ghost = items.filter((i) => i.entity === "server:ghost-1");
    expect(ghost).toHaveLength(1);
    expect(ghost[0]!.op).toBe("drift");

    // THE point of Task 2.9: no destructive op is EVER produced for an orphan.
    expect(items.some((i) => i.op === "remove" || i.op === "destroy")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. END-TO-END — reconcile leaves the orphan physically untouched
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

/**
 * Fake provider whose world is PRE-SEEDED with an orphan server that is NOT in
 * the desired manifest. apply() records destructive intents so the test can
 * assert with teeth that the orphan is never removed/destroyed.
 */
interface FakeWorld extends Provider {
  reality: Set<string>;
  destructiveCalls: string[];
}

function makeSeededFake(seed: string[]): FakeWorld {
  const reality = new Set<string>(seed);
  const fake: FakeWorld = {
    name: "fake-seeded",
    reality,
    destructiveCalls: [],
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
      if (action.op === "remove" || action.op === "destroy") {
        // Should be unreachable for an orphan — record it so the test fails
        // loudly if a destructive op ever reaches the provider.
        fake.destructiveCalls.push(action.entity);
      }
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
  return fake;
}

/** Adapter: materialise observed server keys back into Server rows. */
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

// Desired declares ONLY app-1 (+ its network). The seeded world also has
// server:ghost-1, an orphan absent from desired.
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

describe("reconcile: an orphan observed resource is reported as drift, NEVER deleted", () => {
  it("leaves the orphan physically present, records a drift event, emits zero destructive ops", async () => {
    const provider = makeSeededFake(["server:ghost-1"]);
    const run = reconcile({
      pool,
      provider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => desiredOneServer,
    });

    const result = await run({ scope: "server", actor: "agent:vox" });

    expect(result.acquired).toBe(true);

    // The orphan is REPORTED as drift...
    expect(result.drift.map((d) => d.entity)).toContain("server:ghost-1");

    // ...and a result:"drift" StateEvent was recorded for it.
    const driftEvents = await queryEvents(pool, { result: "drift" });
    expect(
      driftEvents.some((e) => e.entity === "server:ghost-1"),
    ).toBe(true);

    // FAIL-SAFE WITH TEETH: the orphan STILL physically exists in the world,
    // and ZERO destructive ops ever reached the provider.
    expect(provider.reality.has("server:ghost-1")).toBe(true);
    expect(provider.destructiveCalls).toEqual([]);
    expect(
      result.applied.some(
        (a) => a.op === "remove" || a.op === "destroy",
      ),
    ).toBe(false);
    expect(
      result.failed.some(
        (f) => f.op === "remove" || f.op === "destroy",
      ),
    ).toBe(false);

    // A second cycle keeps reporting the orphan and STILL mutates nothing
    // (idempotency of drift reporting preserved — it is steadily reported,
    // never acted on).
    const second = await run({ scope: "server", actor: "agent:vox" });
    expect(second.drift.map((d) => d.entity)).toContain("server:ghost-1");
    expect(second.applied.every((a) => a.changed === false)).toBe(true);
    expect(provider.destructiveCalls).toEqual([]);
    expect(provider.reality.has("server:ghost-1")).toBe(true);
  });
});
