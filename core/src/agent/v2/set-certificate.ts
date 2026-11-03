/**
 * core/src/agent/v2/set-certificate.ts
 *
 * Task F3.5 — `set_certificate` (v2 write tool).
 *
 * Surface: a single `setCertificate(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/certificates` route and the MCP `set_certificate` tool
 * call — single source of truth across transports (same envelope, same
 * StateEvent, same approval classification). Mirrors F1.4 (`setFirewall`)
 * and F2.4 (`setPrimaryIp`) for every cross-cutting concern (deny-before-
 * write, working-store seam, gate routing, neutral v2 envelope).
 *
 * Approval branching (spec-mãe §3 Bloco A; spec-filha §3.3 — Certificates):
 *
 *   - `desired.type === "managed"`. Hetzner-owned ACME issuance. The
 *     certificate body & private key are NEVER user-supplied (no secret
 *     touched); managed certs are FREE (no cost gate); creation is NOT
 *     destructive (it's a brand-new resource, fail-safe). ⇒ NO Approval.
 *     The tool writes the desired-state into the working store immediately
 *     and emits the StateEvent; the provider's `apply()` then drives the
 *     non-blocking polling cycle owned by the reconciler (its `pending`
 *     `action_status` is informational, not blocking the envelope).
 *
 *   - `desired.type === "uploaded"`. Operator-supplied PEM + private key
 *     reference (a `secret:<name>` ref). Touches a SECRET resource and the
 *     uploaded PEM is admin-provided sensitive material. ⇒ Approval gated
 *     on every non-no-op (same `ReconcileGate.evaluate()` pattern as F2.4).
 *
 *   - IDEMPOTENT NO-OP (no diff). Regardless of type: `applied` with empty
 *     ops, NO approval, NO working-store write, NO StateEvent.
 *
 *   - DRIFT-ONLY plan (only `drift` ops, no real change). Same as the no-op
 *     case: `applied` empty-ops downstream-visible plan (drift is a
 *     read-only signal — fail-safe, never silently corrected).
 *
 *   - PROVIDER-LEVEL PRECONDITION (e.g. uploaded immutability conflict,
 *     managed `requires_dns_challenge`). Surfaces as a `precondition` plan
 *     op (uploaded mutation attempt) or as a thrown `ReconcileError` from
 *     `apply()` (managed DNS-challenge). Either way ⇒ error envelope.
 *
 * SECRET RESOLUTION: the tool itself NEVER calls `secretResolver`. The
 * provider's `apply()` resolves the secret EXACTLY ONCE per converging call
 * — only on the uploaded branch and only after this tool has gated approval.
 *
 * WORKING-STORE ORDER (rule of three — this is the 3rd `WorkingXStore`
 * shape after firewall+primary_ip; the F1.4 hoist-when-3 TODO triggers
 * AFTER F4.4 [LoadBalancer]; we duplicate the pattern locally here so the
 * diff stays minimal):
 *   - managed: working-store put runs IMMEDIATELY (no approval). Provider
 *     `apply()` is then called for the initial POST; its action_status is
 *     surfaced as informational only — the envelope is `applied` because
 *     the working desired-state was written successfully.
 *   - uploaded: working-store put runs AFTER approval has been granted
 *     (same as F2.4) — fail-safe (a pending approval ⇒ NO desired-state
 *     change).
 *
 * Open concern carried over from F1.4/F2.4 review: the working-store-put
 * then StateEvent-append pair is NOT atomic. Bloco A keeps the working
 * store in-memory (no durable surface to drift), so practical exposure is
 * nil; Bloco C lands a durable backing store with an atomic write seam.
 *
 * StateEvent on `applied` carries `capability_token_id: null` (same as
 * F1.4/F2.4; Bloco C activates real population).
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
  CertificateSchema,
  type Certificate,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type {
  CertificateProvider,
  ObservedCertificate,
} from "../../providers/v2/hetzner-certificate.js";
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

export interface SetCertificateInput {
  readonly dry_run?: boolean;
  /** Desired Certificate — parsed via the FROZEN `CertificateSchema`. */
  readonly certificate: unknown;
}

export interface SetCertificateCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope (defaulted to "certificate" by callers). */
  readonly scope: string;
}

/**
 * The minimal v2 working-store seam for Certificates. Hoisted in F4.4 to the
 * generic `WorkingStore<T>` (see ./working-store.ts); kept as a type-alias
 * here so every existing caller is byte-for-byte unchanged.
 */
export type WorkingCertificateStore = WorkingStore<Certificate>;

/** Trivial in-memory implementation — the default Bloco-A backing store. */
export function createInMemoryWorkingCertificateStore(): WorkingCertificateStore {
  return createInMemoryWorkingStore<Certificate>();
}

