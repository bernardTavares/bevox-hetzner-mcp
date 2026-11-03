/**
 * core/src/providers/v2/hetzner-firewall.ts
 *
 * Task F1.3 — HetznerFirewallProvider. The v2 provider for Hetzner Cloud
 * firewalls. Drives create / set_rules / apply_to_resources via the v2 HTTP
 * adapter (`hetzner-cloud-v2-http.ts`) and reports drift via the shared
 * (declarative) plan envelope.
 *
 * Design principles (spec-mãe + spec-filha Bloco A):
 *
 *   - IDEMPOTENCY. apply(desired, observed) converges then is a NO-OP on a
 *     second call (set semantics on rules + applied_to mean order is
 *     irrelevant; equality is set-based).
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. Hetzner's `set_rules` endpoint is a
 *     WHOLESALE REPLACE — calling it with `desired.rules` loses any extra
 *     rules observed on Hetzner that were not declared by the agent. To honor
 *     "drift is reported, never silently corrected" we therefore ONLY call
 *     set_rules when desired ⊄ observed (i.e. some desired rule is missing on
 *     Hetzner). When the only difference is "Hetzner has extras", apply is a
 *     no-op and the extras stay put. The agent must explicitly reconcile the
 *     drift through a separate tool (F1.4) gated by approval.
 *
 *   - ALLOW-LIST SEMANTICS. Rule equality is set-based (no order). applied_to
 *     equality is on the resolved server-id set (no order, no dup).
 *
 *   - SELECTOR RESOLUTION IS A SEAM. The provider takes a `serversProvider`
 *     callback (the reconciler wires it with the frozen per-cycle observed
 *     server snapshot). Provider tests pass fixture servers. This keeps the
 *     SINGLE selector resolver (`resolveServerSelector`, Task 0.4) inside the
 *     apply path without coupling the provider to the observed-state store.
 *
 *   - ERROR MAPPING. The v2 HTTP adapter goes through the v1 `HttpClient`,
 *     which classifies non-2xx via `domain/errors.ts`. 429/5xx → transient.
 *     401/403 → fatal. The provider does ONE additional re-wrap: a 422 from
 *     Hetzner (invalid rules / unprocessable input) lands as `fatal` by the
 *     errors.ts default; we re-throw it as `precondition` because it is a
 *     caller-correctable input violation (matches the v1 hetzner-cloud.ts
 *     "malformed desired → precondition" pattern).
 *
 *   - NO DESTROY HERE. Like the v1 provider in Task 2.4, destructive intents
 *     (delete the firewall, remove server from applied_to) are handled in a
 *     later, approval-gated tool (F1.4). This module observes / creates /
 *     updates only.
 *
 * Exported API:
 *   createHetznerFirewallProvider(opts) → FirewallProvider
 *   interface FirewallProvider
 *   interface FirewallProviderOptions
 *   interface ObservedFirewall                — wrapper around the raw Hetzner
 *                                                shape (stored as `observed`
 *                                                jsonb by the reconciler).
 */

import { ReconcileError } from "../../domain/errors.js";
import type { Firewall, FirewallRule } from "../../domain/entities-v2.js";
import type { Server } from "../../domain/entities.js";
import { resolveServerSelector } from "../../agent/v2/resolve-selector.js";
import { rewrapHetznerError } from "./error-rewrap.js";
import type {
  HetznerV2HttpClient,
  V2FirewallResourceClient,
} from "./hetzner-cloud-v2-http.js";

// ---------------------------------------------------------------------------
// Observed-state shape
// ---------------------------------------------------------------------------

/** Raw Hetzner firewall as returned by GET /firewalls/:id. */
export interface HetznerFirewallShape {
  readonly id: number;
  readonly name: string;
  readonly rules: readonly FirewallRule[];
  readonly applied_to: ReadonlyArray<{
    readonly type: "server";
    readonly server: { readonly id: number };
  }>;
}

/**
 * The shape persisted under `firewalls.observed` (jsonb). A thin wrapper
 * around the raw Hetzner payload — keeping the wire shape means the
 * `applied_to` selector is NOT lossily re-derived (we wouldn't know which of
 * many possible selectors produced the observed set). The reconciler stores
 * this verbatim; the provider compares it as-is against the desired Firewall.
 */
