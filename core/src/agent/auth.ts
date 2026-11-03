/**
 * core/src/agent/auth.ts
 *
 * The auth boundary (trust seam) of the agent interface.
 *
 * SECURITY-CRITICAL. Two responsibilities, both at the interface layer ONLY
 * (never the reconciler — regression-guarded in auth.test.ts):
 *
 *   1. authenticate(): resolve an opaque INCOMING token into a verified
 *      capability set. This is the ONLY place a VerifiedCredential is minted
 *      (via capability.ts mintVerifiedCredential). A caller downstream of this
 *      boundary cannot fabricate a credential — the brand is module-private to
 *      capability.ts (mirrors the store/secrets.ts ApplyContext spirit).
 *
 *   2. authorize() / authorizeAndRecord(): enforce per-capability scope and
 *      OWN the audit contract once. authorizeAndRecord STRUCTURALLY guarantees
 *      deny-before-write: assertCapability runs FIRST; a DENIED call reaches NO
 *      write/plan/reconcile/store mutation and produces NO event. An AUTHORIZED
 *      call is audited on BOTH outcomes — exactly one StateEvent (result:"ok"
 *      on success, result:"error" on failure, then the original error is
 *      re-thrown) carrying actor + effective scope from the verified
 *      credential. An authorized-but-failed action can never vanish from the
 *      append-only trail; 4.4 MUST NOT reinvent per-tool failure auditing.
 *
 * Failure model: an unknown token / out-of-scope call is a ReconcileError
 * ("fatal") — the authz/non-recoverable class (errors.ts 401/403). It surfaces
 * through the Task 4.1 error() envelope as status:"error" with a fatal,
 * non-retryable ApiError. Messages never enumerate granted capabilities or
 * leak secrets (capability.ts owns the message wording).
 *
 * v1 trust backend: an INJECTED token → {actor,capabilities} map
 * (createInjectedCredentialStore). Real identity (JWT / mTLS / a credential
 * service) is EXPLICITLY DEFERRED / out of scope (spec §"Não-objetivos":
 * rotação de secrets v1; YAGNI). The CredentialStore interface is the seam
 * where a real backend slots in later without touching the enforcement code.
 *
 * Exported API (minimal surface — nothing else):
 *   CredentialStore                    — the resolution seam (interface)
 *   createInjectedCredentialStore(map) — v1 in-memory store factory
 *   authenticate(store, token)         — token → VerifiedCredential (or fatal)
 *   authorize(cred, tool)              — assert + return effective scope
 *   authorizeAndRecord(pool, cred, tool, ev, action)
 *                                      — deny-before-write + record-on-allow
 *   actorOf(cred)                      — read the actor (no brand exposure)
 */

import type pg from "pg";

import { ReconcileError } from "../domain/errors.js";
import { appendEvent } from "../store/state-events.js";
import {
  actorOf,
  assertCapability,
  effectiveScope,
  mintVerifiedCredential,
  type ToolName,
  type VerifiedCredential,
} from "./capability.js";

// actorOf is the brand-guarded audit-identity accessor. It is owned by
// capability.ts (where the credential brand is module-private) and re-exported
// here so the auth boundary's public surface is unchanged and the brand/guard
// is NOT duplicated. Fails closed on a forged credential (see capability.ts).
export { actorOf };

// ---------------------------------------------------------------------------
// CredentialStore — the resolution seam
//
// resolve() returns the actor + raw granted capability names for a token, or
// undefined if the token is unknown. It returns ONLY plain data — it never
// mints a VerifiedCredential itself; authenticate() is the sole minter, so the
// unforgeable invariant has exactly one enforcement point.
// ---------------------------------------------------------------------------

export interface CredentialRecord {
  readonly actor: string;
  readonly capabilities: readonly string[];
}

export interface CredentialStore {
  /** Resolve an opaque token to its credential record, or undefined. */
  resolve(token: string): CredentialRecord | undefined;
}

/**
 * v1 in-memory store: an injected token → record map. INERT and deterministic;
 * no I/O. The map is defensively copied so a later caller mutating the input
 * object cannot retroactively grant capabilities. Real identity backends
 * (JWT/mTLS) implement CredentialStore later — out of scope here.
 */
export function createInjectedCredentialStore(map: {
  readonly [token: string]: CredentialRecord;
}): CredentialStore {
  // Freeze a shallow copy of each record (incl. its capability list) so the
  // store cannot be tampered with after construction.
  const frozen = new Map<string, CredentialRecord>();
  for (const [tok, rec] of Object.entries(map)) {
    frozen.set(
      tok,
      Object.freeze({
        actor: rec.actor,
        capabilities: Object.freeze([...rec.capabilities]),
      }),
    );
  }
  return {
    resolve(token: string): CredentialRecord | undefined {
      return frozen.get(token);
    },
  };
}

// ---------------------------------------------------------------------------
// authenticate — the ONLY mint point
// ---------------------------------------------------------------------------