/**
 * Injected dependencies. The tool OWNS no I/O — it wires the already-built
 * pieces (provider with its own secretResolver dep, gate, store, pg pool).
 *
 * IMPORTANT: `approvalGate` MUST be constructed with `isSensitive: () => true`
 * when the caller wishes uploaded certificates to gate on `create`/`update`
 * (which are NOT in `defaultSensitiveOps`). Otherwise the uploaded branch
 * would silently bypass approval — a secret-touch leak. This mirrors the
 * F2.4 contract; tests assert end-to-end.
 */
export interface SetCertificateDeps {
  readonly pool: pg.Pool;
  readonly provider: CertificateProvider;
  readonly approvalGate: ReconcileGate;
  readonly workingStore: WorkingCertificateStore;
}

// ---------------------------------------------------------------------------
// setCertificate — the single dispatch
// ---------------------------------------------------------------------------

export async function setCertificate(
  input: SetCertificateInput,
  ctx: SetCertificateCtx,
  deps: SetCertificateDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE.
  try {
    assertV2Capability(ctx.credential, "set_certificate");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse desired through the FROZEN schema.
  let desired: Certificate;
  try {
    desired = CertificateSchema.parse(asRecord(input.certificate));
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid certificate input: ${(err as Error).message}`,
        { entity: "certificate" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `certificate:${desired.name}`;
  const actor = actorOf(ctx.credential);

  // (3) Observe Hetzner + compute the diff via the provider's pure plan().
  //     F4.3 — gate observe() behind !dryRun: dry_run is pure introspection
  //     and must NEVER make a live HTTP call. plan(desired, null) returns
  //     the create-from-empty plan, which is the correct dry_run output.
  let observed: ObservedCertificate | null = null;
  if (!dryRun) {
    try {
      observed = await deps.provider.observe(desired.name);
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }

  let planOps: readonly { op: string; entity: string; reason?: string }[];
  try {
    const p = await deps.provider.plan(desired, observed);
    planOps = p.ops as readonly {
      op: string;
      entity: string;
      reason?: string;
    }[];
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (4) Dry-run → planned.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...planOps] },
    });
  }

  // (5) Surface precondition plan ops as error envelopes (uploaded
  //     immutability, managed-domains-change, etc.). The provider's `plan`
  //     emits at most one precondition; treat its presence as a hard stop.
  const precondition = planOps.find((o) => o.op === "precondition");
  if (precondition) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        precondition.reason ?? `${entity} precondition not satisfied`,
        { entity },
      ),
    );
  }

  // (6) No real change ⇒ idempotent no-op (drift is fail-safe read-only).
  const hasRealChange = planOps.some((o) => o.op !== "drift");
  if (!hasRealChange) {
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [] },
    });
  }

  // (7) BRANCH ON TYPE.
  const isUploaded = desired.type === "uploaded";
  const syntheticOp: "create" | "update" = observed === null ? "create" : "update";

  // ---- UPLOADED: Approval-always (touches a secret) ---------------------
  if (isUploaded) {
    const item: PlanItem = {
      op: syntheticOp,
      entity,
      change:
        syntheticOp === "create"
          ? `upload certificate ${desired.name} for [${desired.domains.join(", ")}]`
          : `update uploaded certificate ${entity}`,
      impact:
        "uploaded certificate carries operator-supplied private key (secret) — approval required",
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
    // Approved (or pass-through gate): write working desired-state + emit
    // the StateEvent. The provider's apply() is invoked by the reconciler
    // on its next cycle (which resolves the secret at apply time).
    return await commit(deps, ctx, desired, entity, syntheticOp, actor);
  }

  // ---- MANAGED: no Approval (Hetzner-owned ACME; not destructive) -------
  // Write working desired-state FIRST so the manifest projection reflects
  // intent immediately; then call provider.apply() so the first POST kicks
  // off the issuance polling cycle. The provider's `action_status` (pending
  // / completed / error / cancelled) is INFORMATIONAL — the envelope is
  // `applied` because the working desired-state was written.
  try {
    await deps.provider.apply(desired, observed);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  return await commit(deps, ctx, desired, entity, syntheticOp, actor);
}

// ---------------------------------------------------------------------------
// Internal: commit working-store + StateEvent (the "applied" tail)
// ---------------------------------------------------------------------------

async function commit(
  deps: SetCertificateDeps,
  ctx: SetCertificateCtx,
  desired: Certificate,
  entity: string,
  op: "create" | "update",
  actor: string,
): Promise<WriteEnvelopeV2> {
  try {
    await deps.workingStore.put(desired.name, desired);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  try {
    await appendEvent(deps.pool, {
      actor,
      scope: ctx.scope,
      op,
      entity,
      result: "applied",
      after: {
        type: desired.type,
        domains: [...desired.domains],
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
    error: new ReconcileError("fatal", "set_certificate failed", {
      entity: "certificate",
    }).toApiError(),
  });
}
