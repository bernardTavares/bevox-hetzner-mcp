/**
 * core/src/reconciler/v2-wrap.test.ts
 *
 * Bloco E Task 11 — `byKind` routing for the `kube` kind + ApplyContext/actor
 * propagation through the wrapper.
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 11)
 *
 * The KubernetesProvider (core/src/providers/v2/kube-apply.ts) is bespoke:
 *   - `KubeManifest` has `metadata.name`, NOT a top-level `name`, so it does
 *     not satisfy the generic `wrapV2Provider`'s `T extends { name: string }`.
 *   - its `apply(desired, observed, ctx?)` takes the apply-only `ApplyContext`
 *     (secrets.ts) to resolve `secret:<ref>` tokens, while the generic v2
 *     `apply(desired, observed)` takes NO ctx.
 *   - its `observe(manifest)` is observe-by-desired (like ingress's `(d)=>d`).
 *
 * `wrapKubeProvider` is the dedicated adapter that bridges these impedances
 * WITHOUT touching the generic `wrapV2Provider` or the 5 Bloco A providers.
 *
 * ACTOR INVARIANT (.claude/rules/state-event-actor.md): the actor / capability
 * is sourced from the reconciler context — it rides on `PlanAction.applyContext`
 * (minted by the reconciler at the apply boundary). The wrapper only PROPAGATES
 * it into the kube provider's apply; it NEVER synthesises a local one. The tests
 * below assert the kube apply receives the SAME `applyContext` object the action
 * carried (referential identity), proving no local synthesis.
 */

import { describe, expect, it } from "vitest";

import {
  wrapKubeProvider,
  wrapEnsureK3sProvider,
  wrapV2Provider,
  createCompositeProvider,
} from "./v2-wrap.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
  ObservedEntity,
} from "../providers/provider.js";
import type { ApplyContext } from "../store/secrets.js";
import { createApplyContext } from "../store/secrets.js";
import { createInMemoryWorkingStore } from "../agent/v2/working-store.js";
import type { EnsureK3s, KubeManifest } from "../domain/entities-v2.js";
import type { KubeListSource, EnsureK3sListSource } from "./v2-wrap.js";
import type {
  KubernetesProvider,
  KubeApplyResult,
} from "../providers/v2/kube-apply.js";
import type {
  EnsureK3sProvider,
  EnsureK3sApplyResult,
} from "../providers/v2/ensure-k3s.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<KubeManifest> = {}): KubeManifest {
  return {
    host: "prod-k3s",
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "api" },
    namespace: "bevox",
    body: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n",
    ...overrides,
  };
}

/** The identity key the kube provider produces for makeManifest(). */
const KUBE_ENTITY = "kube:prod-k3s/bevox/Deployment/api";

interface KubeSpy extends KubernetesProvider {
  readonly calls: {
    observe: KubeManifest[];
    apply: Array<{
      desired: KubeManifest;
      observed: ObservedEntity | null;
      ctx: ApplyContext | undefined;
    }>;
    verify: KubeManifest[];
    destroy: KubeManifest[];
  };
}

function makeKubeSpy(
  opts: { changed?: boolean; verifyResult?: boolean } = {},
): KubeSpy {
  const changed = opts.changed ?? true;
  const verifyResult = opts.verifyResult ?? true;
  const calls = {
    observe: [] as KubeManifest[],
    apply: [] as Array<{
      desired: KubeManifest;
      observed: ObservedEntity | null;
      ctx: ApplyContext | undefined;
    }>,
    verify: [] as KubeManifest[],
    destroy: [] as KubeManifest[],
  };
  return {
    name: "kubernetes",
    calls,
    async observe(manifest: KubeManifest): Promise<ObservedEntity | null> {
      calls.observe.push(manifest);
      return null;
    },
    async apply(
      desired: KubeManifest,
      observed: ObservedEntity | null,
      ctx?: ApplyContext,
    ): Promise<KubeApplyResult> {
      calls.apply.push({ desired, observed, ctx });
      return { entity: KUBE_ENTITY, changed };
    },
    async verify(desired: KubeManifest): Promise<boolean> {
      calls.verify.push(desired);
      return verifyResult;
    },
    async destroy(desired: KubeManifest): Promise<KubeApplyResult> {
      calls.destroy.push(desired);
      return { entity: KUBE_ENTITY, changed: true };
    },
  };
}