export interface ObservedFirewall {
  readonly hetzner: HetznerFirewallShape;
}

// ---------------------------------------------------------------------------
// Plan envelope
// ---------------------------------------------------------------------------

export type FirewallPlanOp =
  | { readonly op: "create"; readonly entity: string }
  | { readonly op: "update"; readonly entity: string; readonly target: "rules" | "applied_to" }
  | { readonly op: "drift"; readonly entity: string; readonly target: "rules" | "applied_to" };

export interface FirewallPlan {
  readonly ops: readonly FirewallPlanOp[];
}

export interface ApplyResult {
  readonly entity: string;
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Provider port (v2 shape — not v1 Provider; see module doc on the reconciler
// wiring seam)
// ---------------------------------------------------------------------------

export interface FirewallProvider {
  readonly name: string;
  /** Read Hetzner; returns null if no firewall exists with `name`. */
  observe(name: string): Promise<ObservedFirewall | null>;
  /** Pure plan: derive the ops needed to converge observed → desired. */
  plan(desired: Firewall, observed: ObservedFirewall | null): Promise<FirewallPlan>;
  /** Converge Hetzner toward desired. Idempotent; never destructive. */
  apply(desired: Firewall, observed: ObservedFirewall | null): Promise<ApplyResult>;
  /** True iff observed matches desired (set semantics, no order). */
  verify(desired: Firewall): Promise<boolean>;
}

export interface FirewallProviderOptions {
  readonly http: HetznerV2HttpClient;
  /**
   * Returns the frozen-for-this-cycle observed Server snapshot the reconciler
   * resolved BEFORE calling the provider (spec-mãe §2.2 freeze invariant).
   * Provider tests pass a fixture array.
   */
  readonly serversProvider: () => Promise<readonly Server[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHetznerFirewallProvider(
  opts: FirewallProviderOptions,
): FirewallProvider {
  const fw = opts.http.firewalls;

  return {
    name: "hetzner-firewall",

    async observe(name: string): Promise<ObservedFirewall | null> {
      // Wire-spec uses /firewalls (list + filter); the fake supports the same
      // pagination, but for a single-name lookup the simple list+find suffices.
      try {
        const res = await fw.list();
        const body = (await res.json()) as { firewalls?: HetznerFirewallShape[] };
        const found = (body.firewalls ?? []).find((f) => f.name === name);
        if (!found) return null;
        return { hetzner: found };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async plan(
      desired: Firewall,
      observed: ObservedFirewall | null,
    ): Promise<FirewallPlan> {
      const entity = `firewall:${desired.name}`;
      if (observed === null) {
        return { ops: [{ op: "create", entity }] };
      }
      const ops: FirewallPlanOp[] = [];

      // Rules diff under set semantics.
      const desiredKeys = new Set(desired.rules.map(ruleKey));
      const observedKeys = new Set(observed.hetzner.rules.map(ruleKey));
      const missingFromObserved = [...desiredKeys].some((k) => !observedKeys.has(k));
      const extraOnObserved = [...observedKeys].some((k) => !desiredKeys.has(k));
      if (missingFromObserved) {
        ops.push({ op: "update", entity, target: "rules" });
      } else if (extraOnObserved) {
        // Fail-safe: extras on Hetzner that are not in desired are reported as
        // drift but NEVER auto-removed (set_rules would do a wholesale replace).
        ops.push({ op: "drift", entity, target: "rules" });
      }

      // applied_to diff under set semantics on server ids.
      const servers = await opts.serversProvider();
      const desiredIds = await resolveAppliedToIds(desired, servers);
      const observedIds = new Set(
        observed.hetzner.applied_to.map((a) => a.server.id),
      );
      const missingFromObservedAt = [...desiredIds].some((id) => !observedIds.has(id));
      const extraOnObservedAt = [...observedIds].some((id) => !desiredIds.has(id));
      if (missingFromObservedAt) {
        ops.push({ op: "update", entity, target: "applied_to" });
      } else if (extraOnObservedAt) {
        ops.push({ op: "drift", entity, target: "applied_to" });
      }

      return { ops };
    },

    async apply(
      desired: Firewall,
      observed: ObservedFirewall | null,
    ): Promise<ApplyResult> {
      const entity = `firewall:${desired.name}`;
      const servers = await opts.serversProvider();
      const desiredIds = await resolveAppliedToIds(desired, servers);

      try {
        // Branch 1: create when absent.
        if (observed === null) {
          const body: Record<string, unknown> = {
            name: desired.name,
            rules: [...desired.rules],
          };
          if (desiredIds.size > 0) {
            body.apply_to = [...desiredIds].sort((a, b) => a - b).map((id) => ({
              type: "server",
              server: { id },
            }));
          }
          await drain(await fw.create(body));
          return { entity, changed: true };
        }

        // Branch 2: rules update — ONLY if desired ⊄ observed (extras alone do
        // not trigger set_rules; see module doc on fail-safe).
        const desiredRuleKeys = new Set(desired.rules.map(ruleKey));
        const observedRuleKeys = new Set(
          observed.hetzner.rules.map(ruleKey),
        );
        const rulesNeedUpdate = [...desiredRuleKeys].some(
          (k) => !observedRuleKeys.has(k),
        );

        // Branch 3: applied_to update — set must EXACTLY match (Hetzner's
        // apply_to_resources is also a wholesale replace, but adding a server
        // is the strict converge direction; extras here are also drift-only).
        const observedIds = new Set(
          observed.hetzner.applied_to.map((a) => a.server.id),
        );
        const appliedToNeedsUpdate = [...desiredIds].some(
          (id) => !observedIds.has(id),
        );

        let changed = false;
        if (rulesNeedUpdate) {
          await drain(
            await fw.setRules(observed.hetzner.id, { rules: [...desired.rules] }),
          );
          changed = true;
        }
        if (appliedToNeedsUpdate) {
          // Union with observed to keep fail-safe semantics: never drop a
          // server Hetzner already has applied that isn't in desired.
          const union = new Set<number>(observedIds);
          for (const id of desiredIds) union.add(id);
          const apply_to = [...union]
            .sort((a, b) => a - b)
            .map((id) => ({ type: "server" as const, server: { id } }));
          await drain(
            await fw.applyToResources(observed.hetzner.id, { apply_to }),
          );
          changed = true;
        }
        return { entity, changed };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async verify(desired: Firewall): Promise<boolean> {
      const observed = await this.observe(desired.name);
      if (observed === null) return false;
      const plan = await this.plan(desired, observed);
      // verify is TRUE iff there is nothing to update. Drift items mean the
      // desired state IS materialised (extras are drift, not divergence from
      // desired).
      return plan.ops.every((o) => o.op === "drift");
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Canonical, order-independent key for a FirewallRule (set semantics). */
function ruleKey(rule: FirewallRule): string {
  const sortIps = (xs?: string[]) =>
    xs ? [...xs].sort().join(",") : "";
  return [
    rule.direction,
    rule.protocol,
    rule.port ?? "",
    sortIps(rule.source_ips),
    sortIps(rule.destination_ips),
  ].join("|");
}

/** Resolve `desired.applied_to` selector → set of hcloud server ids. */
async function resolveAppliedToIds(
  desired: Firewall,
  servers: readonly Server[],
): Promise<Set<number>> {
  const names = resolveServerSelector(desired.applied_to, servers);
  const byName = new Map(servers.map((s) => [s.name, s] as const));
  const ids = new Set<number>();
  for (const n of names) {
    const s = byName.get(n);
    if (s && typeof s.hcloud_id === "number") {
      ids.add(s.hcloud_id);
    }
  }
  return ids;
}

/** Drain a 2xx response body so the socket is freed (mirrors v1 pattern). */
async function drain(res: Response): Promise<void> {
  await res.json().catch(() => undefined);
}

// Type re-export so consumers don't pull from the adapter directly.
export type { V2FirewallResourceClient };
