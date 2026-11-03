/**
 * core/src/agent/v2/set-primary-ip.ts
 *
 * Task F2.4 — `set_primary_ip` (v2 write tool).
 *
 * Surface: a single `setPrimaryIp(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/primary-ips` route and the MCP `set_primary_ip` tool
 * call — single source of truth across transports (same envelope, same
 * StateEvent, same approval classification). Mirrors F1.4 (`setFirewall`)
 * for every cross-cutting concern (deny-before-write, working-store seam,
 * gate routing, neutral v2 envelope) — read that file's header for the
 * underlying design; the deltas vs F1.4 are documented inline below.
 *
 * Why a SECOND in-memory working-store seam (vs hoisting a generic helper):
 *   Rule of three — `WorkingFirewallStore` (F1.4) is the first; this is the
 *   second. The third (Certificate, F3.5) will trigger extraction. Until
 *   then we duplicate to keep the seam local and the diff small.
 *   TODO(after F3.5): hoist a generic `WorkingDesiredStateStore<T>` helper.
 *
 * Open concern carried over from F1.4 review M4: the
 * working-store-put-then-StateEvent-append pair is NOT atomic (the put can
 * succeed and the append fail). Bloco A keeps the working store in-memory
 * (no durable surface to drift), so the practical exposure is nil; Bloco C
 * will land a durable backing store and an atomic write seam.
 *
 * Deltas vs F1.4:
 *
 *   - APPROVAL ALWAYS (when not dry_run). A PrimaryIP is BILLED even when
 *     unassigned (spec-mãe §3 PrimaryIP; spec-filha Bloco A); EVERY non-no-op
 *     change (create OR assignment update) is therefore approval-gated, not
 *     just "destructive" rule removal as in F1.4. The only non-approval write
 *     path is the idempotent no-op (observed exists AND empty plan ops) — in
 *     which case we short-circuit to `applied` with empty ops (no gate, no
 *     desired-state write, no StateEvent — nothing changed).
 *
 *   - INLINE ≤1 SERVER CHECK. The F2.3 provider already enforces this at the
 *     apply boundary; we duplicate it here at the tool boundary so an
 *     invariant violation NEVER reaches the gate (cheaper, clearer failure).
 *     `assignee_selector` resolving to >1 servers ⇒ `precondition_failed`
 *     error envelope, NO working-store write, NO approval row, NO StateEvent.
 *     TODO(bloco-c): hoist this to the PolicyEngine (spec-filha §9).
 *
 *   - SYNTHETIC PLANITEM OP. We synthesise a single PlanItem driving the
 *     gate's `evaluate()`: `op:"create"` when observed is null (a fresh
 *     PrimaryIP allocation) and `op:"update"` otherwise. The semantic op is
 *     recorded in `approvals.op` — agents reading the approvals list see
 *     the actual intent (NOT a misleading `destroy`/`remove`).
 *
 *   - GATE MUST BE APPROVAL-ALWAYS. Because `create`/`update` are NOT in
 *     `defaultSensitiveOps` (which only treats `destroy`/`remove`/`restore`
 *     as sensitive), callers wiring `setPrimaryIp` MUST construct the
 *     injected `approvalGate` with `isSensitive: () => true`. Documented on
 *     the deps field; tests assert end-to-end that a non-no-op yields
 *     `pending_approval`.
 *
 *   - StateEvent on `applied` carries `capability_token_id: null` (same as
 *     F1.4; Bloco C activates real population).
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
import { resolveServerSelector } from "./resolve-selector.js";
import {
  PrimaryIPSchema,
  type PrimaryIP,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type {
  PrimaryIPProvider,
  ObservedPrimaryIP,
} from "../../providers/v2/hetzner-primary-ip.js";
import type { Server, PlanItem } from "../../domain/entities.js";
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

/** The tool input as it arrives from REST body / MCP arguments. */
export interface SetPrimaryIpInput {
  /** Pure planning — never writes desired-state, never opens approvals. */
  readonly dry_run?: boolean;
  /** Desired PrimaryIP — parsed via the FROZEN `PrimaryIPSchema`. */
  readonly primary_ip: unknown;
}

/** Per-call context the caller (REST/MCP) supplies. */
export interface SetPrimaryIpCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope (defaulted to "primary_ip" by callers). */
  readonly scope: string;
}

/**
 * The minimal v2 working-store seam for PrimaryIPs. Hoisted in F4.4 to the
 * generic `WorkingStore<T>` (see ./working-store.ts); kept as a type-alias
 * here so every existing caller is byte-for-byte unchanged.
 */
export type WorkingPrimaryIpStore = WorkingStore<PrimaryIP>;

/** Trivial in-memory implementation — the default Bloco-A backing store. */
export function createInMemoryWorkingPrimaryIpStore(): WorkingPrimaryIpStore {
  return createInMemoryWorkingStore<PrimaryIP>();
}

