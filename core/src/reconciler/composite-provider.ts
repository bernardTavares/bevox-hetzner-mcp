/**
 * core/src/reconciler/composite-provider.ts
 *
 * Task 3.5 — the minimal multi-backend Provider seam.
 *
 * `reconcile.ts` drives exactly ONE injected `Provider`, but a real Fase-3
 * manifest spans THREE concrete backends at once: HetznerCloud (networks,
 * servers, volumes), WireGuard (the private-mesh peer DERIVED from each managed
 * server), and Docker (service containers). This composite is the smallest
 * sound adapter that lets the unchanged Observe→Plan→Gate→Apply→Record cycle
 * converge such a manifest: it implements `Provider` and DELEGATES every
 * observe/apply/verify to the right concrete provider(s), routing by the
 * `<kind>` prefix of the `"<kind>:<name>"` entity key / scope.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; DRY/YAGNI):
 *
 *   - PURE DISPATCH, NO NEW DOMAIN LOGIC. This module adds NO convergence,
 *     diffing, ordering or secret logic. Each concrete provider already owns
 *     its idempotency/fail-safe contract (hetzner-cloud.ts / docker.ts /
 *     wireguard.ts); the composite only forwards. It therefore cannot weaken
 *     the Fase-2 idempotency guarantee — it is transparent w.r.t. it.
 *
 *   - SERVER FANS OUT TO TWO BACKENDS. The WireGuard mesh has one peer PER
 *     managed server (wireguard.ts: peers are derived from servers, not a
 *     manifest entity). So a `server:<name>` action must reach BOTH the
 *     HetznerCloud provider (provision the host) AND the WireGuard provider
 *     (program its mesh peer). For such fan-out:
 *       - apply():  every target is applied; `changed` is the OR (any backend
 *                   that mutated ⇒ this run changed). A converged server is a
 *                   strict no-op on BOTH ⇒ changed:false (idempotency holds).
 *       - verify(): every target must verify true (the server is converged iff
 *                   it is provisioned AND its mesh peer is programmed).
 *     network:/volume: → HetznerCloud only; service: → Docker only.
 *
 *   - OBSERVE IS THE UNION. observe(scope) merges the ObservedSlice of every
 *     backend that owns `scope` (deduped). This keeps the observed→adapter
 *     round-trip faithful so plan() sees a converged reality as all-`noop`
 *     (no false drift across backends).
 *
 *   - FAIL-SAFE PRESERVED. No backend here deletes anything; an unmanaged
 *     orphan in any backend remains the reconciler's drift concern (Task 2.9),
 *     unchanged. The composite never invents a destructive op.
 *
 * Exported API (ONLY this):
 *   compositeProvider(routes) → Provider
 *   interface CompositeRoutes
 *
 * NOTE: this is the smallest seam Task 3.5 needs to prove end-to-end
 * convergence; richer routing (per-entity policy, parallel fan-out) is not
 * required by any current task (YAGNI).
 */

import { ReconcileError } from "../domain/errors.js";
import type {
  ApplyResult,
  ObservedEntity,
  ObservedSlice,
  PlanAction,
  Provider,
} from "../providers/provider.js";

/**
 * Concrete backends keyed by the entity `<kind>` they own. `server` is an
 * ARRAY: a managed server fans out to its HetznerCloud host AND its WireGuard
 * mesh peer (see module doc). Every other kind maps to a single provider.
 */
