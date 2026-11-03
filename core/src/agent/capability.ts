/**
 * core/src/agent/capability.ts
 *
 * Pure per-capability authorization model for the agent interface.
 *
 * SECURITY-CRITICAL — this is the capability/authz boundary. Enforcement lives
 * HERE (the agent interface), NEVER in the reconciler/plan/apply/providers
 * (spec §"Approval Gate"; regression guard in auth.test.ts asserts reconcile.ts
 * has zero capability dependency).
 *
 * Design principles:
 *   - A credential = an actor identity + a capability set over the FROZEN
 *     12-tool vocabulary (spec §"vocabulário de 12 tools"). Superset/subset
 *     semantics: Vox ⊇ {destroy,…}; a runner ⊂ {deploy_service,…}.
 *   - assertCapability throws ReconcileError("fatal") for an out-of-scope
 *     call. "fatal" is exactly the authz/non-recoverable class errors.ts
 *     assigns to HTTP 401/403 — an authz denial is permanent, never retried,
 *     and surfaces through the Task 4.1 error() envelope as status:"error"
 *     with a fatal ApiError.
 *   - UNFORGEABLE in spirit (mirrors store/secrets.ts ApplyContext): a
 *     VerifiedCredential carries a module-private `unique symbol` brand that
 *     is NEVER exported. A plain object claiming `capabilities:["destroy"]`
 *     fabricated by a downstream caller is NOT a VerifiedCredential — the
 *     brand check fails and assertCapability denies it as fatal. A genuine
 *     credential can ONLY be minted past the auth boundary (auth.ts), or via
 *     the clearly-named test-only mint below.
 *   - No secret / escalation leakage: a denial message names the denied tool
 *     (pragmatic, aids the caller) but NEVER enumerates the credential's
 *     granted set nor any other agent's capabilities.
 *   - Pure module: no I/O, DB, or network. DRY/YAGNI: the model + hasCapability
 *     + assertCapability + effectiveScope only. Auth resolution (the trust
 *     seam) lives in auth.ts; StateEvent wiring lives at the call site that
 *     records the event. No tool catalog / REST / MCP here (4.4/4.5/4.7).
 *
 * Exported API (minimal surface — nothing else):
 *   ToolName                       — the 12-tool union
 *   ALL_TOOLS                      — readonly tuple of all 12 (full grant)
 *   VerifiedCredential             — opaque, unforgeable verified credential
 *   hasCapability(cred, tool)      — pure predicate
 *   assertCapability(cred, tool)   — throws ReconcileError("fatal") if denied
 *   effectiveScope(cred)           — deterministic scope string for StateEvent
 *   actorOf(cred)                  — brand-guarded audit-identity accessor
 *   mintVerifiedCredential         — INTERNAL mint (auth.ts boundary only)
 *   __mintVerifiedCredentialForTest— test-only mint (clearly named)
 */

import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// ToolName — the FROZEN 12-tool vocabulary (spec). Capabilities are expressed
// over exactly these tool/op names. The tool *catalog* (handlers) is Task 4.4;
// this is only the authorization vocabulary.
// ---------------------------------------------------------------------------

