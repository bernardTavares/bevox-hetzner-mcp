/**
 * core/src/reconciler/v2-wrap.ts
 *
 * F5.4 — adapter that wraps a v2 provider (the F1.x–F5.x port shape:
 *   observe(name) / plan(desired,observed) / apply(desired,observed) / verify(desired))
 * into the v1 `Provider` port the reconciler already drives:
 *   observe(scope) / apply(PlanAction) / verify(PlanAction).
 *
 * Design choices (spec-filha Bloco A; spec-mãe §5):
 *
 *   - SINGLE-KIND WRAPPER. One wrapper per entity-kind (firewall, primary_ip,
 *     certificate, load_balancer, ingress). The wrapper carries the kind +
 *     working store + v2 provider. observe(scope) enumerates the working store
 *     so the v1 reconciler sees v2 entities under the same ObservedSlice shape.
 *
 *   - DESIRED FROM PLANITEM. apply()/verify() receive a v1 PlanAction; we
 *     unpack action.desired as the v2 entity payload (typed `T`). plan.ts's
 *     desiredPayloads() flows this into PlanAction.desired in the canonical
 *     production path, so a wrapped v2 provider receives the same payload its
 *     working-store v2 tool wrote.
 *
 *   - OBSERVED LOOKUP. The v2 provider's apply()/verify() also want the
 *     observed snapshot. The wrapper calls v2.observe(name) lazily per action
 *     (one read per applied entity). This matches the F1.x–F5.x test pattern.
 *     A bulk-observe optimisation (one HTTP list call per scope, cached) is
 *     YAGNI for Bloco A — current entity counts are small (one ingress / a
 *     handful of LBs / etc) and the providers' own observe() is already
 *     bounded; a cache lands when load demands.
 *
 *   - ROUTER COMPOSITION. The reconciler still expects ONE v1 Provider; we add
 *     `createCompositeProvider(byKind, fallback)` that routes each PlanAction
 *     to the right wrapped sub-provider by entity-kind prefix (the `<kind>:`
 *     part of the `<kind>:<name>` key). v1 entities fall through to the v1
 *     provider unchanged (no regression).
 *
 *   - NO CHANGE TO V2 PROVIDERS. Adapter-only. Every existing v2 provider test
 *     continues to drive the v2 shape directly.
 */

import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import type { WorkingStore } from "../agent/v2/working-store.js";
import type { EnsureK3s, KubeManifest } from "../domain/entities-v2.js";
import type { KubernetesProvider } from "../providers/v2/kube-apply.js";
import { kubeIdentityKey } from "../providers/v2/kube-apply.js";
import type { EnsureK3sProvider } from "../providers/v2/ensure-k3s.js";
import { k3sIdentityKey } from "../providers/v2/ensure-k3s.js";

// ---------------------------------------------------------------------------
// V2 provider port — the shape every v2 provider in core/src/providers/v2/*
// already exports (FirewallProvider / PrimaryIPProvider / CertificateProvider
// / LoadBalancerProvider / IngressProvider). We capture only the methods the
// wrapper consumes (observe/apply/verify); the v2 provider's own `plan()` and
// any provider-specific extras are not part of the v1 reconciler contract.
// ---------------------------------------------------------------------------

export interface V2ProviderLike<T, O> {
  readonly name: string;
  /** Read the backend; returns null when the entity does not exist. */
  observe(arg: T | string): Promise<O | null>;
  /** Converge backend toward desired. Idempotent. */
  apply(desired: T, observed: O | null): Promise<{ changed: boolean }>;
  /** Read-only equality check (set/fail-safe semantics owned by provider). */
  verify(desired: T): Promise<boolean>;
}

/**
 * How a wrapped v2 provider obtains the `observed` snapshot it needs to hand
 * to its own apply()/verify(). Two shapes exist in v2:
 *
 *   - lookup-by-name:    observe(name: string)  (firewall / primary_ip /
 *                                                certificate / load_balancer)
 *   - lookup-by-desired: observe(desired: T)    (ingress — needs the desired
 *                                                refs to enumerate sub-entities)
 *
 * The wrapper does not need to know which; it just calls v2.observe with
 * whatever the caller declared this kind uses. Each wrapV2Provider() call
 * passes the right `observeArg(desired)` selector.
 */
