/**
 * core/src/reconciler/plan-v2.test.ts
 *
 * F5.4 — DAG hook + apply dispatcher for v2 collections.
 *
 * Coverage:
 *   1. planV2() enumerates each v2 working store and emits one PlanItem per
 *      declared entity, in V2_PLAN_ORDER (firewall → primary_ip → certificate
 *      → load_balancer → ingress).
 *   2. The wrapV2Provider adapter exposes a v1 `Provider` shape that delegates
 *      observe/apply/verify to the v2 provider, lazily looking up observed
 *      per-action via v2.observe(observeArg(desired)).
 *   3. createCompositeProvider routes each PlanAction to the right wrapped
 *      sub-provider by `<kind>:` prefix; v1 entities fall through to the
 *      fallback v1 provider unchanged (no regression).
 *   4. applyPlan over a mixed v1 + v2 PlanItem stream dispatches each item to
 *      the right provider via the composite.
 */

import { describe, expect, it } from "vitest";

import { planV2, V2_PLAN_ORDER, desiredPayloadsV2 } from "./plan.js";
import type { V2WorkingSources } from "./plan.js";
import {
  wrapV2Provider,
  createCompositeProvider,
  type V2ProviderLike,
} from "./v2-wrap.js";
import { applyPlan } from "./apply.js";
import { createInMemoryWorkingStore } from "../agent/v2/working-store.js";
import type { WorkingStore } from "../agent/v2/working-store.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { PlanItem } from "../domain/entities.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal name-only entities (the planner only reads `name`).
// ---------------------------------------------------------------------------

interface FixtureEntity {
  readonly name: string;
  readonly extra?: string;
}

function makeStore(
  ...names: string[]
): WorkingStore<FixtureEntity> {
  const s = createInMemoryWorkingStore<FixtureEntity>();
  for (const n of names) void s.put(n, { name: n, extra: `payload-${n}` });
  return s;
}

interface SpyV2<T extends { name: string }> extends V2ProviderLike<T, { obs: string } | null> {
  readonly calls: {
    observe: Array<T | string>;
    apply: Array<{ desired: T; observed: { obs: string } | null }>;
    verify: Array<T>;
  };
}

function makeV2Spy<T extends { name: string }>(
  name: string,
  opts: { changed?: boolean; verifyResult?: boolean } = {},
): SpyV2<T> {
  const changed = opts.changed ?? true;
  const verifyResult = opts.verifyResult ?? true;
  const calls = {
    observe: [] as Array<T | string>,
    apply: [] as Array<{ desired: T; observed: { obs: string } | null }>,
    verify: [] as Array<T>,
  };
  return {
    name,
    calls,
    async observe(arg) {
      calls.observe.push(arg);
      return null;
    },
    async apply(desired, observed) {
      calls.apply.push({ desired, observed });
      return { changed };
    },
    async verify(desired) {
      calls.verify.push(desired);
      return verifyResult;
    },
  };
}

// ---------------------------------------------------------------------------
// V2_PLAN_ORDER constant — canonical, single source of truth
// ---------------------------------------------------------------------------

describe("V2_PLAN_ORDER", () => {
  it("is exactly firewall → primary_ip → certificate → load_balancer → ingress → k3s → kube", () => {
    expect(V2_PLAN_ORDER).toEqual([
      "firewall",
      "primary_ip",
      "certificate",
      "load_balancer",
      "ingress",
      "k3s",
      "kube",
    ]);
  });

  it("kube appears after ingress in V2_PLAN_ORDER", () => {
    const ingressIdx = V2_PLAN_ORDER.indexOf("ingress");
    const kubeIdx = V2_PLAN_ORDER.indexOf("kube");
    expect(kubeIdx).toBeGreaterThan(-1); // kube must be present
    expect(kubeIdx).toBeGreaterThan(ingressIdx); // kube comes after ingress
  });

  it("k3s appears after ingress and BEFORE kube in V2_PLAN_ORDER (host before workload)", () => {
    const ingressIdx = V2_PLAN_ORDER.indexOf("ingress");
    const k3sIdx = V2_PLAN_ORDER.indexOf("k3s");
    const kubeIdx = V2_PLAN_ORDER.indexOf("kube");
    expect(k3sIdx).toBeGreaterThan(-1); // k3s must be present
    expect(k3sIdx).toBeGreaterThan(ingressIdx); // k3s comes after ingress
    expect(k3sIdx).toBeLessThan(kubeIdx); // k3s comes before kube
  });
});