/**
 * Verify an incoming token and mint its VerifiedCredential. An empty or
 * unknown token is an authz failure: ReconcileError("fatal") — the same class
 * errors.ts assigns to 401/403, surfaced via the error() envelope. The message
 * does NOT reveal which tokens exist.
 *
 * @throws ReconcileError("fatal") if the token is empty or unrecognised.
 */
export function authenticate(
  store: CredentialStore,
  token: string,
): VerifiedCredential {
  if (!token || token.trim() === "") {
    throw new ReconcileError(
      "fatal",
      "authorization denied: a credential token is required",
      { entity: "agent" },
    );
  }
  const rec = store.resolve(token);
  if (rec === undefined) {
    throw new ReconcileError(
      "fatal",
      "authorization denied: unrecognised credential",
      { entity: "agent" },
    );
  }
  return mintVerifiedCredential(rec.actor, rec.capabilities);
}

// ---------------------------------------------------------------------------
// authorize — assert scope, return the scope string to record
// ---------------------------------------------------------------------------

/**
 * Enforce that `cred` may call `tool`, then return the effective capability
 * scope string the caller MUST record in the StateEvent for the allowed call.
 *
 * @throws ReconcileError("fatal") (deny-before-write) if out of scope.
 */
export function authorize(
  cred: VerifiedCredential,
  tool: ToolName,
): string {
  assertCapability(cred, tool); // throws fatal BEFORE returning a scope
  return effectiveScope(cred);
}

// ---------------------------------------------------------------------------
// authorizeAndRecord — structural deny-before-write + record-on-allow
// ---------------------------------------------------------------------------

/**
 * The single wiring point for the authz spine. It OWNS the audit contract once
 * so downstream (4.4 routes all 12 tools through here) does NOT reinvent
 * per-tool failure auditing:
 *
 *   1. DENY-BEFORE-WRITE: authorize() (assertCapability) runs FIRST. If the
 *      credential is forged or the tool is out of scope it throws
 *      ReconcileError("fatal") and NOTHING below executes — no action, no
 *      StateEvent, no store mutation. A DENIED call writes NO event at all.
 *   2. Only on an AUTHORIZED call is `action()` invoked (the actual
 *      desired-state write / reconcile, supplied by the call site / 4.4).
 *   3. AUTHORIZED calls are audited on BOTH outcomes — exactly one StateEvent
 *      is appended either way, carrying the acting agent (actor) AND the
 *      effective capability scope (4.2), both derived from the verified
 *      credential (never caller-supplied):
 *        - action() succeeds → event with result:"ok"  (event.result honoured)
 *        - action() throws   → event with result:"error", then the ORIGINAL
 *          error is re-thrown (not swallowed). The audited message is
 *          value-free (a ReconcileError's safe message, else a generic
 *          string) — the thrown error's cause / sensitive values are NEVER
 *          written to the trail (mirrors the 1.9/3.3/4.1 no-leak discipline).
 *
 * Net: an authorized-but-failed destroy can NEVER vanish from the append-only
 * trail; only DENIED (unauthorized) calls produce no record.
 *
 * `event` is the StateEvent shape minus actor/scope (both derived here from
 * the verified credential so a caller cannot record a different actor/scope
 * than the one it was authorized under). The StateEvent.scope field is the
 * existing core-internal optional column (entities.ts) — no schema change.
 *
 * @throws ReconcileError("fatal") if out of scope (before any side effect),
 *         OR the original error from `action()` (after auditing result:"error").
 */
export async function authorizeAndRecord(
  pool: pg.Pool,
  cred: VerifiedCredential,
  tool: ToolName,
  event: {
    op: string;
    entity: string;
    result: string;
    before?: unknown;
    after?: unknown;
    ts?: string;
  },
  action: () => Promise<void>,
): Promise<{ seq: number }> {
  // (1) DENY-BEFORE-WRITE: this throws fatal and short-circuits everything
  // below if the credential is forged or the tool is out of scope. A denied
  // call therefore produces NO StateEvent.
  const scope = authorize(cred, tool);
  // Derive the audit identity from the verified credential (brand-guarded,
  // never caller-supplied) BEFORE running the action so it is fixed even if
  // the action throws.
  const actor = actorOf(cred);

  // (2) authorized — perform the actual write/side effect, auditing BOTH
  // outcomes so an authorized-but-failed action cannot vanish from the trail.
  try {
    await action();
  } catch (err) {
    // Audit the authorized-but-failed attempt with a value-free message —
    // never the thrown error's cause/values (no secret/sensitive leak).
    await appendEvent(pool, {
      actor,
      scope,
      op: event.op,
      entity: event.entity,
      result: "error",
      before: event.before,
      after:
        err instanceof ReconcileError
          ? { error: err.toApiError() }
          : { error: "action failed" },
      ts: event.ts,
    });
    // Re-throw the ORIGINAL error — do not swallow, do not wrap.
    throw err;
  }

  // (3) record the allowed, succeeded call with actor + effective scope.
  return appendEvent(pool, {
    actor,
    scope,
    op: event.op,
    entity: event.entity,
    result: event.result,
    before: event.before,
    after: event.after,
    ts: event.ts,
  });
}

