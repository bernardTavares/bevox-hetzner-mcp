/**
 * core/src/agent/v2/set-firewall.ts
 *
 * Task F1.4 — `set_firewall` (v2 write tool).
 *
 * Surface: a single `setFirewall(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/firewalls` route and the MCP `set_firewall` tool call —
 * single source of truth across transports (same envelope, same StateEvent,
 * same destructive-removal classification).
 *
 * Design principles (spec-mãe + spec-filha Bloco A):
 *
 *   - DENY-BEFORE-WRITE. The v2 capability `set_firewall` is asserted FIRST
 *     (via `assertV2Capability`). An out-of-scope call short-circuits the
 *     entire path: NO plan, NO desired-state write, NO StateEvent, NO
 *     approval row. The denial is a `ReconcileError("fatal")` which the
 *     transport layers map to HTTP 403 / MCP error envelope.
 *
 *   - WRITE-PATH = WORKING DESIRED-STATE (spec v1 §"Write-path"). The tool
 *     does NOT mutate Hetzner directly. On a non-destructive `dry_run:false`
 *     it writes the parsed `Firewall` into an injected `WorkingFirewallStore`
 *     (the v2 working desired-state seam) and emits a StateEvent. The
 *     reconciler converges Hetzner toward this desired state on its next
 *     cycle. Promotion working→git is a separate explicit tool (out of F1.4
 *     scope).
 *
 *   - DESTRUCTIVE CLASSIFICATION. A change is destructive iff it would
 *     REMOVE one or more existing rules from a firewall that is currently
 *     applied to ≥1 active server (a server matched by `applied_to`). A
 *     fresh firewall (observed === null) is NEVER destructive (this is a
 *     create). A pure rule addition or `applied_to` widening is NEVER
 *     destructive either. The classification is computed from the SAME
 *     provider plan the dry_run mode returns — the single source of truth
 *     for "removed rules" is the canonical rule-key set difference (the
 *     provider already owns the `ruleKey` canonicalisation under set
 *     semantics; this module does NOT re-implement it). For the server-
 *     coverage check we resolve `applied_to` via the SAME
 *     `resolveServerSelector` the provider uses (frozen for the duration of
 *     this call — §2.2 invariant).
 *
 *   - APPROVAL = THE SAME 4.3 GATE. When destructive, we synthesise a single
 *     SENSITIVE `PlanItem(op="remove", entity="firewall:<name>")` and route
 *     it through the SAME `ReconcileGate.evaluate()` the v1 catalog uses for
 *     `destroy`/`restore`. No parallel approval logic; the gate opens (or
 *     reuses) a pending approval keyed by (scope, op, entity) and we surface
 *     its exact approval id. The working store is NOT written in this case —
 *     fail-safe (a pending approval ⇒ NO desired-state change).
 *
 *   - V2 ENVELOPE = `buildV2WriteEnvelope`. Every response is constructed
 *     via the single Bloco-A envelope builder so the two neutral fields
 *     (`cost_estimate`, `policy_violations`) are always present on
 *     `plan`-bearing envelopes. Bloco A emits neutrals; Bloco C / Bloco D
 *     override them.
 *
 *   - STATE EVENT CARRIES `capability_token_id: null`. The v2 column was
 *     added in Task 0.2; Bloco C activates real population. For now every
 *     v2 tool writes `null` — explicit, never silently omitted.
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
  FirewallSchema,
  type Firewall,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type {
  FirewallProvider,
  ObservedFirewall,
} from "../../providers/v2/hetzner-firewall.js";
import type { Server, PlanItem } from "../../domain/entities.js";
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";
import { appendEvent } from "../../store/state-events.js";
import {
  createInMemoryWorkingStore,
  type WorkingStore,
} from "./working-store.js";
// Spec docs/specs/2026-05-27-mcp-string-interop-batch.md — defensive MCP
// client interop helpers (string→object/bool coercion).
import { asBool, asRecord } from "../tools.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

/** The tool input as it arrives from REST body / MCP arguments. */
export interface SetFirewallInput {
  /** Pure planning — never writes desired-state, never opens approvals. */
  readonly dry_run?: boolean;
  /** Desired firewall — parsed via the FROZEN `FirewallSchema`. */
  readonly firewall: unknown;
}

/** Per-call context the caller (REST/MCP) supplies. */
export interface SetFirewallCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope the tool acts on (defaulted to "firewall" by callers). */
  readonly scope: string;
}

/**
 * The minimal v2 working-store seam for firewalls. Bloco A wires an in-memory
 * default in callers/tests; a durable backing store is a separate (deferred)
 * task. The contract is: idempotent put + nullable get keyed by firewall name.
 *
 * Hoisted in F4.4 to the generic `WorkingStore<T>` (see ./working-store.ts).
 * Kept as a type-alias here so every existing caller (REST/MCP/tests) is
 * byte-for-byte unchanged.
 */
export type WorkingFirewallStore = WorkingStore<Firewall>;

/** Trivial in-memory implementation — the default Bloco-A backing store. */
export function createInMemoryWorkingFirewallStore(): WorkingFirewallStore {
  return createInMemoryWorkingStore<Firewall>();
}

/**
 * Injected dependencies. The tool OWNS no I/O of its own — it wires the
 * already-built pieces (provider, gate, store, observed-server reader, pg
 * pool for StateEvent append).
 */