export interface CompositeRoutes {
  readonly network: Provider;
  /** Fan-out: e.g. [HetznerCloud, WireGuard] — applied/verified on ALL. */
  readonly server: readonly Provider[];
  readonly volume: Provider;
  /**
   * Spec 2026-05-26 (tolerant-meta-scope-and-managed-services) §3 — OPTIONAL.
   * The `service:` kind routes to the Docker provider when supplied; absent
   * (MANAGED_SERVICES=off) ⇒ a `service:` action raises the same precondition
   * as any unsupported kind, and the meta-scope union skips the slot. Same
   * backward-compatibility contract as `dns`/`backup`.
   */
  readonly service?: Provider;
  /**
   * Task 5.4 — OPTIONAL, additive: the `dns:` kind routes to the
   * HetznerDNSProvider (5.2). Optional so every prior caller (Task 3.5
   * reconcile.services.test) that only supplied the four Fase-3 backends
   * stays byte-for-byte unchanged; a `dns:` action only reaches a backend
   * when this route is supplied (else the same precondition as any
   * unsupported kind — never a crash, never a silent no-op).
   */
  readonly dns?: Provider;
  /**
   * Task 5.4 — OPTIONAL, additive: the `backup:` kind routes to the restic
   * BackupProvider (5.3). Same backward-compatibility contract as `dns`.
   */
  readonly backup?: Provider;
}

/** The `<kind>` of a `"<kind>:<name>"` entity key or a bare scope. */
function kindOf(scopeOrEntity: string): string {
  return scopeOrEntity.split(":", 1)[0] ?? "";
}