/** A fake v1 Provider that records every dispatch it received. */
function makeV1Provider(
  name: string,
): Provider & { readonly calls: PlanAction[] } {
  const calls: PlanAction[] = [];
  return {
    name,
    calls,
    async observe(scope: string): Promise<ObservedSlice> {
      return {
        scope,
        entities: [{ key: `from-${name}`, payload: { name: `from-${name}` } }],
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      calls.push(action);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

function makeKubeStore(...manifests: KubeManifest[]): KubeListSource {
  return {
    async list(): Promise<readonly KubeManifest[]> {
      return manifests;
    },
  };
}

// ---------------------------------------------------------------------------
// EnsureK3s fixtures (Task 20)
// ---------------------------------------------------------------------------

function makeK3s(overrides: Partial<EnsureK3s> = {}): EnsureK3s {
  return {
    host: "prod-k3s",
    version: "v1.30.2+k3s1",
    role: "server",
    ...overrides,
  };
}

/** The identity key the ensure-k3s provider produces for makeK3s(). */
const K3S_ENTITY = "k3s:prod-k3s";

interface EnsureK3sSpy extends EnsureK3sProvider {
  readonly calls: {
    observe: EnsureK3s[];
    apply: Array<{ desired: EnsureK3s; observed: ObservedEntity | null }>;
    verify: EnsureK3s[];
  };
}

function makeK3sSpy(
  opts: {
    changed?: boolean;
    drift?: boolean;
    verifyResult?: boolean;
  } = {},
): EnsureK3sSpy {
  const changed = opts.changed ?? true;
  const drift = opts.drift ?? false;
  const verifyResult = opts.verifyResult ?? true;
  const calls = {
    observe: [] as EnsureK3s[],
    apply: [] as Array<{ desired: EnsureK3s; observed: ObservedEntity | null }>,
    verify: [] as EnsureK3s[],
  };
  return {
    name: "ensure-k3s",
    calls,
    async observe(desired: EnsureK3s): Promise<ObservedEntity | null> {
      calls.observe.push(desired);
      return null;
    },
    async apply(
      desired: EnsureK3s,
      observed: ObservedEntity | null,
    ): Promise<EnsureK3sApplyResult> {
      calls.apply.push({ desired, observed });
      // VERSION-DIVERGENCE (Q-a): no install ran, drift reported.
      if (drift) {
        return { entity: K3S_ENTITY, changed: false, result: "drift" };
      }
      return { entity: K3S_ENTITY, changed };
    },
    async verify(desired: EnsureK3s): Promise<boolean> {
      calls.verify.push(desired);
      return verifyResult;
    },
  };
}

function makeK3sStore(...recipes: EnsureK3s[]): EnsureK3sListSource {
  return {
    async list(): Promise<readonly EnsureK3s[]> {
      return recipes;
    },
  };
}

// ---------------------------------------------------------------------------
// wrapKubeProvider — bridges the bespoke KubernetesProvider to the v1 port
// ---------------------------------------------------------------------------

describe("wrapKubeProvider", () => {
  it("apply() unpacks the KubeManifest, observes by desired, and calls kube.apply with the action's applyContext", async () => {
    const kube = makeKubeSpy();
    const store = makeKubeStore();
    const wrapped = wrapKubeProvider({ kube, workingStore: store });

    const desired = makeManifest();
    const ctx = createApplyContext();
    const result = await wrapped.apply({
      op: "create",
      entity: KUBE_ENTITY,
      desired,
      applyContext: ctx,
    });

    // observe-by-desired (manifest, not name).
    expect(kube.calls.observe).toHaveLength(1);
    expect(kube.calls.observe[0]).toBe(desired);

    // apply received the desired manifest AND the SAME applyContext object the
    // action carried — propagated, not synthesised (actor invariant).
    expect(kube.calls.apply).toHaveLength(1);
    expect(kube.calls.apply[0]?.desired).toBe(desired);
    expect(kube.calls.apply[0]?.ctx).toBe(ctx);

    expect(result).toEqual({ entity: KUBE_ENTITY, op: "create", changed: true });
  });

  it("apply() forwards `undefined` applyContext on a plan/dry_run-shaped action (no local synthesis)", async () => {
    const kube = makeKubeSpy();
    const wrapped = wrapKubeProvider({ kube, workingStore: makeKubeStore() });

    await wrapped.apply({ op: "create", entity: KUBE_ENTITY, desired: makeManifest() });

    expect(kube.calls.apply).toHaveLength(1);
    // The wrapper NEVER mints an ApplyContext — absent on the action ⇒ absent
    // at the provider (structurally unable to resolve a secret).
    expect(kube.calls.apply[0]?.ctx).toBeUndefined();
  });

  it("verify() unpacks the KubeManifest and delegates to kube.verify", async () => {
    const kube = makeKubeSpy({ verifyResult: false });
    const wrapped = wrapKubeProvider({ kube, workingStore: makeKubeStore() });

    const ok = await wrapped.verify({
      op: "create",
      entity: KUBE_ENTITY,
      desired: makeManifest(),
    });
    expect(ok).toBe(false);
    expect(kube.calls.verify).toHaveLength(1);
  });

  it("observe(scope) enumerates the working store under kube:<...> identity keys", async () => {
    const kube = makeKubeSpy();
    const m = makeManifest();
    const wrapped = wrapKubeProvider({ kube, workingStore: makeKubeStore(m) });

    const slice = await wrapped.observe("kube");
    expect(slice.scope).toBe("kube");
    expect(slice.entities.map((e) => e.key)).toEqual([KUBE_ENTITY]);

    // A non-kube scope yields an empty slice (single-kind wrapper).
    const other = await wrapped.observe("server");
    expect(other.entities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createCompositeProvider — routes a kube: PlanAction to the kube wrapper
// ---------------------------------------------------------------------------

describe("createCompositeProvider — kube kind routing", () => {
  it("routes a kube: PlanAction to the kube wrapper (fallback NOT called); applyContext flows through", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const kube = makeKubeSpy();
    const wrappedKube = wrapKubeProvider({ kube, workingStore: makeKubeStore() });

    const composite = createCompositeProvider({
      byKind: new Map<string, Provider>([["kube", wrappedKube]]),
      fallback: v1,
    });

    const desired = makeManifest();
    const ctx = createApplyContext();
    await composite.apply({
      op: "create",
      entity: KUBE_ENTITY,
      desired,
      applyContext: ctx,
    });

    // kube wrapper received the apply with the SAME applyContext from the action.
    expect(kube.calls.apply).toHaveLength(1);
    expect(kube.calls.apply[0]?.desired).toBe(desired);
    expect(kube.calls.apply[0]?.ctx).toBe(ctx);
    // fallback was NOT touched.
    expect(v1.calls).toHaveLength(0);
  });

  it("a v1 server: PlanAction still flows to the fallback (no regression)", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const kube = makeKubeSpy();
    const wrappedKube = wrapKubeProvider({ kube, workingStore: makeKubeStore() });

    const composite = createCompositeProvider({
      byKind: new Map<string, Provider>([["kube", wrappedKube]]),
      fallback: v1,
    });

    await composite.apply({
      op: "create",
      entity: "server:web",
      desired: { name: "web" },
    });

    expect(v1.calls.map((c) => c.entity)).toEqual(["server:web"]);
    expect(kube.calls.apply).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// wrapEnsureK3sProvider — bridges the bespoke EnsureK3sProvider to the v1 port
// (Task 20). The k3s apply takes NO ApplyContext (host axis resolves no
// secret:<ref>), so the wrapper does NOT thread applyContext into it — simpler
// than kube. The actor still flows from the reconcile context for the recorded
// StateEvent; the wrapper never synthesises one.
// ---------------------------------------------------------------------------

describe("wrapEnsureK3sProvider", () => {
  it("apply() unpacks the EnsureK3s, observes by desired, and delegates to ensureK3s.apply", async () => {
    const k3s = makeK3sSpy();
    const wrapped = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const desired = makeK3s();
    const result = await wrapped.apply({
      op: "create",
      entity: K3S_ENTITY,
      desired,
    });

    // observe-by-desired (the recipe, not a name).
    expect(k3s.calls.observe).toHaveLength(1);
    expect(k3s.calls.observe[0]).toBe(desired);

    // apply received the desired recipe + the observed snapshot.
    expect(k3s.calls.apply).toHaveLength(1);
    expect(k3s.calls.apply[0]?.desired).toBe(desired);
    expect(k3s.calls.apply[0]?.observed).toBeNull();

    // A converged install ⇒ changed:true, no drift event.
    expect(result).toEqual({ entity: K3S_ENTITY, op: "create", changed: true });
  });

  it("maps a version-divergence (result:'drift') to changed:false + a drift event — NOT a converged change, NO install", async () => {
    const k3s = makeK3sSpy({ drift: true });
    const wrapped = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const result = await wrapped.apply({
      op: "create",
      entity: K3S_ENTITY,
      desired: makeK3s({ version: "v1.31.0+k3s1" }),
    });

    // The provider was asked to converge exactly once (no install re-run); the
    // spy's apply returned result:"drift" ⇒ NO install side-effect.
    expect(k3s.calls.apply).toHaveLength(1);

    // Drift is surfaced via ApplyResult: changed:false (NOT a converged change),
    // PLUS a value-free `op:"drift"` event mirroring the canonical DriftEventSpec
    // (drift.ts). This lets the reconciler distinguish version-drift from a
    // converged no-op WITHOUT introducing any destructive/reinstall path.
    expect(result.changed).toBe(false);
    expect(result.entity).toBe(K3S_ENTITY);
    expect(result.op).toBe("create");
    expect(result.events).toEqual([{ op: "drift" }]);
  });

  it("a converged no-op (changed:false, NO drift) carries NO drift event", async () => {
    const k3s = makeK3sSpy({ changed: false });
    const wrapped = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const result = await wrapped.apply({
      op: "create",
      entity: K3S_ENTITY,
      desired: makeK3s(),
    });

    expect(result.changed).toBe(false);
    // No drift ⇒ no provider-surfaced event (a plain converged no-op).
    expect(result.events).toBeUndefined();
  });

  it("verify() unpacks the EnsureK3s and delegates to ensureK3s.verify", async () => {
    const k3s = makeK3sSpy({ verifyResult: false });
    const wrapped = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const ok = await wrapped.verify({
      op: "create",
      entity: K3S_ENTITY,
      desired: makeK3s(),
    });
    expect(ok).toBe(false);
    expect(k3s.calls.verify).toHaveLength(1);
  });

  it("observe(scope) enumerates the working store under k3s:<host> identity keys", async () => {
    const k3s = makeK3sSpy();
    const recipe = makeK3s();
    const wrapped = wrapEnsureK3sProvider({
      k3s,
      workingStore: makeK3sStore(recipe),
    });

    const slice = await wrapped.observe("k3s");
    expect(slice.scope).toBe("k3s");
    expect(slice.entities.map((e) => e.key)).toEqual([K3S_ENTITY]);

    // A non-k3s scope yields an empty slice (single-kind wrapper).
    const other = await wrapped.observe("server");
    expect(other.entities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createCompositeProvider — routes a k3s: PlanAction to the k3s wrapper, a
// kube: action to the kube wrapper, a v1 server: action to the fallback (Task 20)
// ---------------------------------------------------------------------------

describe("createCompositeProvider — k3s + kube kind routing", () => {
  it("routes a k3s: PlanAction to the ensure-k3s wrapper (kube + fallback NOT called)", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const kube = makeKubeSpy();
    const k3s = makeK3sSpy();
    const wrappedKube = wrapKubeProvider({ kube, workingStore: makeKubeStore() });
    const wrappedK3s = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const composite = createCompositeProvider({
      byKind: new Map<string, Provider>([
        ["k3s", wrappedK3s],
        ["kube", wrappedKube],
      ]),
      fallback: v1,
    });

    const desired = makeK3s();
    await composite.apply({ op: "create", entity: K3S_ENTITY, desired });

    expect(k3s.calls.apply).toHaveLength(1);
    expect(k3s.calls.apply[0]?.desired).toBe(desired);
    // neither the kube wrapper nor the fallback was touched.
    expect(kube.calls.apply).toHaveLength(0);
    expect(v1.calls).toHaveLength(0);
  });

  it("routes a kube: PlanAction to the kube wrapper (k3s + fallback NOT called); applyContext flows through", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const kube = makeKubeSpy();
    const k3s = makeK3sSpy();
    const wrappedKube = wrapKubeProvider({ kube, workingStore: makeKubeStore() });
    const wrappedK3s = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const composite = createCompositeProvider({
      byKind: new Map<string, Provider>([
        ["k3s", wrappedK3s],
        ["kube", wrappedKube],
      ]),
      fallback: v1,
    });

    const desired = makeManifest();
    const ctx = createApplyContext();
    await composite.apply({
      op: "create",
      entity: KUBE_ENTITY,
      desired,
      applyContext: ctx,
    });

    expect(kube.calls.apply).toHaveLength(1);
    expect(kube.calls.apply[0]?.ctx).toBe(ctx);
    // neither the k3s wrapper nor the fallback was touched.
    expect(k3s.calls.apply).toHaveLength(0);
    expect(v1.calls).toHaveLength(0);
  });

  it("a v1 server: PlanAction still flows to the fallback (no regression)", async () => {
    const v1 = makeV1Provider("v1-hetzner-cloud");
    const kube = makeKubeSpy();
    const k3s = makeK3sSpy();
    const wrappedKube = wrapKubeProvider({ kube, workingStore: makeKubeStore() });
    const wrappedK3s = wrapEnsureK3sProvider({ k3s, workingStore: makeK3sStore() });

    const composite = createCompositeProvider({
      byKind: new Map<string, Provider>([
        ["k3s", wrappedK3s],
        ["kube", wrappedKube],
      ]),
      fallback: v1,
    });

    await composite.apply({
      op: "create",
      entity: "server:web",
      desired: { name: "web" },
    });

    expect(v1.calls.map((c) => c.entity)).toEqual(["server:web"]);
    expect(k3s.calls.apply).toHaveLength(0);
    expect(kube.calls.apply).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bloco A non-regression — the generic wrapV2Provider still behaves identically
// ---------------------------------------------------------------------------

describe("wrapV2Provider — Bloco A non-regression", () => {
  interface FixtureEntity {
    readonly name: string;
  }

  function makeFwSpy() {
    const calls = {
      observe: [] as Array<FixtureEntity | string>,
      apply: [] as Array<{ desired: FixtureEntity; observed: null }>,
      verify: [] as FixtureEntity[],
    };
    return {
      name: "hetzner-firewall",
      calls,
      async observe(arg: FixtureEntity | string) {
        calls.observe.push(arg);
        return null;
      },
      async apply(desired: FixtureEntity, observed: null) {
        calls.apply.push({ desired, observed });
        return { changed: true };
      },
      async verify(desired: FixtureEntity) {
        calls.verify.push(desired);
        return true;
      },
    };
  }

  it("default observeArg looks up by name and apply takes NO ctx (Bloco A shape unchanged)", async () => {
    const fw = makeFwSpy();
    const store = createInMemoryWorkingStore<FixtureEntity>();
    void store.put("web-fw", { name: "web-fw" });
    const wrapped = wrapV2Provider({
      entityKind: "firewall",
      v2: fw,
      workingStore: store,
    });

    const result = await wrapped.apply({
      op: "create",
      entity: "firewall:web-fw",
      desired: { name: "web-fw" },
      // An applyContext on the action MUST be ignored by the generic wrapper
      // (Bloco A providers take no ctx) — proves byte-identical behaviour.
      applyContext: createApplyContext(),
    });

    // Generic observe is by name (the default selector), not by desired.
    expect(fw.calls.observe).toEqual(["web-fw"]);
    expect(fw.calls.apply).toHaveLength(1);
    expect(result).toEqual({
      entity: "firewall:web-fw",
      op: "create",
      changed: true,
    });
  });
});
