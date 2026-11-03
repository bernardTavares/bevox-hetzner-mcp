/**
 * core/src/providers/v2/error-rewrap.ts
 *
 * Shared error re-wrap helper for v2 Hetzner Cloud providers.
 *
 * Background: the v2 HTTP adapter goes through the v1 `HttpClient`, which
 * classifies non-2xx via `domain/errors.ts`. The default mapping treats
 * unmodelled 4xx (notably 422) as `fatal`. But for v2 providers, a 422 from
 * Hetzner represents a CALLER-correctable input violation (malformed rules,
 * invalid PEM, mutation of an immutable field, etc.) and is more accurately
 * surfaced as `precondition`. This helper is the single point of that re-wrap.
 *
 * Hoisted in F3.3 per F1.4 code review M1 ("duplicate locally until a third
 * provider needs the same shape, then hoist") — F1.3 (firewall), F2.3
 * (primary-ip) and F3.3 (certificate) all need the same shape. Centralising it
 * here removes 3-way drift risk.
 *
 * Non-goals: this module does NOT widen the http-client API surface; it
 * detects the 422 case from the canonical message prefix
 * (`HTTP <method> → <status> ...`) the http-client formats, identical to the
 * inlined predicates it replaces.
 */

import { ReconcileError } from "../../domain/errors.js";

/**
 * Re-wrap a thrown error from a v2 Hetzner Cloud call: a 422 "fatal" becomes
 * "precondition" so the caller knows the input — not the system — is at fault.
 * Other classes / non-`ReconcileError` throwables pass through unchanged.
 */
export function rewrapHetznerError(err: unknown): unknown {
  if (!(err instanceof ReconcileError)) return err;
  if (err.errorClass === "fatal" && /→ 422\b/.test(err.message)) {
    return new ReconcileError("precondition", err.message, {
      entity: err.entity,
      cause: err,
    });
  }
  return err;
}