export function compositeProvider(routes: CompositeRoutes): Provider {
  /** The ordered backend list owning `kind` (server fans out; else single). */
  function targetsFor(scopeOrEntity: string): readonly Provider[] {
    const kind = kindOf(scopeOrEntity);
    switch (kind) {
      case "network":
        return [routes.network];
      case "server":
        return routes.server;
      case "volume":
        return [routes.volume];
      case "service":
        // Spec 2026-05-26 (tolerant-meta-scope-and-managed-services) §3 —
        // route the `service:` kind to the Docker provider when supplied.
        // A missing route (MANAGED_SERVICES=off) falls through to the same
        // precondition as any unsupported kind (fail-safe — never a silent
        // no-op that would drop a declared Service).
        if (routes.service) return [routes.service];
        break;
      case "dns":
        // Task 5.4: route the `dns:` kind to the 5.2 provider when supplied.
        // No fan-out (DNS is a single backend); a missing route falls through
        // to the same precondition as any unsupported kind (fail-safe — never
        // a silent no-op that would drop a desired record).
        if (routes.dns) return [routes.dns];
        break;
      case "backup":
        // Task 5.4: route the `backup:` kind to the 5.3 provider when
        // supplied. Same contract as `dns`.
        if (routes.backup) return [routes.backup];
        break;
      default:
        break;
    }
    // Unsupported kind, OR a `service:`/`dns:`/`backup:` action with no
    // route supplied: a manifest/plan PRECONDITION, never a crash and never
    // a silent no-op — consistent with every concrete provider's
    // assertScope().
    throw new ReconcileError(
      "precondition",
      `compositeProvider: unsupported scope/kind "${kind}" ` +
        `(supported: network, server, volume` +
        `${routes.service ? ", service" : ""}` +
        `${routes.dns ? ", dns" : ""}${routes.backup ? ", backup" : ""})`,
      { entity: scopeOrEntity },
    );
  }

  return {
    name: "composite",

    async observe(scope: string): Promise<ObservedSlice> {
      if (scope === "manifest") {
        // Meta-scope: union of native observes across every backend.
        // Each backend receives its OWN scope (server/network/volume/
        // service/dns/backup), never the literal "manifest" — preserves
        // assertScope contracts in each concrete provider
        // (HetznerCloud/Docker/WireGuard/restic/Dns).
        //
        // The "manifest" scope is the literal the REST route /api/apply
        // declares (see core/src/agent/rest.ts) and the one
        // tools.ts:doApplyManifest forwards into reconcileToEnvelope on
        // the apply path. Without this branch the apply path falls
        // through to targetsFor("manifest") below and throws
        // `unsupported scope/kind "manifest"`, even though every backend
        // is reachable via its own per-kind observe.
        //
        // The visited Set dedups providers that route under multiple
        // kinds (HetznerCloud appears in routes.network + routes.server +
        // routes.volume in production wiring).
        //
        // Cite: docs/specs/2026-05-26-apply-manifest-meta-scope.md §2.
        // Dedup by entity key, FIRST-WINS (Q4 — snapshot stability): the
        // first backend to surface a key owns its payload.
        const seen = new Map<string, ObservedEntity>();
        const visited = new Set<Provider>();
        const visit = async (
          kind: string,
          p: Provider | undefined,
        ): Promise<void> => {
          // Skip undefined providers (MANAGED_SERVICES=off ⇒ routes.service
          // undefined; routes.dns/backup may also be undefined). Same pattern
          // as the `if (routes.dns)` / `if (routes.backup)` guards below.
          if (!p || visited.has(p)) return;
          visited.add(p);
          try {
            const slice = await p.observe(kind);
            for (const e of slice.entities) if (!seen.has(e.key)) seen.set(e.key, e);
          } catch (err) {
            // Tolerate per-backend failure during the meta-scope union:
            // continue with whatever succeeded. Drift detection of the
            // unreachable backend remains the periodic reconcile cycle's
            // responsibility (canonical drift channel — cf. v1 §5).
            //
            // VALUE-FREE warn: NEVER echo err.message (an upstream HTTP/SSH
            // error body may carry secret material — cite spec §4 #4 +
            // .claude/rules/secrets-resolution.md). Only the error class
            // name is recorded.
            //
            // Cite: docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md §2.
            const errorClass =
              err instanceof Error
                ? err.constructor.name || err.name || "Error"
                : "Error";
            console.warn(
              JSON.stringify({
                subsystem: "composite-meta-scope",
                kind,
                error: errorClass,
                msg:
                  "backend observe failed during manifest meta-scope union; " +
                  "continuing (spec 2026-05-26 §2). Periodic reconcile " +
                  "remains the canonical drift channel.",
              }),
            );
          }
        };
        await visit("network", routes.network);
        for (const p of routes.server) await visit("server", p);
        await visit("volume", routes.volume);
        await visit("service", routes.service);
        if (routes.dns) await visit("dns", routes.dns);
        if (routes.backup) await visit("backup", routes.backup);
        return { scope: "manifest", entities: [...seen.values()] };
      }
      // Union the slices of every backend owning this scope (deduped by key,
      // first-wins). A backend that does not model the scope returns none.
      const seen = new Map<string, ObservedEntity>();
      for (const p of targetsFor(scope)) {
        const slice = await p.observe(scope);
        for (const e of slice.entities) if (!seen.has(e.key)) seen.set(e.key, e);
      }
      return { scope, entities: [...seen.values()] };
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      // Fan-out apply: forward to every owning backend. `changed` is the OR —
      // any backend that mutated reality means this run changed; a converged
      // entity is changed:false on ALL backends ⇒ false (idempotency holds).
      let changed = false;
      for (const p of targetsFor(action.entity)) {
        const r = await p.apply(action);
        if (r.changed) changed = true;
      }
      return { entity: action.entity, op: action.op, changed };
    },

    async verify(action: PlanAction): Promise<boolean> {
      // Converged iff EVERY owning backend verifies true (a server is
      // converged only when both provisioned AND mesh-peered).
      for (const p of targetsFor(action.entity)) {
        if (!(await p.verify(action))) return false;
      }
      return true;
    },

    // Bug 8: route an APPROVED destroy to the owning backend(s) that implement
    // it. Backends without `destroy` are skipped (the kind has no destructive
    // executor yet — recorded no-op). `changed` is the OR across backends.
    async destroy(action: PlanAction): Promise<ApplyResult> {
      let changed = false;
      for (const p of targetsFor(action.entity)) {
        if (!p.destroy) continue;
        const r = await p.destroy(action);
        if (r.changed) changed = true;
      }
      return { entity: action.entity, op: action.op, changed };
    },
  };
}
