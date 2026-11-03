/**
 * core/src/agent/envelope.ts
 *
 * WriteEnvelope builders for the agent interface (MCP + REST).
 *
 * Design principles:
 *   - Contract-frozen-conformant: every builder output is shaped to PARSE
 *     against console/src/api/contract.ts WriteEnvelopeSchema (the FROZEN
 *     downstream truth). The contract is never modified to fit a builder; the
 *     builder conforms. Types are mirrored by-value here (the established
 *     entities.ts / errors.ts precedent — no runtime import of the console
 *     package); the oracle test enforces the core-valid ⇒ console-valid
 *     invariant against the live console schema.
 *   - One status literal per builder, matching the contract's
 *     WriteEnvelopeStatusEnum exactly: planned | pending_approval | applied |
 *     error.
 *   - No secret leakage: error() forwards ReconcileError.toApiError(), which
 *     deliberately omits cause/stack (errors.ts §toApiError). A raw ApiError is
 *     passed through unchanged; callers are responsible for it being safe.
 *   - `next` is an OPTIONAL agent-hint passthrough: attached to the returned
 *     value when provided, but NOT part of the validated contract surface
 *     (WriteEnvelopeSchema is a non-strict z.object and strips it on parse).
 *   - Pure functions only — no I/O, DB, or network. DRY/YAGNI: exactly the
 *     four builders + the return type alias. No REST/MCP/tool/approval logic
 *     (later Fase 4 tasks).
 *
 * Exported API (ONLY these — minimal surface):
 *   planned(plan, next?)              → WriteEnvelope   status:"planned"
 *   pendingApproval(approvalId, next?)→ WriteEnvelope   status:"pending_approval"
 *   applied(next?)                    → WriteEnvelope   status:"applied"
 *   error(err, next?)                 → WriteEnvelope   status:"error"
 */

import type { PlanItem } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";

/**
 * ApiError — mirrors console/src/api/contract.ts ErrorSchema field-for-field
 * (by value; no console import). Identical in shape to the structural type
 * produced by ReconcileError.toApiError().
 */
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  entity: string;
}

/**
 * WriteEnvelope — by-value mirror of the FROZEN console
 * WriteEnvelopeSchema. `next` is a core-only optional agent hint, structurally
 * compatible with the lenient downstream schema (stripped on parse).
 */
export interface WriteEnvelope {
  status: "planned" | "pending_approval" | "applied" | "error";
  plan?: PlanItem[];
  approval_id?: string;
  error?: ApiError;
  /** Optional agent-facing hint; NOT validated by the frozen contract. */
  next?: unknown;
}

function withNext<T extends WriteEnvelope>(env: T, next?: unknown): T {
  return next === undefined ? env : { ...env, next };
}

/** status:"planned" — carries the computed plan (one or more PlanItems). */
export function planned(plan: PlanItem[], next?: unknown): WriteEnvelope {
  return withNext({ status: "planned", plan }, next);
}

/** status:"pending_approval" — carries the contract approval_id (apr_…). */
export function pendingApproval(approvalId: string, next?: unknown): WriteEnvelope {
  return withNext({ status: "pending_approval", approval_id: approvalId }, next);
}

/** status:"applied" — terminal success; no plan/error payload. */
export function applied(next?: unknown): WriteEnvelope {
  return withNext({ status: "applied" }, next);
}

/**
 * status:"error" — carries a contract-shaped ApiError. A ReconcileError is
 * converted via toApiError() (cause/stack intentionally dropped — no secret
 * leakage); an already-built ApiError is forwarded unchanged.
 */
export function error(err: ReconcileError | ApiError, next?: unknown): WriteEnvelope {
  const apiError: ApiError =
    err instanceof ReconcileError ? err.toApiError() : err;
  return withNext({ status: "error", error: apiError }, next);
}
