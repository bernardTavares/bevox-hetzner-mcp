/**
 * core/src/providers/v2/hetzner-primary-ip.ts
 *
 * Task F2.3 — HetznerPrimaryIPProvider. The v2 provider for Hetzner Cloud
 * Primary IPs. Drives create / update / assign / unassign via the v2 HTTP
 * adapter (`hetzner-cloud-v2-http.ts`) and reports drift via the shared
 * (declarative) plan envelope.
 *
 * Design principles (spec-mãe + spec-filha Bloco A):
 *
 *   - IDEMPOTENCY. apply(desired, observed) converges then is a NO-OP on a
 *     second call. Assignment-equality is exact on (assignee_type, assignee_id);
 *     when desired matches observed the provider issues NO action call.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. Hetzner's assign/unassign are scoped
 *     surgical mutations (no wholesale-replace risk like firewall set_rules).
 *     But the SAME fail-safe stance applies to absent `assignee_selector`:
 *     omission is NOT an unassign command — only an EXPLICIT empty resolution
 *     (selector present but matches zero servers) AND observed already
 *     assigned triggers unassign. A missing selector means "agent did not
 *     declare an assignee here"; we leave any current assignment alone and
 *     report drift in plan. This guarantees an absent field never triggers
 *     destructive moves on the bill-bearing primary IP.
 *
 *   - SINGLE-SERVER INVARIANT (inline). `assignee_selector` must resolve to
 *     at most ONE server (a PrimaryIP is not a load balancer). The spec-filha
 *     hoists the canonical enforcement of this to the PolicyEngine (Bloco C);
 *     we duplicate the check inline at the apply boundary so the v2 provider
 *     is self-defending today and never issues a doomed `assign` call that
 *     would arbitrarily pick a server from the matched set.
 *     TODO(bloco-c): move to PolicyEngine per spec-filha §9.
 *
 *   - LOCATION IS IMMUTABLE. Hetzner sets `location`/`datacenter` at create
 *     and forbids in-place changes. Attempted change ⇒ `precondition_failed`
 *     (recreation is out of scope for this provider; F2.4's approval-gated
 *     tool will handle destroy/recreate flows). `type` (ipv4/ipv6) is
 *     similarly immutable.
 *
 *   - COST NOTE. Primary IPs are billed even when unassigned. F2.4 wires the
 *     always-approval-gated tool that creates/destroys them. F2.3 only
 *     converges already-declared IPs.
 *
 *   - SELECTOR RESOLUTION IS A SEAM. The provider takes a `serversProvider`
 *     callback (the reconciler wires it with the frozen per-cycle observed
 *     server snapshot, spec-mãe §2.2). Tests pass fixture servers.
 *
 *   - ERROR MAPPING. Inherited from F1.3: a 422 from Hetzner (which the
 *     http-client classifies as `fatal` by default) is re-wrapped to
 *     `precondition` since it represents caller-correctable input. Helper
 *     The shared `rewrapHetznerError` helper lives at `./error-rewrap.ts`
 *     (hoisted in F3.3 per F1.4 code review M1, once a third v2 provider
 *     needed the same shape).
 *
 * Exported API:
 *   createHetznerPrimaryIPProvider(opts) → PrimaryIPProvider
 *   interface PrimaryIPProvider
 *   interface PrimaryIPProviderOptions
 *   interface ObservedPrimaryIP                — wrapper around the raw Hetzner
 *                                                shape (stored as `observed`
 *                                                jsonb by the reconciler).
 */

import { ReconcileError } from "../../domain/errors.js";
import type { PrimaryIP } from "../../domain/entities-v2.js";
import type { Server } from "../../domain/entities.js";
import { resolveServerSelector } from "../../agent/v2/resolve-selector.js";
import { rewrapHetznerError } from "./error-rewrap.js";
import type {
  HetznerV2HttpClient,
  V2PrimaryIpResourceClient,
} from "./hetzner-cloud-v2-http.js";

// ---------------------------------------------------------------------------
// Observed-state shape
// ---------------------------------------------------------------------------

/** Raw Hetzner primary_ip as returned by GET /primary_ips/:id. */
export interface HetznerPrimaryIpShape {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly ip: string;
  readonly datacenter: { readonly name: string; readonly location?: { readonly name: string } };
  readonly assignee_type: string | null;
  readonly assignee_id: number | null;
  readonly labels?: Record<string, string>;
  readonly auto_delete?: boolean;
}

