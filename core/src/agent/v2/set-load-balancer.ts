/**
 * core/src/agent/v2/set-load-balancer.ts
 *
 * Task F4.4 — `set_load_balancer` (v2 write tool).
 *
 * Surface: a single `setLoadBalancer(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/load-balancers` route and the MCP `set_load_balancer`
 * tool call — single source of truth across transports (same envelope, same
 * StateEvent, same approval classification). Mirrors F1.4 (`setFirewall`),
 * F2.4 (`setPrimaryIp`), and F3.5 (`setCertificate`) for every cross-cutting
 * concern (deny-before-write, working-store seam, gate routing, neutral v2
 * envelope) — read those files' headers for the underlying design.
 *
 * Design (spec-mãe + spec-filha Bloco A; F4.4 brief):
 *
 *   - APPROVAL ALWAYS for every non-no-op. A Load Balancer is a BILLED Hetzner
 *     resource (the cost rationale that drives F2.4 `set_primary_ip`'s
 *     approval-always stance applies verbatim). Additionally, a location
 *     change forces a destroy+create (the F4.3 provider surfaces this as a
 *     single `recreate` plan op with `impact:"public IP will change"`) — the
 *     public-IP change is a customer-visible destructive side-effect that
 *     MUST never happen without explicit human approval. ⇒ Every non-no-op
 *     ⇒ `pending_approval`. The only non-approval write path is the
 *     idempotent no-op (observed exists AND plan ops are empty or only
 *     `drift`) — in which case we short-circuit to `applied` with empty ops
 *     (no gate, no desired-state write, no StateEvent).
 *
 *   - LOCATION-CHANGE PLAN SURFACE. The provider's plan emits a single
 *     `recreate` op carrying `impact:"public IP will change"`; we propagate
 *     the plan ops VERBATIM into the envelope's `plan.ops`. The agent reading
 *     the envelope sees the impact note BEFORE issuing the approval — this is
 *     the agent-visible signal that the public IP will change.
 *
 *   - RECREATE FLOW (deferred). F4.4 itself does NOT drive the destroy+create
 *     sequence. The F4.3 provider's `apply()` REJECTS a location-change with
 *     `precondition` ("set_load_balancer tool drives recreation"). The F5.4
 *     reconciler-or-tool-level work is what actually performs the destroy
 *     +create after approval (and/or the agent must subsequently issue an
 *     explicit `destroy_load_balancer` then re-issue `set_load_balancer` once
 *     that tool exists). For F4.4, the tool ONLY gates approval and surfaces
 *     the plan — that is the minimum-viable semantic that keeps the public IP
 *     safe from silent destruction.
 *
 *   - WORKING-STORE SEAM. Hoisted in this task to the generic
 *     `WorkingStore<T>` in `./working-store.ts` (the rule-of-three deferred
 *     from F2.4 — see that module header). F1.4/F2.4/F3.5 are now thin
 *     type-aliases over the generic; F4.4's `WorkingLoadBalancerStore` is the
 *     FOURTH instance.
 *
 *   - GATE MUST BE APPROVAL-ALWAYS. Because the synthetic PlanItem's `op`
 *     (`create`/`update`/`destroy`) may not always be in `defaultSensitiveOps`
 *     for `create`/`update` cases, callers wiring `setLoadBalancer` MUST
 *     construct the injected `approvalGate` with `isSensitive: () => true`
 *     (same contract as F2.4/F3.5-uploaded).
 *
 *   - StateEvent on `applied` carries `capability_token_id: null` (same as
 *     F1.4/F2.4/F3.5; Bloco C activates real population).
 *
 * Open concern carried over from F1.4 review M4: the working-store-put then
 * StateEvent-append pair is NOT atomic. Bloco A keeps the working store
 * in-memory (no durable surface to drift); Bloco C lands a durable backing
 * store with an atomic write seam.
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
  LoadBalancerSchema,
  type LoadBalancer,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type {
  LoadBalancerProvider,
  ObservedLoadBalancer,
} from "../../providers/v2/hetzner-load-balancer.js";
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

export interface SetLoadBalancerInput {
  /** Pure planning — never writes desired-state, never opens approvals. */
  readonly dry_run?: boolean;
  /** Desired LoadBalancer — parsed via the FROZEN `LoadBalancerSchema`. */
  readonly load_balancer: unknown;
}

export interface SetLoadBalancerCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope (defaulted to "load_balancer" by callers). */
  readonly scope: string;
}

/**
 * The v2 working-store seam for LoadBalancers — the FOURTH instance of the
 * generic `WorkingStore<T>` (hoisted in F4.4; see ./working-store.ts).
 */
export type WorkingLoadBalancerStore = WorkingStore<LoadBalancer>;

/** Trivial in-memory implementation — the default Bloco-A backing store. */
export function createInMemoryWorkingLoadBalancerStore(): WorkingLoadBalancerStore {
  return createInMemoryWorkingStore<LoadBalancer>();
}