// ---------------------------------------------------------------------------
// planV2() — DAG enumeration from working stores
// ---------------------------------------------------------------------------

describe("planV2", () => {
  it("emits one PlanItem per declared entity from each working store", async () => {
    const sources: V2WorkingSources = {
      firewall: { entityKind: "firewall", store: makeStore("web-fw") },
      primary_ip: { entityKind: "primary_ip", store: makeStore("web-ip") },
      certificate: { entityKind: "certificate", store: makeStore("web-cert") },
      load_balancer: { entityKind: "load_balancer", store: makeStore("web-lb") },
      ingress: { entityKind: "ingress", store: makeStore("web-ingress") },
    };
    const items = await planV2(sources);
    expect(items.map((i) => i.entity)).toEqual([
      "firewall:web-fw",
      "primary_ip:web-ip",
      "certificate:web-cert",
      "load_balancer:web-lb",
      "ingress:web-ingress",
    ]);
    for (const i of items) {
      expect(i.op).toBe("create");
      expect(i.change).toBeTruthy();
      expect(i.impact).toBeTruthy();
    }
  });

  it("v2 collections come AFTER v1 in the canonical order firewall→primary_ip→certificate→load_balancer→ingress (out-of-order map input)", async () => {
    // Object keys intentionally NOT in canonical order — planV2 must
    // iterate V2_PLAN_ORDER, not Object.keys().
    const sources: V2WorkingSources = {
      load_balancer: { entityKind: "load_balancer", store: makeStore("lb-a") },
      firewall: { entityKind: "firewall", store: makeStore("fw-a") },
      ingress: { entityKind: "ingress", store: makeStore("ing-a") },
      certificate: { entityKind: "certificate", store: makeStore("cert-a") },
      primary_ip: { entityKind: "primary_ip", store: makeStore("pip-a") },
    };
    const items = await planV2(sources);
    expect(items.map((i) => i.entity)).toEqual([
      "firewall:fw-a",
      "primary_ip:pip-a",
      "certificate:cert-a",
      "load_balancer:lb-a",
      "ingress:ing-a",
    ]);
  });

  it("skips kinds whose working store is absent (additive: empty contribution)", async () => {
    const sources: V2WorkingSources = {
      firewall: { entityKind: "firewall", store: makeStore("only-fw") },
    };
    const items = await planV2(sources);
    expect(items).toEqual([
      {
        op: "create",
        entity: "firewall:only-fw",
        change: "converge firewall:only-fw toward desired",
        impact: expect.any(String),
      },
    ]);
  });

  it("an empty source map produces an empty plan (no v2 yet ⇒ no regression)", async () => {
    expect(await planV2({})).toEqual([]);
  });

  it("emits kube PlanItem(s) after ingress when kube working source is provided", async () => {
    const sources: V2WorkingSources = {
      ingress: { entityKind: "ingress", store: makeStore("web-ingress") },
      kube: { entityKind: "kube", store: makeStore("bevox-app") },
    };
    const items = await planV2(sources);
    // kube comes after ingress in V2_PLAN_ORDER, so ingress entity must appear first.
    expect(items.map((i) => i.entity)).toEqual([
      "ingress:web-ingress",
      "kube:bevox-app",
    ]);
    const kubeItem = items.find((i) => i.entity === "kube:bevox-app");
    expect(kubeItem).toBeDefined();
    expect(kubeItem!.op).toBe("create");
    expect(kubeItem!.change).toBe("converge kube:bevox-app toward desired");
    expect(kubeItem!.impact).toBeTruthy();
  });

  it("planV2 emits kube entities in name-sorted order (intra-kind ordering)", async () => {
    const sources: V2WorkingSources = {
      kube: { entityKind: "kube", store: makeStore("zebra-app", "alpha-app") },
    };
    const items = await planV2(sources);
    // list() in the working store returns name-sorted output.
    expect(items.map((i) => i.entity)).toEqual([
      "kube:alpha-app",
      "kube:zebra-app",
    ]);
  });

  it("planV2 emits k3s PlanItem(s) BEFORE kube PlanItem(s) — host must precede workload (Task 19)", async () => {
    const sources: V2WorkingSources = {
      kube: { entityKind: "kube", store: makeStore("bevox-app") },
      k3s: { entityKind: "k3s", store: makeStore("prod-host") },
    };
    const items = await planV2(sources);
    const entities = items.map((i) => i.entity);
    const k3sIdx = entities.findIndex((e) => e.startsWith("k3s:"));
    const kubeIdx = entities.findIndex((e) => e.startsWith("kube:"));
    expect(k3sIdx).toBeGreaterThan(-1); // k3s entity must be present
    expect(kubeIdx).toBeGreaterThan(-1); // kube entity must be present
    expect(k3sIdx).toBeLessThan(kubeIdx); // k3s host comes before kube workload
  });

  it("planV2 emits correct k3s PlanItem fields", async () => {
    const sources: V2WorkingSources = {
      k3s: { entityKind: "k3s", store: makeStore("prod-host") },
    };
    const items = await planV2(sources);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.entity).toBe("k3s:prod-host");
    expect(item.op).toBe("create");
    expect(item.change).toBe("converge k3s:prod-host toward desired");
    expect(item.impact).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// desiredPayloadsV2() — payload threading for the apply boundary
// ---------------------------------------------------------------------------

describe("desiredPayloadsV2", () => {
  it("keys payloads by `<kind>:<name>` and carries the working-store value", async () => {
    const fwStore = makeStore("web-fw");
    const sources: V2WorkingSources = {
      firewall: { entityKind: "firewall", store: fwStore },
    };
    const payloads = await desiredPayloadsV2(sources);
    expect(payloads.get("firewall:web-fw")).toEqual({
      name: "web-fw",
      extra: "payload-web-fw",
    });
  });
});

// ---------------------------------------------------------------------------
// wrapV2Provider() — v2 → v1 Provider adapter
// ---------------------------------------------------------------------------

describe("wrapV2Provider", () => {
  it("observe(scope) lists `<kind>:<name>` entities from the working store when scope matches the kind", async () => {
    const store = makeStore("web-fw", "api-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    const slice: ObservedSlice = await wrapped.observe("firewall");
    expect(slice.scope).toBe("firewall");
    // working-store list() is sorted by name → "api-fw" first.
    expect(slice.entities.map((e) => e.key)).toEqual([
      "firewall:api-fw",
      "firewall:web-fw",
    ]);
  });

  it("observe(scope) returns empty entities when scope is not this wrapper's kind", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    const slice = await wrapped.observe("server");
    expect(slice).toEqual({ scope: "server", entities: [] });
  });

  it("apply(PlanAction) unpacks desired, calls v2.observe(name) then v2.apply(desired, observed)", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall", { changed: true });
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    const action: PlanAction = {
      op: "create",
      entity: "firewall:web-fw",
      desired: { name: "web-fw", extra: "payload-web-fw" },
    };
    const result: ApplyResult = await wrapped.apply(action);
    expect(result).toEqual({
      entity: "firewall:web-fw",
      op: "create",
      changed: true,
    });
    // observeArg default: pass entity name.
    expect(v2.calls.observe).toEqual(["web-fw"]);
    expect(v2.calls.apply).toEqual([
      {
        desired: { name: "web-fw", extra: "payload-web-fw" },
        observed: null,
      },
    ]);
  });

  it("apply propagates changed:false (idempotent no-op) from the v2 provider", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall", { changed: false });
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    const result = await wrapped.apply({
      op: "update",
      entity: "firewall:web-fw",
      desired: { name: "web-fw" },
    });
    expect(result.changed).toBe(false);
  });

  it("verify(PlanAction) calls v2.verify(desired)", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall", {
      verifyResult: false,
    });
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    const ok = await wrapped.verify({
      op: "create",
      entity: "firewall:web-fw",
      desired: { name: "web-fw" },
    });
    expect(ok).toBe(false);
    expect(v2.calls.verify).toEqual([{ name: "web-fw" }]);
  });

  it("apply throws if PlanAction.entity prefix mismatches the wrapper's kind (composite mis-dispatch)", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    await expect(
      wrapped.apply({
        op: "create",
        entity: "load_balancer:web-lb",
        desired: { name: "web-lb" },
      }),
    ).rejects.toThrow(/does not match expected kind prefix/);
  });

  it("apply throws if PlanAction.desired is missing (production path must populate it)", async () => {
    const store = makeStore("web-fw");
    const v2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2,
      workingStore: store,
    });
    await expect(
      wrapped.apply({ op: "create", entity: "firewall:web-fw", desired: {} as unknown }),
    ).resolves.toBeDefined(); // {} unpacks to T (cast); test mainly that null/undefined throws.
    await expect(
      wrapped.apply({
        op: "create",
        entity: "firewall:web-fw",
        desired: undefined,
      }),
    ).rejects.toThrow(/desired is missing/);
  });

  it("observeArg override is honored (e.g. Ingress passes whole desired)", async () => {
    const store = makeStore("web-ing");
    const v2 = makeV2Spy<FixtureEntity>("ingress");
    const wrapped = wrapV2Provider({
      entityKind: "ingress",
      v2,
      workingStore: store,
      observeArg: (desired) => desired,
    });
    await wrapped.apply({
      op: "create",
      entity: "ingress:web-ing",
      desired: { name: "web-ing", extra: "x" },
    });
    expect(v2.calls.observe).toEqual([{ name: "web-ing", extra: "x" }]);
  });
});