export const ALL_TOOLS = [
  "get_state",
  "diff",
  "events",
  "health",
  "provision_server",
  "deploy_service",
  "scale_service",
  "set_dns",
  "snapshot",
  "restore",
  "destroy",
  "apply_manifest",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

const TOOL_SET: ReadonlySet<string> = new Set(ALL_TOOLS);

// ---------------------------------------------------------------------------
// V2_TOOLS — additive v2 tool vocabulary (spec-mãe + spec-filha Bloco A). NOT
// part of the FROZEN 12 (`ALL_TOOLS` and `TOOL_POLICY` stay byte-for-byte
// intact; the 4.6 contract-conformance oracle and the 12-tool MCP listing
// assertion are untouched). v2 tools are opt-in surfaces wired separately by
// REST (`POST /api/v2/*`) and MCP (per-tool `enable*` flags).
// ---------------------------------------------------------------------------

export const V2_TOOLS = [
  "resolve_selector",
  "set_firewall",
  "set_primary_ip",
  "set_certificate",
  "set_load_balancer",
  "set_ingress",
  "expose_service",
  "run_migrations",
  "kubectl_apply",
  "ensure_k3s",
] as const;

export type V2ToolName = (typeof V2_TOOLS)[number];

const V2_TOOL_SET: ReadonlySet<string> = new Set(V2_TOOLS);

// ---------------------------------------------------------------------------
// VerifiedCredential — opaque, unforgeable (mirrors secrets.ts ApplyContext)
//
// The brand is a module-private unique symbol, NEVER exported. No external
// caller can construct an object carrying it; only mintVerifiedCredential
// (consumed by the auth boundary) or the test-only mint produce one. A forged
// plain object lacks the brand → isVerifiedCredential() is false → denied.
// `Object.freeze` (incl. the capability set) prevents post-issue tampering.
// ---------------------------------------------------------------------------

const CRED_BRAND: unique symbol = Symbol("bevox.agent.verifiedCredential");

export interface VerifiedCredential {
  readonly [CRED_BRAND]: true;
  /** The acting agent identity (recorded as StateEvent.actor). */
  readonly actor: string;
  /** The granted v1 tool set (FROZEN 12). Frozen; never mutated after mint. */
  readonly capabilities: ReadonlySet<ToolName>;
  /**
   * The granted v2 tool set (additive — `V2_TOOLS` vocabulary, NOT part of the
   * FROZEN 12). Kept on a separate field so the FROZEN `capabilities` set
   * surface (and every test pinning its membership) is unchanged. Always
   * present (possibly empty); frozen after mint.
   */
  readonly v2Capabilities: ReadonlySet<V2ToolName>;
}

function isVerifiedCredential(v: unknown): v is VerifiedCredential {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[CRED_BRAND] === true
  );
}

/**
 * Mint a VerifiedCredential. INTERNAL trust seam — call ONLY from the auth
 * boundary (auth.ts) after a credential has been verified. Granted tools are
 * filtered to the known vocabulary so an unknown/typo capability can never be
 * smuggled into the set.
 */
export function mintVerifiedCredential(
  actor: string,
  granted: readonly string[],
): VerifiedCredential {
  const caps = new Set<ToolName>();
  const v2 = new Set<V2ToolName>();
  for (const g of granted) {
    if (TOOL_SET.has(g)) caps.add(g as ToolName);
    else if (V2_TOOL_SET.has(g)) v2.add(g as V2ToolName);
  }
  return Object.freeze({
    [CRED_BRAND]: true as const,
    actor,
    capabilities: Object.freeze(caps) as ReadonlySet<ToolName>,
    v2Capabilities: Object.freeze(v2) as ReadonlySet<V2ToolName>,
  });
}

/**
 * Test-only mint. Deliberately and explicitly named so production code never
 * calls it by accident; identical to mintVerifiedCredential but greppable as a
 * test seam. Real callers use auth.ts.
 */
export const __mintVerifiedCredentialForTest = mintVerifiedCredential;

// ---------------------------------------------------------------------------
// hasCapability / assertCapability
// ---------------------------------------------------------------------------

/**
 * Pure predicate: does this verified credential grant `tool`? A non-credential
 * (forged / missing brand) has NO capabilities by definition → false.
 */
export function hasCapability(cred: VerifiedCredential, tool: ToolName): boolean {
  if (!isVerifiedCredential(cred)) return false;
  return cred.capabilities.has(tool);
}

/**
 * Enforce the capability boundary. Returns silently when granted; otherwise
 * throws ReconcileError("fatal") — the authz/non-recoverable class. MUST be
 * called BEFORE any desired-state write, plan, reconcile, or store mutation
 * (deny-before-write); the call site is responsible for placing it ahead of
 * the write path.
 *
 * The message names the denied tool (aids the caller) but NEVER enumerates the
 * credential's granted set or any other agent's capabilities (no escalation
 * aid, no secret leak).
 *
 * @throws ReconcileError("fatal") if `cred` is not a genuine VerifiedCredential
 *         (forged / unbranded) OR the tool is outside its granted set.
 */
