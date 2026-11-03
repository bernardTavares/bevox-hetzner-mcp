/**
 * core/src/agent/apply-manifest-silo-fanout.bug5.test.ts
 *
 * Investigation harness for bug #5: apply_manifest({networks, servers},
 * dry_run:false) returns {status:"applied"} but nothing materializes
 * (zero applied actions, zero entities in the provider's reality).
 *
 * The pre-existing test at tools.test.ts:1018 uses a RAW Map-backed
 * loadDesired/writeDesired in `makeCatalog` — that bypasses the production
 * cross-scope union seam, so it returns status="applied" with an EMPTY
 * plan and never noticed.
 *
 * This test wires the PRODUCTION createDesiredStateSeam() factory directly
 * (same construct as buildBootDeps) and asserts that the apply path
 * actually produces creates + applies them through the composite.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";

import { createToolCatalog } from "./tools.js";
import { ALL_TOOLS, __mintVerifiedCredentialForTest } from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import { compositeProvider } from "../reconciler/composite-provider.js";
import { createDesiredStateSeam } from "../store/desired-state-seam.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { State } from "../domain/entities.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

const clock: Clock = { now: () => new Date("2026-05-27T00:00:00Z") };

const EMPTY: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

function makeTrackingProvider(): Provider & { reality: Set<string> } {
  const reality = new Set<string>();
  const p: Provider & { reality: Set<string> } = {
    name: "tracking-fake",
    reality,
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
  return p;
}

function observedAdapter(slice: ObservedSlice): State {
  const servers = slice.entities
    .filter((e) => e.key.startsWith("server:"))
    .map((e) => ({
      name: e.key.slice("server:".length),
      type: "cx22",
      location: "nbg1",
      network: "bevox-prod",
      image: "ubuntu-22.04",
      ssh_keys: [],
      labels: {},
      status: "healthy" as const,
    }));
  const networks = slice.entities
    .filter((e) => e.key.startsWith("network:"))
    .map((e) => ({
      name: e.key.slice("network:".length),
      ip_range: "10.0.0.0/16",
      subnets: [],
    }));
  return { ...EMPTY, servers, networks } as State;
}

describe("bug #5 — apply_manifest silent no-op (production seam)", () => {
  it("apply_manifest({networks, servers}, dry_run:false) materializes entities via composite.apply", async () => {
    // Production seam (same as buildBootDeps), NOT raw Map.
    const seam = createDesiredStateSeam();
    const networkBackend = makeTrackingProvider();
    const serverBackend = makeTrackingProvider();
    const volumeBackend = makeTrackingProvider();
    const provider = compositeProvider({
      network: networkBackend,
      server: [serverBackend],
      volume: volumeBackend,
      // No service/dns/backup → composite meta-scope skips them.
    });

    let idn = 0;
    const catalog = createToolCatalog({
      pool,
      provider,
      observedAdapter,
      loadDesired: seam.loadDesired,
      writeDesired: seam.writeDesired,
      makeGate: (isSensitive): ReconcileGate =>
        createApprovalGate({
          pool,
          clock,
          isSensitive,
          idFactory: () => `apr_test_${++idn}`,
        }),
    });

    // Verified credential with full caps (same pattern as tools.test.ts:207).
    const credential = __mintVerifiedCredentialForTest(
      "agent:bug5",
      ALL_TOOLS as unknown as string[],
    );

    const res = await catalog.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [
            {
              name: "bevox-prod",
              ip_range: "10.0.0.0/16",
              subnets: [],
            },
          ],
          servers: [
            {
              name: "meta-api-prod-1",
              type: "cx22",
              location: "nbg1",
              network: "bevox-prod",
              image: "ubuntu-22.04",
              ssh_keys: ["bevox-meta-api-prod"],
              labels: { app: "bevox-meta-api", env: "prod", tier: "primary" },
            },
          ],
        },
        dry_run: false,
      },
      { credential, scope: "manifest" },
    );

    // 1. The envelope should be "applied" (no sensitive ops; create is non-sensitive).
    expect(res.status).toBe("applied");

    // 2. After fan-out, the per-scope silos should be populated.
    expect(seam.desiredByScope.get("network")?.networks?.[0]?.name).toBe(
      "bevox-prod",
    );
    expect(seam.desiredByScope.get("server")?.servers?.[0]?.name).toBe(
      "meta-api-prod-1",
    );

    // 3. loadDesired("manifest") MUST return the union (the smoking gun for bug #5).
    const manifestUnion = await seam.loadDesired("manifest");
    expect(manifestUnion.networks?.[0]?.name).toBe("bevox-prod");
    expect(manifestUnion.servers?.[0]?.name).toBe("meta-api-prod-1");

    // 4. The composite.apply MUST have routed the creates to the backends.
    //    If the plan was empty (bug #5 root cause), these would be empty.
    expect([...networkBackend.reality]).toContain("network:bevox-prod");
    expect([...serverBackend.reality]).toContain("server:meta-api-prod-1");
  });
});