// ---------------------------------------------------------------------------
// createCompositeProvider() — kind-based routing across v1 + v2
// ---------------------------------------------------------------------------

describe("createCompositeProvider", () => {
  // A fake v1 Provider that records every dispatch it received.
  function makeV1Provider(name: string): Provider & {
    readonly calls: PlanAction[];
  } {
    const calls: PlanAction[] = [];
    return {
      name,
      calls,
      async observe(scope: string) {
        return {
          scope,
          entities: [{ key: `from-${name}`, payload: { name: `from-${name}` } }],
        };
      },
      async apply(action: PlanAction) {
        calls.push(action);
        return { entity: action.entity, op: action.op, changed: true };
      },
      async verify() {
        return true;
      },
    };
  }

  it("routes v2 PlanActions to wrapped sub-providers; v1 entities fall through to fallback", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const fwStore = makeStore("web-fw");
    const fwV2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const fwWrapped = wrapV2Provider({
      entityKind: "firewall",
      v2: fwV2,
      workingStore: fwStore,
    });

    const composite = createCompositeProvider({
      byKind: new Map([["firewall", fwWrapped]]),
      fallback: v1,
    });

    // v2 dispatch
    await composite.apply({
      op: "create",
      entity: "firewall:web-fw",
      desired: { name: "web-fw" },
    });
    expect(fwV2.calls.apply).toHaveLength(1);
    expect(v1.calls).toHaveLength(0);

    // v1 fallthrough
    await composite.apply({
      op: "create",
      entity: "server:app-1",
      desired: { name: "app-1" },
    });
    expect(v1.calls.map((c) => c.entity)).toEqual(["server:app-1"]);
  });

  it("observe(scope) delegates to the matching kind's sub-provider; unknown scope → fallback", async () => {
    const v1 = makeV1Provider("v1");
    const store = makeStore("web-fw");
    const fwV2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const fwWrapped = wrapV2Provider({
      entityKind: "firewall",
      v2: fwV2,
      workingStore: store,
    });
    const composite = createCompositeProvider({
      byKind: new Map([["firewall", fwWrapped]]),
      fallback: v1,
    });
    const fwSlice = await composite.observe("firewall");
    expect(fwSlice.entities.map((e) => e.key)).toEqual(["firewall:web-fw"]);
    const srvSlice = await composite.observe("server");
    expect(srvSlice.entities.map((e) => e.key)).toEqual(["from-v1"]);
  });

  it("verify also dispatches by kind", async () => {
    const v1 = makeV1Provider("v1");
    const store = makeStore("web-fw");
    const fwV2 = makeV2Spy<FixtureEntity>("hetzner-firewall", {
      verifyResult: false,
    });
    const fwWrapped = wrapV2Provider({
      entityKind: "firewall",
      v2: fwV2,
      workingStore: store,
    });
    const composite = createCompositeProvider({
      byKind: new Map([["firewall", fwWrapped]]),
      fallback: v1,
    });
    const ok = await composite.verify({
      op: "create",
      entity: "firewall:web-fw",
      desired: { name: "web-fw" },
    });
    expect(ok).toBe(false);
    expect(fwV2.calls.verify).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: applyPlan + composite routes each v2 PlanItem to its wrapper
// ---------------------------------------------------------------------------

describe("applyPlan(composite, planV2Items) — apply dispatches each v2 kind", () => {
  it("dispatches firewall / primary_ip / certificate / load_balancer / ingress to their wrapped providers", async () => {
    // Build a working store per v2 kind, one entity each.
    const fwStore = makeStore("web-fw");
    const pipStore = makeStore("web-ip");
    const certStore = makeStore("web-cert");
    const lbStore = makeStore("web-lb");
    const ingStore = makeStore("web-ing");

    const fwV2 = makeV2Spy<FixtureEntity>("hetzner-firewall");
    const pipV2 = makeV2Spy<FixtureEntity>("hetzner-primary-ip");
    const certV2 = makeV2Spy<FixtureEntity>("hetzner-certificate");
    const lbV2 = makeV2Spy<FixtureEntity>("hetzner-load-balancer");
    const ingV2 = makeV2Spy<FixtureEntity>("ingress");

    const composite = createCompositeProvider({
      byKind: new Map([
        [
          "firewall",
          wrapV2Provider({ entityKind: "firewall", v2: fwV2, workingStore: fwStore }),
        ],
        [
          "primary_ip",
          wrapV2Provider({
            entityKind: "primary_ip",
            v2: pipV2,
            workingStore: pipStore,
          }),
        ],
        [
          "certificate",
          wrapV2Provider({
            entityKind: "certificate",
            v2: certV2,
            workingStore: certStore,
          }),
        ],
        [
          "load_balancer",
          wrapV2Provider({
            entityKind: "load_balancer",
            v2: lbV2,
            workingStore: lbStore,
          }),
        ],
        [
          "ingress",
          wrapV2Provider({
            entityKind: "ingress",
            v2: ingV2,
            workingStore: ingStore,
            observeArg: (d) => d,
          }),
        ],
      ]),
      // Unused in this test (no v1 items), but required by the composite API.
      fallback: {
        name: "unused-v1",
        async observe(scope) {
          return { scope, entities: [] };
        },
        async apply(a) {
          return { entity: a.entity, op: a.op, changed: false };
        },
        async verify() {
          return true;
        },
      },
    });

    const sources: V2WorkingSources = {
      firewall: { entityKind: "firewall", store: fwStore },
      primary_ip: { entityKind: "primary_ip", store: pipStore },
      certificate: { entityKind: "certificate", store: certStore },
      load_balancer: { entityKind: "load_balancer", store: lbStore },
      ingress: { entityKind: "ingress", store: ingStore },
    };
    const items: readonly PlanItem[] = await planV2(sources);
    const payloads = await desiredPayloadsV2(sources);

    const report = await applyPlan(composite, items, {
      desiredPayloads: payloads,
    });

    // Every item applied; v2 spies called exactly once each.
    expect(report.applied.map((a) => a.entity)).toEqual([
      "firewall:web-fw",
      "primary_ip:web-ip",
      "certificate:web-cert",
      "load_balancer:web-lb",
      "ingress:web-ing",
    ]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);

    expect(fwV2.calls.apply).toHaveLength(1);
    expect(pipV2.calls.apply).toHaveLength(1);
    expect(certV2.calls.apply).toHaveLength(1);
    expect(lbV2.calls.apply).toHaveLength(1);
    expect(ingV2.calls.apply).toHaveLength(1);

    // Apply received the right desired payload (threaded via desiredPayloadsV2).
    expect(fwV2.calls.apply[0]?.desired).toEqual({
      name: "web-fw",
      extra: "payload-web-fw",
    });
  });
});
