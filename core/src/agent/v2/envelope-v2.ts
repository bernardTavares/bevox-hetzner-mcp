/**
 * core/src/agent/v2/envelope-v2.ts
 *
 * v2 WriteEnvelope builder for the agent interface (`POST /api/v2/*`).
 *
 * Same conformance discipline as v1's `../envelope.ts`:
 *   - Outputs PARSE against the FROZEN downstream schema
 *     (`console/src/api/contract-v2.ts` → `WriteEnvelopeV2Schema`); the
 *     contract is never edited to fit the builder. Types here are by-value
 *     mirrors (no runtime import of the console package).
 *   - Pure function only — no I/O.
 *   - Single entry point: callers always go through `buildV2WriteEnvelope`
 *     so the two neutral fields (`cost_estimate`, `policy_violations`) are
 *     guaranteed present on every `plan`-bearing envelope. Bloco A always
 *     emits the neutral defaults; Blocos C and D override them.
 */

import type { ApiError } from "../envelope.js";
import type { MigrationReport } from "../../domain/migrations-v2.js";

export interface CostBreakdownItem {
  [key: string]: unknown;
}

export interface CostEstimate {
  monthly_delta_eur: number;
  breakdown: CostBreakdownItem[];
}

export interface PolicyViolation {
  [key: string]: unknown;
}

export interface PlanV2 {
  ops: unknown[];
  cost_estimate: CostEstimate;
  policy_violations: PolicyViolation[];
}

/** Caller-side plan input — cost/policy are optional and defaulted to neutral. */
export interface PlanV2Input {
  ops: unknown[];
  cost_estimate?: CostEstimate;
  policy_violations?: PolicyViolation[];
}

export interface WriteEnvelopeV2 {
  status: "planned" | "pending_approval" | "applied" | "error";
  plan?: PlanV2;
  approval_id?: string;
  error?: ApiError;
  /**
   * Optional per-tool result payload. Currently used by `run_migrations`
   * to surface the per-file `MigrationReport`. Additive — the FROZEN
   * console `WriteEnvelopeV2Schema` is a non-`.strict()` z.object so an
   * extra field passes through cleanly; older tools simply omit it.
   */
  report?: MigrationReport;
}

export interface BuildV2EnvelopeOpts {
  status: WriteEnvelopeV2["status"];
  plan?: PlanV2Input;
  approval_id?: string;
  error?: ApiError;
  report?: MigrationReport;
}

/**
 * Build a v2 WriteEnvelope.
 *
 * When `plan` is supplied, the two neutral fields are filled if the caller
 * omitted them. This is the single place that guarantees the v2 wire
 * invariant ("every v2 plan carries cost_estimate + policy_violations")
 * regardless of which Bloco/tool composed the call. Neutral defaults are
 * fresh literals (mutable arrays/objects) so consumers can push into them
 * without aliasing surprises.
 */
export function buildV2WriteEnvelope(opts: BuildV2EnvelopeOpts): WriteEnvelopeV2 {
  const env: WriteEnvelopeV2 = { status: opts.status };
  if (opts.plan !== undefined) {
    env.plan = {
      ops: opts.plan.ops,
      cost_estimate: opts.plan.cost_estimate ?? { monthly_delta_eur: 0, breakdown: [] },
      policy_violations: opts.plan.policy_violations ?? [],
    };
  }
  if (opts.approval_id !== undefined) env.approval_id = opts.approval_id;
  if (opts.error !== undefined) env.error = opts.error;
  if (opts.report !== undefined) env.report = opts.report;
  return env;
}