/**
 * The shape persisted under `primary_ips.observed` (jsonb). A thin wrapper
 * around the raw Hetzner payload — keeping the wire shape means assignee
 * state is NOT lossily re-derived from a selector (the selector is desired-
 * side metadata; the wire shape is the only source of truth for what is
 * currently assigned to whom).
 */
export interface ObservedPrimaryIP {
  readonly hetzner: HetznerPrimaryIpShape;
}

// ---------------------------------------------------------------------------
// Plan envelope
// ---------------------------------------------------------------------------

export type PrimaryIPPlanOp =
  | { readonly op: "create"; readonly entity: string }
  | { readonly op: "update"; readonly entity: string; readonly target: "assignment" }
  | { readonly op: "drift"; readonly entity: string; readonly target: "assignment" | "location" | "type" };

export interface PrimaryIPPlan {
  readonly ops: readonly PrimaryIPPlanOp[];
}

export interface ApplyResult {
  readonly entity: string;
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Provider port (v2 shape)
// ---------------------------------------------------------------------------

export interface PrimaryIPProvider {
  readonly name: string;
  /** Read Hetzner; returns null if no primary_ip exists with `name`. */
  observe(name: string): Promise<ObservedPrimaryIP | null>;
  /** Pure plan: derive ops needed to converge observed → desired. */
  plan(desired: PrimaryIP, observed: ObservedPrimaryIP | null): Promise<PrimaryIPPlan>;
  /** Converge Hetzner toward desired. Idempotent; never destructive. */
  apply(desired: PrimaryIP, observed: ObservedPrimaryIP | null): Promise<ApplyResult>;
  /** True iff observed materialises desired (under fail-safe drift rules). */
  verify(desired: PrimaryIP): Promise<boolean>;
}

export interface PrimaryIPProviderOptions {
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

export function createHetznerPrimaryIPProvider(
  opts: PrimaryIPProviderOptions,
): PrimaryIPProvider {
  const pip = opts.http.primaryIps;

  return {
    name: "hetzner-primary-ip",

    async observe(name: string): Promise<ObservedPrimaryIP | null> {
      try {
        const res = await pip.list();
        const body = (await res.json()) as { primary_ips?: HetznerPrimaryIpShape[] };
        const found = (body.primary_ips ?? []).find((p) => p.name === name);
        if (!found) return null;
        return { hetzner: found };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async plan(
      desired: PrimaryIP,
      observed: ObservedPrimaryIP | null,
    ): Promise<PrimaryIPPlan> {
      const entity = `primary_ip:${desired.name}`;
      if (observed === null) {
        return { ops: [{ op: "create", entity }] };
      }
      const ops: PrimaryIPPlanOp[] = [];

      // Immutables — divergence is drift, not an update.
      if (observed.hetzner.type !== desired.type) {
        ops.push({ op: "drift", entity, target: "type" });
      }
      if (!sameLocation(observed.hetzner, desired.location)) {
        ops.push({ op: "drift", entity, target: "location" });
      }

      // Assignment diff.
      const servers = await opts.serversProvider();
      const matched = desired.assignee_selector
        ? resolveServerSelector(desired.assignee_selector, servers)
        : [];
      const desiredAssigneeId =
        matched.length === 1 ? hcloudIdOf(matched[0]!, servers) : null;
      const observedAssigneeId =
        observed.hetzner.assignee_type === "server"
          ? observed.hetzner.assignee_id
          : null;

      if (desired.assignee_selector === undefined) {
        // Agent did not declare an assignee. Fail-safe: never silently
        // unassign. If Hetzner is currently assigned, that is drift; report
        // it but do not change anything in apply.
        if (observedAssigneeId !== null) {
          ops.push({ op: "drift", entity, target: "assignment" });
        }
      } else if (matched.length > 1) {
        // ≤1 invariant violation is enforced inline at apply; in plan we
        // surface it as drift on `assignment` so the agent sees the issue
        // pre-apply. Apply will refuse with precondition_failed.
        // TODO(bloco-c): move ≤1 enforcement to PolicyEngine.
        ops.push({ op: "drift", entity, target: "assignment" });
      } else if (desiredAssigneeId !== observedAssigneeId) {
        // Includes: matched 0 + observed assigned → unassign;
        //          matched 1 + observed unassigned/different → assign.
        ops.push({ op: "update", entity, target: "assignment" });
      }

      return { ops };
    },

    async apply(
      desired: PrimaryIP,
      observed: ObservedPrimaryIP | null,
    ): Promise<ApplyResult> {
      const entity = `primary_ip:${desired.name}`;
      const servers = await opts.serversProvider();

      // Resolve selector ONCE per apply (after freeze). The ≤1 invariant is
      // checked inline before any wire call so we never blindly assign.
      // TODO(bloco-c): hoist this to PolicyEngine.
      const matched = desired.assignee_selector
        ? resolveServerSelector(desired.assignee_selector, servers)
        : [];
      if (matched.length > 1) {
        throw new ReconcileError(
          "precondition",
          `assignee_selector for ${entity} matched ${matched.length} servers; a PrimaryIP can be assigned to at most one server`,
          { entity },
        );
      }
      const desiredAssigneeId =
        matched.length === 1 ? hcloudIdOf(matched[0]!, servers) : null;

      try {
        // Branch 1: create when absent. Bundle initial assignment in the
        // create payload to save one round-trip when possible.
        if (observed === null) {
          const body: Record<string, unknown> = {
            name: desired.name,
            type: desired.type,
            datacenter: desired.location,
          };
          if (desiredAssigneeId !== null) {
            body.assignee_type = "server";
            body.assignee_id = desiredAssigneeId;
          }
          await drain(await pip.create(body));
          return { entity, changed: true };
        }

        // Immutables: refuse in-place change of location or type. The agent
        // must explicitly destroy+recreate via F2.4 (approval-gated).
        if (observed.hetzner.type !== desired.type) {
          throw new ReconcileError(
            "precondition",
            `primary_ip:${desired.name} type immutable (observed=${observed.hetzner.type}, desired=${desired.type}); recreation required`,
            { entity },
          );
        }
        if (!sameLocation(observed.hetzner, desired.location)) {
          throw new ReconcileError(
            "precondition",
            `primary_ip:${desired.name} location immutable (observed=${observedLocation(observed.hetzner)}, desired=${desired.location}); recreation required`,
            { entity },
          );
        }

        // Assignment converge.
        const observedAssigneeId =
          observed.hetzner.assignee_type === "server"
            ? observed.hetzner.assignee_id
            : null;

        // Selector ABSENT: fail-safe, never silently unassign.
        if (desired.assignee_selector === undefined) {
          return { entity, changed: false };
        }

        // Already matches (both null OR both same id) — idempotent no-op.
        if (desiredAssigneeId === observedAssigneeId) {
          return { entity, changed: false };
        }

        if (desiredAssigneeId === null) {
          // Selector matched 0 servers AND observed is assigned → unassign.
          await drain(await pip.unassign(observed.hetzner.id));
          return { entity, changed: true };
        }

        // Selector matched 1 server AND observed differs (or is unassigned)
        // → assign. Hetzner's assign endpoint handles BOTH the
        // unassigned→assigned and assigned-to-other→assigned-to-X transitions
        // atomically (no need to unassign first).
        await drain(
          await pip.assign(observed.hetzner.id, {
            assignee_type: "server",
            assignee_id: desiredAssigneeId,
          }),
        );
        return { entity, changed: true };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async verify(desired: PrimaryIP): Promise<boolean> {
      const observed = await this.observe(desired.name);
      if (observed === null) return false;
      const plan = await this.plan(desired, observed);
      // verify is TRUE iff no `update` is pending. `drift` items reflect
      // out-of-band state we deliberately do NOT correct (fail-safe), so they
      // do not count as divergence from "desired is materialised".
      return plan.ops.every((o) => o.op === "drift");
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Resolve a matched server name → hcloud_id from the snapshot. */
function hcloudIdOf(name: string, servers: readonly Server[]): number | null {
  const s = servers.find((x) => x.name === name);
  return s && typeof s.hcloud_id === "number" ? s.hcloud_id : null;
}

/**
 * Hetzner's primary_ip wire shape exposes the datacenter (e.g. `fsn1-dc14`)
 * and optionally its parent location (e.g. `fsn1`). The desired schema uses
 * `location` as the user-friendly Hetzner field which can be EITHER value
 * depending on what the agent declared (the create endpoint accepts both via
 * the `datacenter` POST field). Equality is a string match against either.
 */
function observedLocation(shape: HetznerPrimaryIpShape): string {
  return shape.datacenter?.location?.name ?? shape.datacenter?.name ?? "";
}

function sameLocation(shape: HetznerPrimaryIpShape, desired: string): boolean {
  const dc = shape.datacenter?.name;
  const loc = shape.datacenter?.location?.name;
  return dc === desired || loc === desired;
}

/** Drain a 2xx response body so the socket is freed (mirrors v1 pattern). */
async function drain(res: Response): Promise<void> {
  await res.json().catch(() => undefined);
}

// Type re-export so consumers don't pull from the adapter directly.
export type { V2PrimaryIpResourceClient };