export interface SetFirewallDeps {
  readonly pool: pg.Pool;
  readonly provider: FirewallProvider;
  readonly approvalGate: ReconcileGate;
  readonly workingStore: WorkingFirewallStore;
  /**
   * Returns the FROZEN-for-this-call observed Server snapshot used to resolve
   * `applied_to` (§2.2 freeze invariant). Same reader the provider uses;
   * passing it here keeps the tool decoupled from the observed-state store.
   */
  readonly serversProvider: () => Promise<readonly Server[]>;
}

// ---------------------------------------------------------------------------
// setFirewall — the single dispatch
// ---------------------------------------------------------------------------

/** Canonical rule-key (mirrors `hetzner-firewall.ts` set semantics). */
function ruleKey(rule: Firewall["rules"][number]): string {
  const sortIps = (xs?: string[]): string =>
    xs ? [...xs].sort().join(",") : "";
  return [
    rule.direction,
    rule.protocol,
    rule.port ?? "",
    sortIps(rule.source_ips),
    sortIps(rule.destination_ips),
  ].join("|");
}

/**
 * Execute the `set_firewall` tool. NEVER throws — every failure (authz,
 * parse, plan, approval gate, store) is captured into a contract-shaped
 * v2 error envelope. Returns `WriteEnvelopeV2`.
 */
export async function setFirewall(
  input: SetFirewallInput,
  ctx: SetFirewallCtx,
  deps: SetFirewallDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE. Throws fatal on out-of-scope / forged credential
  // BEFORE any plan/parse/write — no StateEvent, no approval row.
  try {
    assertV2Capability(ctx.credential, "set_firewall");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse the desired firewall through the FROZEN schema.
  let desired: Firewall;
  try {
    desired = FirewallSchema.parse(asRecord(input.firewall));
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid firewall input: ${(err as Error).message}`,
        { entity: "firewall" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `firewall:${desired.name}`;
  const actor = actorOf(ctx.credential);

  // (3) Observe Hetzner + compute the diff via the provider's pure plan().
  //     F4.1 — gate observe() behind !dryRun: dry_run is pure introspection
  //     and must NEVER make a live HTTP call. plan(desired, null) returns
  //     the create-from-empty plan, which is the correct dry_run output.
  let observed: ObservedFirewall | null = null;
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

  // (4) Destructive classification. A change is destructive iff:
  //       - observed exists (this is an update, not a create), AND
  //       - at least one observed rule is absent from desired (removal), AND
  //       - the firewall's `applied_to` resolves to ≥1 active server.
  //     Pure addition / pure `applied_to` widening / brand-new firewalls
  //     are NEVER destructive.
  let destructive = false;
  if (observed !== null) {
    const desiredKeys = new Set(desired.rules.map(ruleKey));
    const removedRules = observed.hetzner.rules.filter(
      (r) => !desiredKeys.has(ruleKey(r)),
    );
    if (removedRules.length > 0) {
      const servers = await deps.serversProvider();
      const matched = resolveServerSelector(desired.applied_to, servers);
      if (matched.length > 0) destructive = true;
    }
  }

  // (5) Dry-run → planned. NEVER writes desired-state, NEVER opens an
  //     approval, NEVER emits a StateEvent. Pure introspection.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...planOps] },
    });
  }

  // (6) Destructive + not-dry-run → route through the SAME 4.3 gate. NOTHING
  //     is written to the working store; the gate opens (or reuses) a
  //     pending approval and we surface its exact id. The gate already
  //     emits a "pending_approval" StateEvent on creation (no second event
  //     here so the trail stays single-source).
  if (destructive) {
    const item: PlanItem = {
      op: "remove",
      entity,
      change: `remove ${observed!.hetzner.rules.length - desired.rules.length} firewall rule(s) from ${entity}`,
      impact:
        "removing rule(s) from a firewall applied to active servers — approval required",
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
          (p) => p.entity === entity && p.op === "remove",
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
    // No pending approval id surfaced — either the gate is a pass-through
    // (no approvals at all) OR an internal invariant breach. Fail-safe:
    // refuse to write the destructive change, surface a fatal error.
    return toErrorEnvelope(
      new ReconcileError(
        "fatal",
        "destructive firewall change withheld but no pending approval id was reported",
        { entity },
      ),
    );
  }

  // (7) Non-destructive + not-dry-run.
  // Bug #15 (spec docs/specs/2026-05-27-set-firewall-synchronous-apply.md §2):
  // First converge Hetzner reality via provider.apply (idempotent by v2
  // Bloco A §F1.3 contract). Hetzner errors → `error` envelope BEFORE
  // persisting intent → workingStore/StateEvent stay clean (fail-safe
  // partial-state avoidance). Apply BEFORE store mirrors set_certificate
  // (managed) and set_ingress — Hetzner is the source of truth; workingStore
  // is the intent projection.
  try {
    await deps.provider.apply(desired, observed);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  try {
    await deps.workingStore.put(desired.name, desired);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  try {
    await appendEvent(deps.pool, {
      actor,
      scope: ctx.scope,
      op: observed === null ? "create" : "update",
      entity,
      result: "applied",
      after: {
        rules: desired.rules,
        applied_to: desired.applied_to,
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
    error: new ReconcileError("fatal", "set_firewall failed", {
      entity: "firewall",
    }).toApiError(),
  });
}
