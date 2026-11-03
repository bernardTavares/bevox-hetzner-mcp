/**
 * core/src/agent/v2/set-ingress.ts
 *
 * Task F5.3 — `set_ingress` (v2 write tool).
 *
 * Surface: a single `setIngress(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/ingresses` route and the MCP `set_ingress` tool call —
 * single source of truth across transports (same envelope, same StateEvent,
 * same DNS-touch destructive classification). Mirrors F1.4 / F2.4 / F3.5 /
 * F4.4 for every cross-cutting concern (deny-before-write, working-store
 * seam, gate routing, neutral v2 envelope); see those modules' headers.
 *
 * Approval branching (spec-mãe §3 Bloco A; F5.3 brief):
 *
 *   - NO APPROVAL ON CREATE. A brand-new Ingress (observed === null) is a
 *     fresh DNS record creation — consistent with v1 `set_dns` (which is
 *     no-Approval). Fail-safe: nothing existing is being invalidated.
 *
 *   - APPROVAL ON HOSTNAME CHANGE. Changing `hostname` between the desired
 *     Ingress and the working desired (or observed) means the OLD A/AAAA
 *     records become stale: their target IP no longer terminates the
 *     hostname. This is the destructive removal class — DNS removal under an
 *     active LB ⇒ Approval required (same gating discipline as F1.4's
 *     "destructive removal" gate).
 *
 *   - APPROVAL ON load_balancer_ref CHANGE. The same destructive class:
 *     re-pointing DNS at a different LB IP. Treated identically to a
 *     hostname change (DNS now points to a different LB; old IP is stale).
 *
 *   - NO APPROVAL on `routes` / `firewall_ref` / `tls.certificate_ref`
 *     changes alone — these are in-place updates the LB / firewall / cert
 *     sub-providers absorb without DNS impact.
 *
 *   - NO APPROVAL on idempotent no-op (observed exists AND composite plan is
 *     empty or only `drift` ops): `applied` with empty ops, NO approval, NO
 *     working-store write, NO StateEvent.
 *
 * LOOKUP SEAMS. The IngressProvider needs to resolve `certificate_ref`,
 * `firewall_ref`, `load_balancer_ref` to entities. The tool's caller wires
 * those callbacks (typically reading from the respective working stores —
 * `WorkingCertificateStore` / `WorkingFirewallStore` / `WorkingLoadBalancerStore`).
 * Dangling refs surface as a `precondition` error envelope (the IngressProvider
 * throws `ReconcileError("precondition")` per F5.2).
 *
 * Working-store: the 5th use of the generic `WorkingStore<T>` (hoisted in
 * F4.4). Type-alias only — same in-memory factory.
 *
 * StateEvent on `applied` carries `capability_token_id: null` (per spec-mãe
 * §1.4 — Bloco C activates real population).
 */

import type pg from "pg";

import {
  assertV2Capability,
  type VerifiedCredential,
} from "../capability.js";
import { actorOf } from "../auth.js";
import {
  buildV2WriteEnvelope,
  type WriteEnvelopeV2,
} from "./envelope-v2.js";
import {
  IngressSchema,
  type Ingress,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type {
  IngressPlan,
  IngressProvider,
  ObservedIngress,
} from "../../providers/v2/ingress.js";
import type { PlanItem } from "../../domain/entities.js";
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";
import { appendEvent } from "../../store/state-events.js";
// Spec docs/specs/2026-05-27-mcp-string-interop-batch.md — defensive MCP
// client interop helpers (string→object/bool coercion).
import { asBool, asRecord } from "../tools.js";
import {
  createInMemoryWorkingStore,
  type WorkingStore,
} from "./working-store.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

export interface SetIngressInput {
  /** Pure planning — never writes desired-state, never opens approvals. */
  readonly dry_run?: boolean;
  /** Desired Ingress — parsed via the FROZEN `IngressSchema`. */
  readonly ingress: unknown;
}

export interface SetIngressCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope (defaulted to "ingress" by callers). */
  readonly scope: string;
}

