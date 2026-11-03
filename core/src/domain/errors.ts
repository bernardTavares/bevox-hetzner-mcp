/**
 * core/src/domain/errors.ts
 *
 * Error taxonomy for the bevox-hetzner-mcp reconciler.
 *
 * Five classes model every failure the reconcile cycle can produce:
 *   transient    — temporary; safe to retry (rate-limit, 5xx, network blip)
 *   precondition — a dependency is missing; retry only after the dep is resolved
 *   conflict     — observed state diverges from desired (drift); needs operator review
 *   fatal        — permanent mis-configuration or auth failure; stop the cycle
 *   partial      — some sub-operations succeeded, some failed; retry the failed subset
 *
 * Default for unknown inputs: "fatal"
 * Rationale: an unrecognised error must NOT silently retry forever (which could
 * cause runaway API calls or cascade failures).  Defaulting to "fatal" halts
 * the reconcile cycle immediately and surfaces the issue for agent/operator
 * review.  The cycle can be re-triggered once the root cause is understood.
 *
 * HTTP client contract (Task 2.2):
 *   The HTTP client SHOULD pass `kind:"network-error"` (or one of the recognised
 *   network `code` values below) for pre-HTTP failures (connection reset, timeout,
 *   DNS failure, etc.) so the reconciler retries instead of aborting. Without
 *   this, an unexpected code will fall through to the "fatal" default.
 *
 * NOTE: This module MUST NOT import from the console package. The toApiError()
 * shape is produced here by value, not by importing the console contract.
 */

// ---------------------------------------------------------------------------
// ErrorClass — the five spec classes
// ---------------------------------------------------------------------------

export type ErrorClass =
  | "transient"
  | "precondition"
  | "conflict"
  | "fatal"
  | "partial";

// ---------------------------------------------------------------------------
// Network error codes recognised as transient
// (Node.js system error codes + fetch/AbortController codes)
// ---------------------------------------------------------------------------

const TRANSIENT_NETWORK_CODES = new Set([
  "econnreset",
  "etimedout",
  "econnrefused",
  "eai_again",
  "epipe",
  "abort_err",
  "aborterr",
  "timeout",
]);

// ---------------------------------------------------------------------------
// classify — maps raw error signals to an ErrorClass
// ---------------------------------------------------------------------------

/**
 * Classify a raw error signal into one of the five spec error classes.
 *
 * Precedence (first match wins):
 *  1. kind-based overrides (most specific intent signals)
 *  2. Network error code (Node system codes / fetch abort codes)
 *  3. HTTP-status-based rules
 *  4. Default: "fatal" (safe stop — see module rationale above)
 */
export function classify(input: {
  httpStatus?: number;
  code?: string;
  kind?: string;
}): ErrorClass {
  const { httpStatus, code, kind } = input;

  // --- kind-based classification (explicit intent signals) ---
  if (kind === "missing-dependency") return "precondition";
  if (kind === "drift" || kind === "conflict") return "conflict";
  if (kind === "partial") return "partial";
  // HTTP client SHOULD use this kind for pre-HTTP failures (no response received)
  if (kind === "network-error") return "transient";

  // --- network code classification (case-insensitive) ---
  // Covers Node.js system error codes (ECONNRESET, ETIMEDOUT, …) and
  // fetch/AbortController codes (abort_err, timeout) passed by the HTTP client.
  if (code !== undefined && TRANSIENT_NETWORK_CODES.has(code.toLowerCase())) {
    return "transient";
  }

  // --- HTTP-status-based classification ---
  if (httpStatus !== undefined) {
    // 408 Request Timeout / 425 Too Early — retryable by definition
    if (httpStatus === 408 || httpStatus === 425) return "transient";
    // 429 Too Many Requests — rate limited, safe to back off and retry
    if (httpStatus === 429) return "transient";
    // 5xx Server Errors — transient upstream failures
    if (httpStatus >= 500 && httpStatus < 600) return "transient";
    // 401 Unauthorized / 403 Forbidden — auth/permission failure, fatal
    // NOTE: Hetzner 403 encodes BOTH auth failure AND quota-exceeded.
    // Current rule = 403 fatal (per spec: quota=fatal).
    // Task 2.4 must decide whether the HTTP client emits kind:"quota-exceeded"
    // (→ revisit if quota-403 should be transient). No behaviour change here.
    if (httpStatus === 401 || httpStatus === 403) return "fatal";
  }

  // --- Default: fatal (see module rationale) ---
  return "fatal";
}

// ---------------------------------------------------------------------------
// ApiError shape — matches console/src/api/contract.ts ApiError field-for-field
// (produced by value; no import from the console package)
// ---------------------------------------------------------------------------

interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  entity: string;
}

// ---------------------------------------------------------------------------
// ReconcileError — typed Error subclass carrying the full error envelope
// ---------------------------------------------------------------------------

export interface ReconcileErrorOptions {
  entity?: string;
  retryAfterMs?: number;
  /** Original cause (ES2022 error chaining). NOT forwarded to toApiError(). */
  cause?: unknown;
}

export class ReconcileError extends Error {
  /** The spec error class for this failure. */
  readonly errorClass: ErrorClass;
  /** The affected entity identifier (e.g. "server:app-1"). Empty string if absent. */
  readonly entity: string;
  /** Suggested retry delay in milliseconds (meaningful only for transient). */
  readonly retryAfterMs?: number;

  constructor(
    errorClass: ErrorClass,
    message: string,
    options?: ReconcileErrorOptions,
  ) {
    super(message, { cause: options?.cause });
    this.name = "ReconcileError";
    this.errorClass = errorClass;
    this.entity = options?.entity ?? "";
    this.retryAfterMs = options?.retryAfterMs;
  }

  /**
   * Whether the reconciler may safely retry this operation.
   * transient and partial are retryable; all others are not.
   */
  get retryable(): boolean {
    return this.errorClass === "transient" || this.errorClass === "partial";
  }

  /**
   * Produce the ApiError envelope shape consumed by the agent interface.
   * Structurally matches console/src/api/contract.ts ApiError — no import needed.
   * `cause` is intentionally NOT included: internal stack detail must not leak
   * into the public API contract.
   */
  toApiError(): ApiError {
    return {
      code: this.errorClass,
      message: this.message,
      retryable: this.retryable,
      entity: this.entity,
    };
  }
}