export type ObserveArgFor<T> = (desired: T) => T | string;

export interface WrapV2Options<T extends { name: string }, O> {
  /** The entity-kind prefix used in PlanAction.entity, e.g. "firewall". */
  readonly entityKind: string;
  /** The v2 provider to wrap. */
  readonly v2: V2ProviderLike<T, O>;
  /** Working store this kind is sourced from. */
  readonly workingStore: WorkingStore<T>;
  /**
   * How to build the argument for v2.observe (name vs. desired). Defaults to
   * `(desired) => desired.name` — the lookup-by-name shape used by 4 of the 5
   * v2 providers. Ingress passes `(desired) => desired`.
   */
  readonly observeArg?: ObserveArgFor<T>;
}

/**
 * Wrap a v2 provider into the v1 `Provider` port the reconciler drives.
 *
 * The returned provider is single-kind — it handles ONLY PlanActions whose
 * entity key starts with `<entityKind>:`. Routing across kinds (firewall vs.
 * primary_ip vs. v1 server etc.) is done by `createCompositeProvider`.
 */
export function wrapV2Provider<T extends { name: string }, O>(
  opts: WrapV2Options<T, O>,
): Provider {
  const { entityKind, v2, workingStore } = opts;
  const observeArg = opts.observeArg ?? ((d: T) => d.name);
  const prefix = `${entityKind}:`;

  return {
    name: `v2-wrap(${v2.name})`,

    /**
     * v1 ObservedSlice surface: enumerate the working store's declared
     * entities under `<kind>:<name>` keys. The reconciler uses this to scope
     * the observed-store snapshot; it is NOT a deep observe of every backend
     * resource (the wrapped v2 provider's own observe() does that lazily per
     * applied entity in apply()/verify()).
     */
    async observe(scope: string): Promise<ObservedSlice> {
      if (scope !== entityKind) {
        return { scope, entities: [] };
      }
      const declared = await workingStore.list();
      // Desired-derived (declared working store) ⇒ minimal { name } payload.
      return {
        scope,
        entities: declared.map((d) => ({ key: `${prefix}${d.name}`, payload: { name: d.name } })),
      };
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      const desired = unpackDesired<T>(action, prefix);
      const observed = await v2.observe(observeArg(desired));
      const result = await v2.apply(desired, observed);
      return {
        entity: action.entity,
        op: action.op,
        changed: result.changed,
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      const desired = unpackDesired<T>(action, prefix);
      return v2.verify(desired);
    },
  };
}

// ---------------------------------------------------------------------------
// wrapKubeProvider — dedicated adapter for the bespoke KubernetesProvider
// (Bloco E Task 11)
//
// The KubernetesProvider (core/src/providers/v2/kube-apply.ts) does NOT fit the
// generic wrapV2Provider port for two reasons, so it gets its own thin adapter
// rather than weakening the generic (which would risk Bloco A's type safety):
//
//   1. NO TOP-LEVEL `name`. `KubeManifest` carries `metadata.name`, not a
//      top-level `name`, so it cannot satisfy `T extends { name: string }`.
//      Identity is the composite `kube:<host>/<ns>/<kind>/<name>` key produced
//      by `kubeIdentityKey` — used for both the PlanAction.entity prefix and
//      the observe() enumeration keys.
//
//   2. ctx-CARRYING, OBSERVE-BY-DESIRED apply. Its `apply(desired, observed,
//      ctx?)` takes the apply-only secrets.ts `ApplyContext` (to resolve
//      `secret:<ref>` tokens AT APPLY), and its `observe(manifest)` is
//      observe-by-desired (it needs the manifest's identity, like ingress's
//      `(d)=>d`). The generic `apply(desired, observed)` takes NO ctx.
//
// ACTOR / APPLY-CONTEXT INVARIANT (.claude/rules/state-event-actor.md): the
// actor / capability is sourced from the reconciler context and rides on
// `PlanAction.applyContext` (minted by the apply boundary). This adapter only
// PROPAGATES `action.applyContext` into kube.apply — it NEVER synthesises one.
// On plan/dry_run/verify paths the action carries no applyContext, so the kube
// apply receives `undefined` and is structurally unable to resolve a secret.
// ---------------------------------------------------------------------------

/**
 * The minimal store surface the kube wrapper's observe() enumerates. It is NOT
 * the generic `WorkingStore<T extends { name: string }>` — `KubeManifest` has
 * no top-level `name`, so the kube wrapper only requires `list()` over the
 * declared manifests (identity is derived via `kubeIdentityKey`).
 */
export interface KubeListSource {
  list(): Promise<readonly KubeManifest[]>;
}

export interface WrapKubeOptions {
  /** The bespoke KubernetesProvider to wrap. */
  readonly kube: KubernetesProvider;
  /** The kube working store this kind is sourced from (list-only surface). */
  readonly workingStore: KubeListSource;
}

const KUBE_KIND = "kube";

/**
 * Wrap the bespoke `KubernetesProvider` into the v1 `Provider` port the
 * reconciler drives. Single-kind: it handles ONLY `kube:` PlanActions; routing
 * across kinds is done by `createCompositeProvider`.
 */
export function wrapKubeProvider(opts: WrapKubeOptions): Provider {
  const { kube, workingStore } = opts;
  const prefix = `${KUBE_KIND}:`;

  return {
    name: `v2-wrap(${kube.name})`,

    /**
     * v1 ObservedSlice surface: enumerate the working store's declared
     * manifests under their canonical `kube:<host>/<ns>/<kind>/<name>` keys.
     * NOT a deep observe of the cluster (the kube provider's own observe()
     * does that lazily per applied entity in apply()/verify()).
     */
    async observe(scope: string): Promise<ObservedSlice> {
      if (scope !== KUBE_KIND) {
        return { scope, entities: [] };
      }
      const declared = await workingStore.list();
      return {
        scope,
        // Desired-derived ⇒ minimal payload (identity only). Observed-state
        // storage carries refs/identity only, never a secret value.
        entities: declared.map((m) => ({
          key: kubeIdentityKey(m),
          payload: { name: m.metadata.name },
        })),
      };
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      const desired = unpackKubeDesired(action, prefix);
      const observed = await kube.observe(desired);
      // PROPAGATE the action's applyContext — never synthesise a local one.
      const result = await kube.apply(desired, observed, action.applyContext);
      return {
        entity: action.entity,
        op: action.op,
        changed: result.changed,
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      const desired = unpackKubeDesired(action, prefix);
      return kube.verify(desired);
    },
  };
}

/**
 * Unpack `action.desired` as a `KubeManifest`. Mirrors `unpackDesired` but for
 * the kube shape (no top-level `name`). The composite router guarantees the
 * `kube:` prefix; we re-assert it for a clear error if dispatched wrongly.
 *
 * Per `.claude/rules/esm-nodenext.md` Rule 4, `action.desired` is `unknown` at
 * the port; here it is the working-store value `desiredPayloads` threaded
 * through verbatim (already a validated `KubeManifest` written by its tool), so
 * we narrow it without re-parsing — exactly as the generic `unpackDesired`
 * narrows its `T`.
 */
function unpackKubeDesired(action: PlanAction, prefix: string): KubeManifest {
  if (!action.entity.startsWith(prefix)) {
    throw new Error(
      `v2-wrap: PlanAction.entity "${action.entity}" does not match expected ` +
        `kind prefix "${prefix}" — composite router dispatched wrongly`,
    );
  }
  if (action.desired === undefined || action.desired === null) {
    throw new Error(
      `v2-wrap: PlanAction.desired is missing for entity "${action.entity}" ` +
        `— the reconciler must pass desiredPayloads from plan.ts`,
    );
  }
  return action.desired as KubeManifest;
}

// ---------------------------------------------------------------------------
// wrapEnsureK3sProvider — dedicated adapter for the bespoke EnsureK3sProvider
// (Bloco E Task 20)
//
// Mirrors wrapKubeProvider, but SIMPLER on two axes:
//
//   1. NO ApplyContext. The host axis resolves NO `secret:<ref>` (EnsureK3s
//      carries host/version/role only — entities-v2.ts §3.1), so the k3s
//      apply(desired, observed) takes NO ctx. The wrapper therefore does NOT
//      thread `action.applyContext` into it (unlike kube). The actor still
//      flows from the reconcile context for the recorded StateEvent — the
//      wrapper never synthesises one (state-event-actor.md).
//
//   2. OBSERVE-BY-DESIRED. Like ingress/kube, `observe(desired)` is keyed by
//      the recipe (k3sIdentityKey(desired) = `k3s:<host>`), not a top-level
//      `name` — so it does not fit the generic `T extends { name: string }`
//      wrapV2Provider port either.
//
// DRIFT MAPPING (Q-a version-divergence). EnsureK3sProvider.apply can return
// `{ changed:false, result:"drift" }` when k3s is present at a DIFFERENT
// version — it does NOT auto-upgrade / reinstall (install-only / fail-safe.md).
// The generic `ApplyResult` (provider.ts) has NO drift field; the reconciler's
// own apply path surfaces drift either as a plan-level `op:"drift"` item
// (apply.ts) or via the additive `ApplyResult.events` seam the Record step
// persists. We map the ensure_k3s `result:"drift"` to:
//
//     { entity, op, changed:false, events:[{ op:"drift" }] }
//
//   - `changed:false` — NO install ran (no mutation; never a converged change).
//   - a value-free `op:"drift"` event mirroring the canonical `DriftEventSpec`
//     (drift.ts: `op:"drift"`, value-free) so the divergence surfaces as DRIFT,
//     distinct from a plain converged no-op, WITHOUT inventing any destructive
//     / reinstall path. The divergent versions are NOT copied into the event
//     (no-leak + value-free drift, by construction).
//
// This is the mapping CLOSEST to the reconciler's existing drift handling: the
// `events` seam already feeds the Record step, and `op:"drift"` is the project-
// wide drift discriminator. fail-safe.md: drift is REPORT-ONLY here.
// ---------------------------------------------------------------------------

/**
 * The minimal store surface the k3s wrapper's observe() enumerates. NOT the
 * generic `WorkingStore<T extends { name: string }>` — `EnsureK3s` is keyed by
 * `host` (identity derived via `k3sIdentityKey`), so the wrapper only requires
 * `list()` over the declared recipes.
 */
export interface EnsureK3sListSource {
  list(): Promise<readonly EnsureK3s[]>;
}

export interface WrapEnsureK3sOptions {
  /** The bespoke EnsureK3sProvider to wrap. */
  readonly k3s: EnsureK3sProvider;
  /** The k3s working store this kind is sourced from (list-only surface). */
  readonly workingStore: EnsureK3sListSource;
}

const K3S_KIND = "k3s";

/**
 * Wrap the bespoke `EnsureK3sProvider` into the v1 `Provider` port the
 * reconciler drives. Single-kind: it handles ONLY `k3s:` PlanActions; routing
 * across kinds is done by `createCompositeProvider`.
 */
export function wrapEnsureK3sProvider(opts: WrapEnsureK3sOptions): Provider {
  const { k3s, workingStore } = opts;
  const prefix = `${K3S_KIND}:`;

  return {
    name: `v2-wrap(${k3s.name})`,

    /**
     * v1 ObservedSlice surface: enumerate the working store's declared recipes
     * under their canonical `k3s:<host>` keys. NOT a deep host inspection (the
     * k3s provider's own observe() does that lazily per applied entity in
     * apply()/verify()).
     */
    async observe(scope: string): Promise<ObservedSlice> {
      if (scope !== K3S_KIND) {
        return { scope, entities: [] };
      }
      const declared = await workingStore.list();
      return {
        scope,
        // Desired-derived ⇒ minimal payload (identity only). k3s status carries
        // no secrets; the payload is kept minimal regardless.
        entities: declared.map((r) => ({
          key: k3sIdentityKey(r),
          payload: { host: r.host },
        })),
      };
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      const desired = unpackK3sDesired(action, prefix);
      const observed = await k3s.observe(desired);
      // NO applyContext threaded — the host axis resolves no secret:<ref>.
      const result = await k3s.apply(desired, observed);
      // DRIFT MAPPING (Q-a): a version-divergence is `changed:false` PLUS a
      // value-free `op:"drift"` event — surfaced as drift, NOT a converged
      // change, and NEVER an install/reinstall (fail-safe.md). A plain
      // converged no-op (no `result`) carries no event.
      if (result.result === "drift") {
        return {
          entity: action.entity,
          op: action.op,
          changed: false,
          events: [{ op: "drift" }],
        };
      }
      return {
        entity: action.entity,
        op: action.op,
        changed: result.changed,
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      const desired = unpackK3sDesired(action, prefix);
      return k3s.verify(desired);
    },
  };
}

/**
 * Unpack `action.desired` as an `EnsureK3s`. Mirrors `unpackKubeDesired` (the
 * composite router guarantees the `k3s:` prefix; we re-assert it for a clear
 * error if dispatched wrongly). Per `.claude/rules/esm-nodenext.md` Rule 4
 * `action.desired` is `unknown` at the port; here it is the working-store value
 * threaded verbatim by `desiredPayloads` (already a validated `EnsureK3s`
 * written by its tool), so we narrow it without re-parsing — exactly as
 * `unpackKubeDesired`/`unpackDesired` narrow their `T`.
 */
function unpackK3sDesired(action: PlanAction, prefix: string): EnsureK3s {
  if (!action.entity.startsWith(prefix)) {
    throw new Error(
      `v2-wrap: PlanAction.entity "${action.entity}" does not match expected ` +
        `kind prefix "${prefix}" — composite router dispatched wrongly`,
    );
  }
  if (action.desired === undefined || action.desired === null) {
    throw new Error(
      `v2-wrap: PlanAction.desired is missing for entity "${action.entity}" ` +
        `— the reconciler must pass desiredPayloads from plan.ts`,
    );
  }
  return action.desired as EnsureK3s;
}

/**
 * Compose multiple v1 Providers into one router. For each PlanAction the
 * composite picks the sub-provider whose entity-kind matches the `<kind>:`
 * prefix of `action.entity`; observe(scope) delegates to the matching kind.
 * v1 entities (`network` / `server` / `volume` / `service`) flow through the
 * caller-supplied fallback provider unchanged ⇒ no v1 regression.
 *
 * Construction is data-driven (a kind→Provider map): the reconciler wires
 * v2-wrapped providers at startup; adding/removing a v2 kind is a one-line
 * map mutation. No dispatch switch lives in apply.ts/reconcile.ts.
 */
export function createCompositeProvider(opts: {
  readonly name?: string;
  readonly byKind: ReadonlyMap<string, Provider>;
  readonly fallback: Provider;
}): Provider {
  const { byKind, fallback } = opts;
  const compositeName = opts.name ?? "composite-provider";

  const pickByEntity = (entity: string): Provider => {
    const idx = entity.indexOf(":");
    if (idx <= 0) return fallback;
    const kind = entity.slice(0, idx);
    return byKind.get(kind) ?? fallback;
  };

  return {
    name: compositeName,

    async observe(scope: string): Promise<ObservedSlice> {
      const sub = byKind.get(scope);
      if (sub !== undefined) return sub.observe(scope);
      return fallback.observe(scope);
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      return pickByEntity(action.entity).apply(action);
    },

    async verify(action: PlanAction): Promise<boolean> {
      return pickByEntity(action.entity).verify(action);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function unpackDesired<T extends { name: string }>(
  action: PlanAction,
  prefix: string,
): T {
  if (!action.entity.startsWith(prefix)) {
    throw new Error(
      `v2-wrap: PlanAction.entity "${action.entity}" does not match expected ` +
        `kind prefix "${prefix}" — composite router dispatched wrongly`,
    );
  }
  if (action.desired === undefined || action.desired === null) {
    throw new Error(
      `v2-wrap: PlanAction.desired is missing for entity "${action.entity}" ` +
        `— the reconciler must pass desiredPayloads from plan.ts`,
    );
  }
  return action.desired as T;
}