/**
 * Injected dependencies. The tool OWNS no I/O — it wires the already-built
 * pieces (provider, gate, store, pg pool for StateEvent append).
 *
 * IMPORTANT: `approvalGate` MUST be constructed with `isSensitive: () => true`
 * so that EVERY non-no-op synthetic PlanItem is gated. The default
 * `defaultIsSensitive` only flags destroy/remove/restore; using the default
 * here would silently bypass approval for create/update — a cost / public-IP
 * leak. Callers/tests are responsible.
 */
export interface SetLoadBalancerDeps {
  readonly pool: pg.Pool;
  readonly provider: LoadBalancerProvider;
  readonly approvalGate: ReconcileGate;
  readonly workingStore: WorkingLoadBalancerStore;
}

// ---------------------------------------------------------------------------
// setLoadBalancer — the single dispatch
// ---------------------------------------------------------------------------

export async function setLoadBalancer(
  input: SetLoadBalancerInput,
  ctx: SetLoadBalancerCtx,
  deps: SetLoadBalancerDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE.
  try {
    assertV2Capability(ctx.credential, "set_load_balancer");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse desired through the FROZEN schema.
  let desired: LoadBalancer;
  try {
    desired = LoadBalancerSchema.parse(asRecord(input.load_balancer));
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid load_balancer input: ${(err as Error).message}`,
        { entity: "load_balancer" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `load_balancer:${desired.name}`;
  const actor = actorOf(ctx.credential);

  // (3) Observe Hetzner + compute the diff via the provider's pure plan().
  //     F4.2 — gate observe() behind !dryRun: dry_run is pure introspection
  //     and must NEVER make a live HTTP call. plan(desired, null) returns
  //     the create-from-empty plan, which is the correct dry_run output.
  let observed: ObservedLoadBalancer | null = null;
  if (!dryRun) {
    try {
      observed = await deps.provider.observe(desired.name);
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }

  let planOps: readonly { op: string; entity: string; impact?: string }[];
  try {
    const p = await deps.provider.plan(desired, observed);
    planOps = p.ops as readonly {
      op: string;
      entity: string;
      impact?: string;
    }[];
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (4) Dry-run → planned. The plan ops (including the `recreate` op with its
  //     `impact:"public IP will change"` note) flow through VERBATIM — the
  //     agent reading the envelope sees the impact pre-apply.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...planOps] },
    });
  }

  // (5) Non-dry-run path. Two cases:
  //       (a) Idempotent no-op — observed exists AND plan is empty (or only
  //           `drift` items, which we deliberately do NOT correct, fail-safe).
  //           Nothing changes ⇒ surface `applied` with empty ops; NO approval,
  //           NO desired-state write, NO StateEvent.
  //       (b) ANY real change ⇒ approval-always (cost + possible recreation).
  const hasRealChange = planOps.some((o) => o.op !== "drift");
  if (observed !== null && !hasRealChange) {
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [] },
    });
  }

  // (6) Approval-always for every non-no-op. Synthesise a single PlanItem
  //     whose `op` is semantically truthful within the FROZEN PlanOpEnum:
  //       - observed null  ⇒ `create` (fresh allocation)
  //       - recreate plan  ⇒ `destroy` (destroy+create flow; the destructive
  //                           side is what the human is approving)
  //       - otherwise      ⇒ `update`
  //     The envelope's `plan.ops` (passed unchanged from the provider) carries
  //     the agent-visible detail (incl. the `recreate` op + impact note); the
  //     synthetic PlanItem's `impact` field also surfaces the public-IP note
  //     when applicable so the approval row records it.
  const recreateOp = planOps.find((o) => o.op === "recreate");
  const syntheticOp: "create" | "update" | "destroy" =
    observed === null ? "create" : recreateOp ? "destroy" : "update";
  const item: PlanItem = {
    op: syntheticOp,
    entity,
    change:
      syntheticOp === "create"
        ? `allocate load_balancer ${desired.name} (${desired.algorithm} @ ${desired.location})`
        : syntheticOp === "destroy"
          ? `recreate load_balancer ${desired.name} (location change ${desired.location})`
          : `update load_balancer ${desired.name}`,
    impact: recreateOp
      ? (recreateOp.impact ?? "public IP will change")
      : "load balancer is a billed Hetzner resource — approval required",
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
        (p) => p.entity === entity && p.op === syntheticOp,
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
      // Include the plan ops so the agent's pending_approval response carries
      // the recreate/impact context (same data the dry_run envelope returned).
      plan: { ops: [...planOps] },
    });
  }

  // (7) Gate APPROVED. Write the working desired-state + emit a single
  //     StateEvent (capability_token_id null — Bloco C activates real
  //     population). NOTE: F4.4 deliberately does NOT call provider.apply()
  //     here — the F4.3 provider refuses location-change apply with
  //     `precondition`. Driving the actual destroy+create sequence is F5.4 /
  //     future work; F4.4's responsibility ends at gating approval and
  //     recording desired-state intent.
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
        location: desired.location,
        algorithm: desired.algorithm,
        targets: desired.targets,
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
    error: new ReconcileError("fatal", "set_load_balancer failed", {
      entity: "load_balancer",
    }).toApiError(),
  });
}