/**
 * Injected dependencies. The tool OWNS no I/O of its own — it wires the
 * already-built pieces (provider, gate, store, observed-server reader, pg
 * pool for StateEvent append).
 *
 * IMPORTANT: `approvalGate` MUST be constructed with `isSensitive: () => true`
 * so that EVERY non-no-op synthetic PlanItem (`create`/`update`) is gated.
 * The default `defaultIsSensitive` only flags destroy/remove/restore; using
 * the default here would silently bypass approval for create/update — a cost
 * leak. Callers/tests are responsible; this is documented because there is
 * no compile-time way to enforce predicate identity on the seam.
 */
export interface SetPrimaryIpDeps {
  readonly pool: pg.Pool;
  readonly provider: PrimaryIPProvider;
  readonly approvalGate: ReconcileGate;
  readonly workingStore: WorkingPrimaryIpStore;
  /** FROZEN-for-this-call observed Server snapshot (§2.2 freeze invariant). */
  readonly serversProvider: () => Promise<readonly Server[]>;
}

// ---------------------------------------------------------------------------
// setPrimaryIp — the single dispatch
// ---------------------------------------------------------------------------

/**
 * Execute the `set_primary_ip` tool. NEVER throws — every failure (authz,
 * parse, plan, gate, store) is captured into a contract-shaped v2 error
 * envelope. Returns `WriteEnvelopeV2`.
 */
export async function setPrimaryIp(
  input: SetPrimaryIpInput,
  ctx: SetPrimaryIpCtx,
  deps: SetPrimaryIpDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE — out-of-scope/forged credential short-circuits
  // BEFORE any plan/parse/write (no StateEvent, no approval row).
  try {
    assertV2Capability(ctx.credential, "set_primary_ip");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse desired through the FROZEN schema.
  let desired: PrimaryIP;
  try {
    desired = PrimaryIPSchema.parse(asRecord(input.primary_ip));
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid primary_ip input: ${(err as Error).message}`,
        { entity: "primary_ip" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `primary_ip:${desired.name}`;
  const actor = actorOf(ctx.credential);

  // (3) Inline ≤1 server check — defence-in-depth (the F2.3 provider also
  //     enforces this at apply; failing at the tool boundary means the
  //     invariant violation never reaches the approval gate).
  //     TODO(bloco-c): hoist to PolicyEngine.
  if (desired.assignee_selector !== undefined) {
    let servers: readonly Server[];
    try {
      servers = await deps.serversProvider();
    } catch (err) {
      return toErrorEnvelope(err);
    }
    const matched = resolveServerSelector(desired.assignee_selector, servers);
    if (matched.length > 1) {
      return toErrorEnvelope(
        new ReconcileError(
          "precondition",
          `assignee_selector for ${entity} matched ${matched.length} servers; a PrimaryIP can be assigned to at most one server`,
          { entity },
        ),
      );
    }
  }

  // (4) Observe Hetzner + compute the diff via the provider's pure plan().
  //     F4.4 — gate observe() behind !dryRun: dry_run is pure introspection
  //     and must NEVER make a live HTTP call. plan(desired, null) returns
  //     the create-from-empty plan, which is the correct dry_run output.
  let observed: ObservedPrimaryIP | null = null;
  if (!dryRun) {
    try {
      observed = await deps.provider.observe(desired.name);
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }

  let planOps: readonly unknown[];
  try {
    const p = await deps.provider.plan(desired, observed);
    planOps = p.ops;
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (5) Dry-run → planned. Pure introspection.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...planOps] },
    });
  }

  // (6) Non-dry-run path. Two cases:
  //       (a) Idempotent no-op — observed exists AND plan is empty (or only
  //           `drift` items, which we deliberately do NOT correct, fail-safe).
  //           Nothing changes ⇒ surface `applied` with empty ops; NO approval,
  //           NO desired-state write, NO StateEvent.
  //       (b) ANY change (create / assignment update) ⇒ approval-always.
  const hasRealChange = planOps.some(
    (o) => (o as { op: string }).op !== "drift",
  );
  if (observed !== null && !hasRealChange) {
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [] },
    });
  }

  // (7) Approval-always for every non-no-op. Synthesise a single PlanItem
  //     whose `op` is semantically truthful (`create` on a fresh allocation,
  //     `update` otherwise). The injected gate MUST be configured with
  //     `isSensitive:() => true` (see deps doc); we route through the SAME
  //     `ReconcileGate.evaluate()` v1 uses so approval rows are uniform.
  const syntheticOp: "create" | "update" = observed === null ? "create" : "update";
  const item: PlanItem = {
    op: syntheticOp,
    entity,
    change:
      syntheticOp === "create"
        ? `allocate primary_ip ${desired.name} (${desired.type}, ${desired.location})`
        : `update assignment of ${entity}`,
    impact:
      "PrimaryIP is billed even when unassigned — approval required for every allocation and assignment change",
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
    });
  }

  // (8) Gate APPROVED the item (the caller's gate may be a pass-through OR
  //     a real gate where this exact approval was pre-approved). Write the
  //     working desired-state + emit a single StateEvent (capability_token_id
  //     null — Bloco C activates real population). This is also the path
  //     a "resolved-approval re-apply" cycle exercises (idempotency).
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
        type: desired.type,
        location: desired.location,
        assignee_selector: desired.assignee_selector ?? null,
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
    error: new ReconcileError("fatal", "set_primary_ip failed", {
      entity: "primary_ip",
    }).toApiError(),
  });
}