/**
 * v2 working-store seam for Ingresses — the 5th instance of the generic
 * `WorkingStore<T>` (hoisted in F4.4; see ./working-store.ts).
 */
export type WorkingIngressStore = WorkingStore<Ingress>;

/** Trivial in-memory implementation — the default Bloco-A backing store. */
export function createInMemoryWorkingIngressStore(): WorkingIngressStore {
  return createInMemoryWorkingStore<Ingress>();
}

/**
 * Injected dependencies. The tool OWNS no I/O — it wires the already-built
 * pieces (provider, gate, store, pg pool for StateEvent append).
 *
 * NOTE on `approvalGate`: F5.3 only routes DNS-touch destructive items
 * (hostname / load_balancer_ref changes) through the gate, and they are
 * synthesised as `op:"destroy"` — covered by the default `defaultSensitiveOps`.
 * Callers/tests therefore do NOT need a `isSensitive:()=>true` gate (in
 * contrast to F2.4/F3.5-uploaded/F4.4 which gate on `create`/`update` too).
 */
export interface SetIngressDeps {
  readonly pool: pg.Pool;
  readonly provider: IngressProvider;
  readonly approvalGate: ReconcileGate;
  readonly workingStore: WorkingIngressStore;
}

// ---------------------------------------------------------------------------
// setIngress — the single dispatch
// ---------------------------------------------------------------------------