export function assertCapability(
  cred: VerifiedCredential,
  tool: ToolName,
): void {
  if (!isVerifiedCredential(cred)) {
    throw new ReconcileError(
      "fatal",
      `authorization denied: a verified agent credential is required to call "${tool}"`,
      { entity: "agent" },
    );
  }
  if (!cred.capabilities.has(tool)) {
    throw new ReconcileError(
      "fatal",
      `authorization denied: agent is not permitted to call "${tool}"`,
      { entity: "agent" },
    );
  }
}

// ---------------------------------------------------------------------------
// v2 capability accessors — same fail-closed discipline as v1, scoped to the
// additive `V2_TOOLS` vocabulary. The v1 `assertCapability` is unchanged;
// callers of v2 tools (REST `POST /api/v2/*`, MCP v2 tool dispatches) MUST
// use `assertV2Capability` for per-tool scope enforcement.
// ---------------------------------------------------------------------------

/** Pure predicate: does this credential grant the given v2 tool? */
export function hasV2Capability(
  cred: VerifiedCredential,
  tool: V2ToolName,
): boolean {
  if (!isVerifiedCredential(cred)) return false;
  return cred.v2Capabilities.has(tool);
}

/**
 * Enforce v2 capability scope. Throws ReconcileError("fatal") on a forged
 * credential or an out-of-scope call (deny-before-write, same class
 * REST/MCP map to 403). The denial message names the denied tool but never
 * enumerates the credential's granted set.
 */
export function assertV2Capability(
  cred: VerifiedCredential,
  tool: V2ToolName,
): void {
  if (!isVerifiedCredential(cred)) {
    throw new ReconcileError(
      "fatal",
      `authorization denied: a verified agent credential is required to call "${tool}"`,
      { entity: "agent" },
    );
  }
  if (!cred.v2Capabilities.has(tool)) {
    throw new ReconcileError(
      "fatal",
      `authorization denied: agent is not permitted to call "${tool}"`,
      { entity: "agent" },
    );
  }
}

// ---------------------------------------------------------------------------
// effectiveScope — deterministic scope string recorded in the StateEvent
//
// Spec §5: every StateEvent records the acting agent; Task 4.2 ADDS the
// effective capability scope under which the call was authorized. This is the
// value the call site passes as StateEventSchema.scope (already an optional
// core-internal field — entities.ts: "core-internal: effective capability
// scope; not surfaced by the console API"). Format is stable & sorted so the
// recorded scope is deterministic and diff-friendly.
// ---------------------------------------------------------------------------

export function effectiveScope(cred: VerifiedCredential): string {
  if (!isVerifiedCredential(cred)) {
    // FAIL CLOSED (mirrors assertCapability): a non-credential has no scope.
    // A synthetic fallback string would let a forged object produce a
    // recordable scope and silently bypass the unforgeable invariant — so
    // this throws fatal exactly like its siblings (deny, never synthesise).
    throw new ReconcileError(
      "fatal",
      "authorization denied: a verified agent credential is required",
      { entity: "agent" },
    );
  }
  const caps = [...cred.capabilities].sort();
  return `agent:${cred.actor} caps:[${caps.join(",")}]`;
}

// ---------------------------------------------------------------------------
// actorOf — brand-guarded audit-identity accessor
//
// Produces StateEvent.actor (the append-only audit identity). It MUST fail
// closed: an audit-identity reader that trusts an unbranded object would let a
// forged credential write an attacker-chosen actor into the trail. So, like
// assertCapability/effectiveScope, a non-verified input is denied as fatal —
// it is NEVER given the benefit of reading `.actor`. auth.ts re-exports this
// rather than duplicating the brand/guard (the brand stays module-private).
// ---------------------------------------------------------------------------

/**
 * The acting agent identity of a verified credential (recorded as
 * StateEvent.actor). Brand-guarded: throws ReconcileError("fatal") for a
 * forged / unbranded object — it fails closed and never reads `.actor` off an
 * untrusted object, so a fabricated credential cannot inject an audit identity.
 *
 * @throws ReconcileError("fatal") if `cred` is not a genuine VerifiedCredential.
 */
export function actorOf(cred: VerifiedCredential): string {
  if (!isVerifiedCredential(cred)) {
    throw new ReconcileError(
      "fatal",
      "authorization denied: a verified agent credential is required",
      { entity: "agent" },
    );
  }
  return cred.actor;
}