export async function setIngress(
  input: SetIngressInput,
  ctx: SetIngressCtx,
  deps: SetIngressDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE.
  try {
    assertV2Capability(ctx.credential, "set_ingress");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse desired through the FROZEN schema.
  let desired: Ingress;
  try {
    desired = IngressSchema.parse(asRecord(input.ingress));
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid ingress input: ${(err as Error).message}`,
        { entity: "ingress" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `ingress:${desired.name}`;
  const actor = actorOf(ctx.credential);

  // (3) Observed: the composite (cert + lb + fw) state via the provider, plus
  //     the prior WORKING DESIRED-STATE Ingress (if any). The working-store
  //     copy is the source of truth for the destructive classification — it
  //     pins the agent's previously-declared `hostname` / `load_balancer_ref`,
  //     which is what DNS records are pointing at. Observed Hetzner state is
  //     used by the provider's plan/apply.
  // F4.5 — gate observe() behind !dryRun: dry_run is pure introspection
  // and must NEVER make a live HTTP call. plan(desired, null) returns the
  // composite create-from-empty plan (sub-providers' create ops), which is
  // the correct dry_run output.
  let observed: ObservedIngress | null = null;
  if (!dryRun) {
    try {
      observed = await deps.provider.observe(desired);
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }

  let prior: Ingress | null;
  try {
    prior = await deps.workingStore.get(desired.name);
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (4) Composite plan via the provider's pure plan(). Dangling refs throw
  //     `precondition` per F5.2 — propagate as the error envelope.
  let plan: IngressPlan;
  try {
    plan = await deps.provider.plan(desired, observed);
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (5) Dry-run → planned. NEVER writes desired-state, NEVER opens an
  //     approval, NEVER emits a StateEvent.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...plan.ops] },
    });
  }

  // (6) DESTRUCTIVE CLASSIFICATION. A change is DNS-destructive iff:
  //       - a prior working desired exists, AND
  //       - either `hostname` OR `load_balancer_ref` differs. Both flip the
  //         existing A/AAAA records (hostname directly; lb-ref via the LB's
  //         public IP). The OLD records become stale ⇒ removal under active
  //         traffic ⇒ Approval required.
  //     A brand-new Ingress (prior === null) is NEVER destructive (create).
  //     Routes / firewall_ref / tls.certificate_ref differences alone are
  //     NOT destructive — they're in-place sub-provider updates.
  const dnsDestructive =
    prior !== null &&
    (prior.hostname !== desired.hostname ||
      prior.load_balancer_ref !== desired.load_balancer_ref);

  // (7) Idempotent no-op short-circuit. When the working store already holds
  //     this exact desired AND the composite plan has no real changes (only
  //     drift / empty), the tool returns `applied` empty-ops — NO approval,
  //     NO working-store write (it's already there), NO StateEvent.
  const hasRealChange = plan.ops.some((o) => o.op !== "drift");
  if (prior !== null && !hasRealChange && !dnsDestructive) {
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [] },
    });
  }

  // (8) DNS-destructive + not-dry-run → route through the SAME gate as F1.4
  //     destructive removal. Synthesise a single SENSITIVE PlanItem
  //     (`op:"destroy"`, covered by `defaultSensitiveOps`). Fail-safe: the
  //     working store is NOT written; the gate opens (or reuses) a pending
  //     approval and we surface its exact id.
  if (dnsDestructive) {
    const change =
      prior!.hostname !== desired.hostname
        ? `change ingress ${desired.name} hostname ${prior!.hostname} → ${desired.hostname}`
        : `re-point ingress ${desired.name} to load_balancer ${desired.load_balancer_ref}`;
    const item: PlanItem = {
      op: "destroy",
      entity,
      change,
      impact:
        "ingress DNS records currently point at the active load balancer — re-pointing requires approval",
    };
    const gateCtx: GateContext = {
      scope: `agent:${actor}:${ctx.scope}`,
      actor,
    };
    let approvalId: string | undefined;
    try {
      const decision = await deps.approvalGate.evaluate([item], gateCtx);
      if (decision.denied.length > 0) {
        const picked = (decision.pendingApprovals ?? []).find(
          (p) => p.entity === entity && p.op === "destroy",
        );
        approvalId = picked?.approvalId;
      }
    } catch (err) {
      return toErrorEnvelope(err);
    }
    if (approvalId !== undefined) {
      return buildV2WriteEnvelope({
        status: "pending_approval",
        approval_id: approvalId,
        plan: { ops: [...plan.ops] },
      });
    }
    // No pending id surfaced — either pass-through gate OR invariant breach.
    // Fail-safe: refuse the destructive write, surface fatal.
    return toErrorEnvelope(
      new ReconcileError(
        "fatal",
        "DNS-destructive ingress change withheld but no pending approval id was reported",
        { entity },
      ),
    );
  }

  // (9) Non-destructive path. Write the working desired-state + emit a
  //     single StateEvent (capability_token_id null — Bloco C activates).
  //     The reconciler converges Hetzner via the IngressProvider on its next
  //     cycle (no provider.apply() here — same discipline as F4.4 which
  //     declines to drive recreate flow; F5.3 only records intent).
  const syntheticOp: "create" | "update" =
    prior === null ? "create" : "update";
  try {
    await deps.workingStore.put(desired.name, desired);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  try {
    await appendEvent(deps.pool, {
      actor,
      scope: ctx.scope,
      op: syntheticOp,
      entity,
      result: "applied",
      after: {
        hostname: desired.hostname,
        load_balancer_ref: desired.load_balancer_ref,
        tls: { certificate_ref: desired.tls.certificate_ref },
        ...(desired.firewall_ref !== undefined
          ? { firewall_ref: desired.firewall_ref }
          : {}),
        capability_token_id: null,
      },
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
  return buildV2WriteEnvelope({ status: "applied" });
}

// ---------------------------------------------------------------------------
// Internal: error envelope (no-leak)
// ---------------------------------------------------------------------------

function toErrorEnvelope(err: unknown): WriteEnvelopeV2 {
  if (err instanceof ReconcileError) {
    return buildV2WriteEnvelope({
      status: "error",
      error: err.toApiError(),
    });
  }
  return buildV2WriteEnvelope({
    status: "error",
    error: new ReconcileError("fatal", "set_ingress failed", {
      entity: "ingress",
    }).toApiError(),
  });
}
