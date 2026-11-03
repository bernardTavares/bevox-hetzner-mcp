/**
 * core/src/agent/tools.ts
 *
 * The 12-tool catalog — the SINGLE shared tool core both the REST API
 * (Task 4.5) and the MCP server (Task 4.7) call. There is exactly one
 * `executeTool` dispatch and one per-tool policy table; REST/MCP are thin
 * transports over it and can never grow parallel tool logic.
 *
 * Design principles (CLAUDE.md non-negotiables; spec §"Approval Gate"):
 *
 *   - CONTRACT-FROZEN I/O. Mutating tools return a 4.1 `WriteEnvelope`
 *     (planned | pending_approval | applied | error) built ONLY via the 4.1
 *     builders; read tools return the contract entity/state/events/health
 *     shapes. console/ is never modified — the catalog conforms.
 *
 *   - AUTHZ FIRST, ALWAYS. EVERY tool call routes through the 4.2
 *     `authorizeAndRecord` spine: deny-before-write (an out-of-scope or
 *     forged credential reaches NO read/write and produces NO StateEvent),
 *     and an authorized call is audited on BOTH success and failure with the
 *     actor + effective scope taken from the verified credential. The catalog
 *     NEVER re-implements auth or per-tool failure auditing.
 *
 *   - APPROVAL POLICY IS DATA, NOT CONDITIONALS. `TOOL_POLICY` mirrors the
 *     frozen console contract (CONTRACT.md §"Write Envelope" lifecycle + the
 *     Tool table): reads→read; provision_server/restore/destroy→always;
 *     deploy_service/scale_service/apply_manifest→conditional;
 *     set_dns/snapshot→none. The per-tool sensitivity predicate handed to the
 *     4.3 gate IS this policy — the documented 4.3 injection seam
 *     ("SENSITIVITY IS INJECTED … the full per-tool policy table is Task
 *     4.4"). No second approval/auth mechanism is built here.
 *
 *   - FAIL-SAFE. `always`-policy tools yield a `pending_approval` envelope and
 *     mutate NOTHING until approved (the 4.3 gate withholds; the reconciler
 *     never auto-destructs). `dry_run` plans only — no desired-state write, no
 *     reconcile, no secret resolution (a `secret:` ref appears verbatim, never
 *     a value). Errors → 4.1 `error()` with the ReconcileError class; secrets
 *     never leak into any envelope or audit record.
 *
 *   - DRY/YAGNI. Pure wiring of existing pieces (4.1 envelope, 4.2 authz, 4.3
 *     gate, reconcile/plan/stores). NO REST, NO MCP, NO new domain entities,
 *     NO new approval/auth machinery. Minimal exported surface.
 *
 *   - PROMOTE IS CORE-INTERNAL, NOT A CONTRACT TOOL. `promote_manifest`
 *     (Task 4.8 — write the working desired-state into the git canonical
 *     manifest) is NOT one of the FROZEN 12. The console only knows the 12
 *     (`ALL_TOOLS`/contract.ts); adding promote to `ALL_TOOLS`/`TOOL_POLICY`/
 *     the MCP-listed catalog would break the 12-tool conformance (4.6) and
 *     capability/mcp tests. So it is a SEPARATE `ToolCatalog.promoteManifest`
 *     method — its own authz spine + the SAME 4.3 gate, never in the 12-tool
 *     dispatch. It reuses the agent's existing `apply_manifest` capability
 *     (promote IS the git-side of manifest application) so no new capability
 *     vocabulary is minted. Fail-safe: it writes+commits the canonical YAML
 *     ONLY when the approval is resolved `approved`; pending/rejected/expired
 *     ⇒ NO write, NO commit (a forward commit only — never history rewrite,
 *     never a remote, never a resolved secret).
 *
 * Exported API (ONLY these):
 *   createToolCatalog(deps) → ToolCatalog   — the shared catalog factory
 *   TOOL_POLICY                              — tool → policy table (contract)
 *   type ToolPolicy / ToolCatalog / ToolContext / ToolResult / ToolDeps
 *   type PromoteParams
 */

import type pg from "pg";

import {
  ALL_TOOLS,
  type ToolName,
  type VerifiedCredential,
} from "./capability.js";
import { authorizeAndRecord, actorOf } from "./auth.js";
import {
  applied,
  error as errorEnvelope,
  pendingApproval,
  planned,
  type WriteEnvelope,
} from "./envelope.js";
import {
  reconcile,
  type GateContext,
  type ReconcileGate,
  type PendingApproval,
} from "../reconciler/reconcile.js";
import { plan } from "../reconciler/plan.js";
import { defaultIsSensitive } from "./approval-gate.js";
import { strictManifestIsSensitive } from "./strict-manifest-sensitivity.js";
import type { Provider, ObservedSlice } from "../providers/provider.js";
import type { DesiredState } from "../domain/desired-state.js";
import { DesiredStateSchema } from "../domain/desired-state.js";
import type { State, PlanItem } from "../domain/entities.js";
// (State is re-used by the optional v2 observedReader dep below)
import { ReconcileError } from "../domain/errors.js";
import type { Logger } from "../observability/logger.js";
import { entityKey } from "../store/state-store-helper.js";
import { getState as getObservedState } from "../store/observed-store.js";
import { queryEvents, appendEvent } from "../store/state-events.js";
import {
  readCanonicalManifest,
  writeCanonicalManifest,
  commitManifest,
  diffManifest,
} from "../store/manifest-repo.js";
import {
  resolveServerSelector,
  type SelectorInput,
} from "./v2/resolve-selector.js";

// ---------------------------------------------------------------------------
// Approval policy — DATA mirroring the frozen console contract
// ---------------------------------------------------------------------------

/**
 * Per-tool approval policy (CONTRACT.md §"Write Envelope" lifecycle):
 *   read        — a GET-shaped read; NO approval, NO desired-state write,
 *                 NO reconcile mutation (get_state/diff/events/health).
 *   always      — ALWAYS requires approval before any mutation
 *                 (provision_server, restore, destroy).
 *   conditional — approval required ONLY when the resulting change is
 *                 sensitive (the 4.3 op-based predicate decides); else apply
 *                 directly (deploy_service apply, scale_service,
 *                 apply_manifest).
 *   none        — apply directly, never approval-gated, still authz+audited
 *                 + fail-safe (set_dns, snapshot).
 */
export type ToolPolicy = "read" | "always" | "conditional" | "none";

/**
 * THE per-tool policy table. Keys are EXACTLY the 4.2 `ALL_TOOLS` vocabulary
 * (single source — not a second list). Values come straight from the frozen
 * contract; this object is the data the dispatch + the 4.3 sensitivity
 * predicate read (no scattered conditionals).
 */
export const TOOL_POLICY: Readonly<Record<ToolName, ToolPolicy>> = {
  get_state: "read",
  diff: "read",
  events: "read",
  health: "read",
  provision_server: "always",
  deploy_service: "conditional",
  scale_service: "conditional",
  set_dns: "none",
  snapshot: "none",
  restore: "always",
  destroy: "always",
  apply_manifest: "conditional",
};

const TOOL_NAME_SET: ReadonlySet<string> = new Set(ALL_TOOLS);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The verified caller + the reconcile scope this tool acts on. */
export interface ToolContext {
  /** The 4.2 verified, unforgeable credential (actor + capability set). */
  readonly credential: VerifiedCredential;
  /**
   * The reconcile scope (the `<kind>` partition, e.g. "server"/"service"/
   * "dns"/"volume"/"network"). The caller (REST/MCP) supplies it from the
   * routed resource; the catalog never derives a scope from secret input.
   */
  readonly scope: string;
}

/**
 * A tool result. Mutating tools return a contract `WriteEnvelope`; read tools
 * return `{ status:"ok", data }` carrying the contract read shape. Any failure
 * (authz, precondition, reconcile) is the 4.1 `error()` envelope. This single
 * union is what BOTH REST (4.5) and MCP (4.7) serialize.
 */
export type ToolResult =
  | WriteEnvelope
  | { readonly status: "ok"; readonly data: unknown };

/**
 * Injected dependencies. The catalog OWNS no I/O of its own — it wires the
 * already-built pieces. `makeGate(isSensitive)` is the documented 4.3
 * injection seam: the catalog supplies the per-tool policy as the sensitivity
 * predicate; 4.3 stays the single approval implementation.
 */
export interface ToolDeps {
  readonly pool: pg.Pool;
  readonly provider: Provider;
  readonly observedAdapter: (slice: ObservedSlice) => State;
  /** Desired-state source for a scope (working-store / parsed manifest). */
  readonly loadDesired: (scope: string) => Promise<DesiredState>;
  /**
   * Persist the tool's desired-state delta for a scope BEFORE reconcile. The
   * caller owns where desired lives (working-store by default); the catalog
   * only hands it the merged desired so reconcile's loadDesired reads it back.
   */
  readonly writeDesired: (scope: string, desired: DesiredState) => Promise<void>;
  /**
   * Build a `ReconcileGate` with the given per-call sensitivity predicate.
   * Reuses 4.3 `createApprovalGate` — the catalog NEVER forks approval logic.
   */
  readonly makeGate: (
    isSensitive: (item: PlanItem) => boolean,
  ) => ReconcileGate;
  /**
   * OPTIONAL — v2 observed-state reader for `resolveSelector` (Task 0.4).
   * Defaults to the v1 `observed-store.getState(pool, scope)` (which is the
   * same source `get_state` reads). Omitted ⇒ the v2 method falls back to
   * that default. BACKWARD-COMPAT: every prior 4.x/5.x/6.x catalog caller
   * is byte-for-byte unaffected.
   */
  readonly observedReader?: (scope: string) => Promise<State>;
  /**
   * OPTIONAL — structured logger threaded into the reconcile cycle that the
   * catalog drives via `reconcileToEnvelope`. Without it, reconcile falls
   * back to `noopLogger` → the apply-path "reconcile cycle complete" and
   * per-item "reconcile apply item" logs are silenced (server.ts:periodic
   * passes its logger but the catalog seam did not). Spec
   * docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §3.
   * BACKWARD-COMPAT: absent ⇒ existing test harnesses stay silent.
   */
  readonly logger?: Logger;
  /**
   * OPTIONAL — when `true`, `doApplyManifest` uses `strictManifestIsSensitive`
   * (consults TOOL_POLICY per-entity-kind) instead of the default
   * `defaultIsSensitive` (op-only). Default `false` preserves v1 FROZEN
   * behavior. Spec docs/specs/2026-05-27-strict-manifest-approval-knob.md.
   * Wired from `STRICT_MANIFEST_APPROVAL === "on"` via buildBootDeps.
   */
  readonly strictManifestApproval?: boolean;
}

/**
 * Parameters for the core-internal `promote_manifest` (Task 4.8). The caller
 * (agent layer) supplies the git repo working-tree path and, optionally, the
 * repo-relative manifest path (defaults to the canonical filename inside
 * manifest-repo.ts). `repoPath` is operator-controlled infrastructure config,
 * never secret/user input.
 */
export interface PromoteParams {
  /** Absolute path to the git repo working tree holding the canonical YAML. */
  readonly repoPath: string;
  /** Repo-relative manifest path. Defaults to the canonical filename. */
  readonly manifestPath?: string;
}

export interface ToolCatalog {
  /**
   * Execute one tool. ALWAYS routes through the 4.2 authz spine first
   * (deny-before-write + audit). Returns a contract `ToolResult`; throws
   * nothing — every failure is an `error()` envelope.
   */
  executeTool(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult>;

  /**
   * Promote the working desired-state into the git canonical manifest
   * (Task 4.8). CORE-INTERNAL — NOT one of the FROZEN 12 contract tools (the
   * console only parses the 12; this never pollutes that surface or the 4.6
   * conformance oracle). Reuses the agent's `apply_manifest` capability for
   * authz (deny-before-write + audited) and the SAME 4.3 approval gate.
   *
   * Behaviour (fail-safe):
   *   - no working×git diff ⇒ a no-op `applied()` (nothing to promote — NO
   *     approval, NO write, NO commit);
   *   - a diff ⇒ SENSITIVE: the 4.3 gate withholds and opens a pending
   *     approval ⇒ `pending_approval` (working YAML NOT written/committed);
   *   - the gate sees an `approved` decision for this action ⇒ write the
   *     canonical YAML + ONE forward commit ⇒ `applied()`.
   *   - rejected / expired(cancelled) / still-pending ⇒ ABSOLUTELY NO write,
   *     NO commit.
   * Returns a contract `WriteEnvelope`; throws nothing (failure → error()).
   */
  promoteManifest(
    params: PromoteParams,
    ctx: ToolContext,
  ): Promise<WriteEnvelope>;

  /**
   * v2 read-only tool — `resolve_selector` (Task 0.4). Resolves a
   * `{ label, name, ... }` selector against the CURRENT observed `Server[]`
   * for `ctx.scope` (callers default this to "server") and returns the
   * matched names sorted ascending. CORE-INTERNAL — NOT in the FROZEN 12
   * (the `ALL_TOOLS` / `TOOL_POLICY` / 4.6 conformance oracle stay
   * untouched).
   *
   * SINGLE SOURCE OF TRUTH (spec-filha §1): wraps the SAME pure
   * `resolveServerSelector` the reconciler will call once per cycle (§2.2
   * freeze-for-the-plan invariant). REST/MCP both invoke this method, so
   * the resolution path is identical across transports + reconciler.
   *
   * Read discipline: NO approval, NO mutation, NO StateEvent. A read failure
   * surfaces as a contract `error()` envelope; the matched-names success
   * returns `{ status:"ok", data:{ matched } }` (same `ToolResult` shape
   * `executeTool` uses for the four FROZEN read tools).
   */
  resolveSelector(
    selector: SelectorInput,
    ctx: ToolContext,
  ): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function asRecord(input: unknown): Record<string, unknown> {
  // Accept JSON-encoded string input — some MCP clients (Claude Code et al.)
  // serialize nested object args as JSON strings. Spec
  // docs/specs/2026-05-27-asrecord-accept-json-string.md §2.
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * Coerce ambiguous boolean-like inputs (some MCP clients serialize booleans
 * as strings: `"true"`, `"false"`). Conservative: only `true`, `"true"`,
 * `"1"`, `1` → `true`. Ambiguous/absent → `false`. Default is "apply"
 * (NOT dry_run); operator must opt-in explicitly. Spec
 * docs/specs/2026-05-27-mcp-string-interop-batch.md §1.1.
 */
export function asBool(input: unknown): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") return input === "true" || input === "1";
  if (typeof input === "number") return input === 1;
  return false;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Map an unknown thrown value to the 4.1 `error()` envelope (no leak). */
function toErrorEnvelope(err: unknown): WriteEnvelope {
  if (err instanceof ReconcileError) return errorEnvelope(err);
  // A non-ReconcileError is treated as fatal with a value-free message —
  // never echo the raw error (it may carry sensitive context).
  return errorEnvelope(
    new ReconcileError("fatal", "tool execution failed", { entity: "agent" }),
  );
}

// ---------------------------------------------------------------------------
// createToolCatalog
// ---------------------------------------------------------------------------

export function createToolCatalog(deps: ToolDeps): ToolCatalog {
  const { pool, provider, observedAdapter, loadDesired, writeDesired, makeGate, logger } =
    deps;
  const strictManifestApproval = deps.strictManifestApproval ?? false;
  // v2 read seam — defaults to the SAME observed-store.getState the v1 read
  // tool `get_state` uses (single-source-of-truth for the observed Server[]
  // both the v2 resolve_selector tool and the reconciler will consume).
  const observedReader =
    deps.observedReader ?? ((scope: string) => getObservedState(pool, scope));

  /**
   * Run the reconcile cycle for a scope with a gate whose sensitivity is THIS
   * tool's policy, then map the outcome onto a contract WriteEnvelope:
   *   - any item withheld by the gate ⇒ a pending approval exists ⇒
   *     `pending_approval` carrying its approval_id (fail-safe: not applied);
   *   - otherwise ⇒ `applied`.
   * The reconcile path itself (Observe→Plan→Gate→Apply→Record) is reused
   * unchanged — the catalog adds no convergence logic.
   */
  async function reconcileToEnvelope(
    scope: string,
    actor: string,
    isSensitive: (item: PlanItem) => boolean,
    /**
     * Optional selector for the withheld item that corresponds to the action
     * the CALLER requested. The 4.3 gate's approval identity is
     * `(scope, op, entity)`; when a plan withholds ≥2 sensitive items in one
     * scope (or two concurrent same-scope calls run), a scope-only lookup
     * would surface an ARBITRARY approval. The gate now reports each withheld
     * item's EXACT approval id (reconcile threads it onto `WithheldItem`); we
     * pick the one matching the requested action's entity (+ op if given) and
     * surface ITS id — never a heuristic requery.
     */
    requested?: { readonly op?: string; readonly entity: string },
  ): Promise<WriteEnvelope> {
    const gate = makeGate(isSensitive);
    const run = reconcile({
      pool,
      provider,
      gate,
      observedAdapter,
      loadDesired,
      // Spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §3:
      // thread the injected logger so the catalog-driven apply path emits the
      // same "reconcile cycle complete" / "reconcile apply item" logs the
      // periodic timer in server.ts already produces. Absent ⇒ reconcile
      // falls back to noopLogger (backward-compatible for tests sans logger).
      ...(logger ? { logger } : {}),
    });
    const result = await run({ scope, actor });

    if (result.withheld.length > 0) {
      // The gate reported, per withheld item, its EXACT opened/reused approval
      // id (reconcile surfaces it on the additive `pendingApprovals` parallel
      // channel, keyed by the gate's own (op,entity)). Pick the one this call
      // actually requested: if the caller pinned an entity, match it exactly
      // (+ op when supplied); otherwise (no single requested entity, e.g.
      // apply_manifest) take the first — still its OWN correct gate-reported
      // id, never a scope-only requery.
      const picked: PendingApproval | undefined =
        requested !== undefined
          ? result.pendingApprovals.find(
              (p) =>
                p.entity === requested.entity &&
                (requested.op === undefined || p.op === requested.op),
            )
          : result.pendingApprovals[0];
      const id = picked?.approvalId;
      if (id) return pendingApproval(id);
      // Internal invariant violation: reconcile reported a withheld item but
      // the gate carried no approval id for it (or no withheld item matched
      // the requested action). With the gate→reconcile accessor this is
      // near-unreachable; if it happens it is an internal-contract breach,
      // NOT a user/precondition conflict — classify it `fatal` (fail-safe:
      // never a false `applied`).
      throw new ReconcileError(
        "fatal",
        "action withheld by the approval gate but no approval id was reported",
        { entity: requested?.entity ?? scope },
      );
    }
    if (result.failed.length > 0) {
      // Bug #5 fix (spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §2):
      // when applyPlan reports failures (e.g., provider throws at apply time),
      // surface them as `error` envelope instead of masking as `applied()`.
      // Precedence: withheld > failed > applied. Pick the requested entity's
      // failed item when the caller pinned one; fallback to the first failed
      // item (apply.ts already topo-orders items deterministically).
      const picked =
        requested !== undefined
          ? result.failed.find((f) => f.entity === requested.entity) ??
            result.failed[0]
          : result.failed[0];
      if (!picked) {
        throw new ReconcileError(
          "fatal",
          "reconcileToEnvelope: report.failed.length > 0 but no item present (internal invariant)",
          { entity: scope },
        );
      }
      return errorEnvelope(
        new ReconcileError(picked.errorClass, picked.message, {
          entity: picked.entity,
        }),
      );
    }
    return applied();
  }

  /**
   * Merge a per-entity desired delta into the scope's existing desired state
   * and persist it via the injected writer, so the subsequent reconcile's
   * loadDesired observes the tool's intent. Pure desired-state write — no
   * provider mutation here (that is reconcile's Apply step, gated).
   */
  async function mergeDesired(
    scope: string,
    patch: (d: DesiredState) => DesiredState,
  ): Promise<void> {
    const current = await loadDesired(scope);
    const next = DesiredStateSchema.parse(patch(current));
    await writeDesired(scope, next);
  }

  // -- the 12 tool implementations (each its own logic + policy) ------------

  async function doProvisionServer(
    input: Record<string, unknown>,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const dryRun = asBool(input.dry_run);
    const serverName = str(input.name);
    const serverEntry = {
      name: serverName,
      type: str(input.type),
      location: str(input.location),
      network: str(input.network),
      ...(input.image !== undefined ? { image: str(input.image) } : {}),
    };

    if (dryRun) {
      // dry_run → planned: plan() ONLY against the current desired+observed.
      // NO desired-state write, NO reconcile, NO secret resolution. Mirrors
      // the canonical doDeployService dry_run branch (3.3/F2 discipline).
      const current = await loadDesired(scope);
      const desired: DesiredState = DesiredStateSchema.parse({
        ...current,
        networks: current.networks ?? [],
        servers: [...(current.servers ?? []), serverEntry],
      });
      const observed = await getObservedState(pool, scope);
      return planned(plan(desired, observed));
    }

    await mergeDesired(scope, (d) => ({
      ...d,
      networks: d.networks ?? [],
      servers: [...(d.servers ?? []), serverEntry],
    }));
    // ALWAYS approval: every planned mutation is sensitive for this tool. The
    // requested action is the create of THIS server; surface ITS exact
    // approval id even if the scope withheld other items concurrently.
    return reconcileToEnvelope(scope, actor, () => true, {
      op: "create",
      entity: entityKey("server", serverName),
    });
  }

  async function doDeployService(
    input: Record<string, unknown>,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const dryRun = asBool(input.dry_run);
    const svc = {
      name: str(input.name),
      image: str(input.image),
      replicas:
        typeof input.replicas === "number" ? input.replicas : 1,
      ...(input.env !== undefined
        ? { env: input.env as Record<string, string> }
        : {}),
      ...(input.ports !== undefined
        ? { ports: input.ports as string[] }
        : {}),
      ...(input.volumes !== undefined
        ? { volumes: input.volumes as string[] }
        : {}),
    };

    if (dryRun) {
      // dry_run → planned: plan() ONLY against the current desired+observed.
      // NO desired-state write, NO reconcile, NO secret resolution — a
      // `secret:` ref stays verbatim in the plan (plan() is pure, never
      // resolves). This keeps resolution structurally unreachable from
      // dry_run (1.9/3.3/4.x discipline carried to the tool layer).
      const current = await loadDesired(scope);
      const desired: DesiredState = DesiredStateSchema.parse({
        ...current,
        services: [
          ...(current.services ?? []).filter((s) => s.name !== svc.name),
          svc,
        ],
      });
      const observed = await getObservedState(pool, scope);
      return planned(plan(desired, observed));
    }

    await mergeDesired(scope, (d) => ({
      ...d,
      services: [
        ...(d.services ?? []).filter((s) => s.name !== svc.name),
        svc,
      ],
    }));
    // conditional: the 4.3 op-based predicate decides (a create/update is
    // non-sensitive ⇒ applied; a sensitive op in the plan ⇒ withheld). The
    // requested action targets THIS service — surface its exact approval id.
    return reconcileToEnvelope(scope, actor, defaultIsSensitive, {
      entity: entityKey("service", svc.name),
    });
  }

  async function doScaleService(
    input: Record<string, unknown>,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const dryRun = asBool(input.dry_run);
    const name = str(input.name);
    const replicas =
      typeof input.replicas === "number" ? input.replicas : 1;

    if (dryRun) {
      // dry_run → planned: plan() against the current desired with the
      // hypothetical scaled service. NO desired-state write, NO reconcile,
      // NO secret resolution (3.3/F2 discipline).
      const current = await loadDesired(scope);
      const desired: DesiredState = DesiredStateSchema.parse({
        ...current,
        services: (current.services ?? []).map((s) =>
          s.name === name ? { ...s, replicas } : s,
        ),
      });
      const observed = await getObservedState(pool, scope);
      return planned(plan(desired, observed));
    }

    await mergeDesired(scope, (d) => {
      const services = (d.services ?? []).map((s) =>
        s.name === name ? { ...s, replicas } : s,
      );
      return { ...d, services };
    });
    return reconcileToEnvelope(scope, actor, defaultIsSensitive, {
      entity: entityKey("service", name),
    });
  }

  async function doSetDns(
    input: Record<string, unknown>,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const dryRun = asBool(input.dry_run);
    const record = {
      zone: str(input.zone),
      name: str(input.name),
      type: str(input.type),
      value: str(input.value),
      ...(typeof input.ttl === "number" ? { ttl: input.ttl } : {}),
    };

    if (dryRun) {
      // dry_run → planned: plan() against the current desired with the
      // hypothetical record (mirrors the apply branch's dedup predicate).
      // NO desired-state write, NO reconcile, NO secret resolution.
      const current = await loadDesired(scope);
      const desired: DesiredState = DesiredStateSchema.parse({
        ...current,
        dns: [
          ...(current.dns ?? []).filter(
            (r) =>
              !(
                r.zone === record.zone &&
                r.name === record.name &&
                r.type === record.type
              ),
          ),
          record,
        ],
      });
      const observed = await getObservedState(pool, scope);
      return planned(plan(desired, observed));
    }

    await mergeDesired(scope, (d) => ({
      ...d,
      dns: [
        ...(d.dns ?? []).filter(
          (r) =>
            !(
              r.zone === record.zone &&
              r.name === record.name &&
              r.type === record.type
            ),
        ),
        record,
      ],
    }));
    // none: never approval-gated (nothing is sensitive for this tool).
    return reconcileToEnvelope(scope, actor, () => false);
  }

  async function doApplyManifest(
    input: Record<string, unknown>,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const dryRun = asBool(input.dry_run);
    // Full-manifest replace for the scope. The manifest is validated through
    // the SAME DesiredStateSchema (no ad-hoc parsing). conditional: a
    // sensitive op inside the manifest's plan is withheld; else applied.
    const manifest = DesiredStateSchema.parse(asRecord(input.manifest));

    if (dryRun) {
      // dry_run → planned: the manifest IS the desired in this handler, so
      // plan() runs over (manifest, observed) directly. NO writeDesired,
      // NO reconcile, NO secret resolution (3.3/F2 discipline).
      const observed = await getObservedState(pool, scope);
      return planned(plan(manifest, observed));
    }

    // FAN-OUT (spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.1):
    // Decompose the manifest into per-scope desired-state entries so that
    // per-kind callers (loadDesired("server"), get_state, periodic drift
    // sweep) observe what apply_manifest declared. Slices absent from the
    // manifest are NOT written — ausência ≠ apagar (fail-safe §5 #3).
    if (manifest.backups)  await writeDesired("backup",  { backups:  manifest.backups });
    if (manifest.dns)      await writeDesired("dns",     { dns:      manifest.dns });
    if (manifest.networks) await writeDesired("network", { networks: manifest.networks });
    if (manifest.servers)  await writeDesired("server",  { servers:  manifest.servers });
    if (manifest.services) await writeDesired("service", { services: manifest.services });
    if (manifest.volumes)  await writeDesired("volume",  { volumes:  manifest.volumes });
    // STRICT_MANIFEST_APPROVAL (spec 2026-05-27-strict-manifest-approval-knob §1.3):
    // opt-in policy strengthening — consult TOOL_POLICY per-entity-kind so
    // bulk-manifest creates inherit the policy of the equivalent stand-alone
    // tool (e.g. create server:* lifts to provision_server "always").
    // Default false ⇒ defaultIsSensitive (v1 FROZEN behavior unchanged).
    const isSensitive = strictManifestApproval
      ? strictManifestIsSensitive
      : defaultIsSensitive;
    return reconcileToEnvelope(scope, actor, isSensitive);
  }

  /**
   * Imperative ops with NO desired-state diff that plan() would produce
   * (destroy/restore/snapshot). They route the synthesized intent through the
   * SAME 4.3 gate (no parallel approval logic): a sensitive policy ⇒ the gate
   * withholds and opens a pending approval (fail-safe — reality untouched); a
   * `none` policy ⇒ the gate approves and the op is recorded as applied (the
   * concrete restic/destroy execution is its Fase-5 provider — out of scope).
   */
  async function doGatedOp(
    op: PlanItem["op"],
    entity: string,
    scope: string,
    actor: string,
    sensitive: boolean,
    dryRun: boolean,
  ): Promise<WriteEnvelope> {
    const item: PlanItem = {
      op,
      entity,
      change: `${op} ${entity}`,
      impact:
        op === "destroy"
          ? "irreversible removal — approval required"
          : op === "restore"
            ? "overwrites with a snapshot — approval required"
            : "create a point-in-time snapshot",
    };
    // F4.7 — dry_run is pure introspection. Surface the synthetic PlanItem
    // and short-circuit BEFORE gate.evaluate so no approval row is created.
    if (dryRun) {
      return planned([item]);
    }
    const gate = makeGate(() => sensitive);
    // The 4.3 gate keys pending approvals by (scope, op, entity). Imperative
    // ops (destroy/restore/snapshot) have no plan()-derived reconcile scope,
    // so we key them by the acting agent + the caller scope — deterministic
    // and unique per (actor, op, entity). The catalog never forks the gate.
    const gctx: GateContext = { scope: `agent:${actor}:${scope}`, actor };
    const decision = await gate.evaluate([item], gctx);
    if (decision.denied.length > 0) {
      const apr = await pool.query<{ id: string }>(
        `SELECT id FROM approvals
           WHERE scope = $1 AND op = $2 AND entity = $3 AND status = 'pending'
           ORDER BY requested_at DESC, id DESC
           LIMIT 1`,
        [`agent:${actor}:${scope}`, op, entity],
      );
      const id = apr.rows[0]?.id;
      if (id) return pendingApproval(id);
      throw new ReconcileError(
        "conflict",
        "operation withheld by the approval gate but no pending approval was found",
        { entity },
      );
    }
    // APPROVED (or `none` policy) → EXECUTE (Bug 8, caller-retry model). For a
    // destroy with a provider destroy executor, perform the sanctioned removal
    // and record the StateEvent with the actor. restore/snapshot, and providers
    // without `destroy`, remain a recorded no-op (back-compat). The reconcile
    // path is untouched — this is the gate-approved destructive path only.
    if (op === "destroy" && provider.destroy) {
      const result = await provider.destroy({ op, entity, desired: {} });
      const evScope = entity.includes(":")
        ? entity.slice(0, entity.indexOf(":"))
        : scope;
      await appendEvent(pool, {
        actor,
        scope: evScope,
        op: "destroy",
        entity,
        result: result.changed ? "ok" : "noop",
      });
    }
    return applied();
  }

  // -- promote_manifest (Task 4.8) — CORE-INTERNAL, approval-gated ---------

  /**
   * Diff the working desired-state against the git canonical manifest and,
   * ONLY on an approved decision, write+commit the canonical YAML. This is
   * the gated core of `promoteManifest`; the authz/audit spine wraps it.
   *
   * Approval identity: a synthetic SENSITIVE PlanItem with the FROZEN PlanOp
   * `update` (promote is NOT a new PlanOp — `PlanOpEnum` mirrors the frozen
   * contract value-for-value and must NOT widen) over a stable `manifest:`
   * entity keyed by the repo+manifest path. The SAME 4.3 gate decides; no
   * parallel approval logic. Fail-safe: pending/rejected/expired ⇒ NO write.
   */
  async function doPromote(
    params: PromoteParams,
    scope: string,
    actor: string,
  ): Promise<WriteEnvelope> {
    const manifestPath = params.manifestPath;
    const working = await loadDesired(scope);

    // git canonical side. A *missing* canonical file means "nothing committed
    // yet" → treat as an empty manifest so the very first promote is a normal
    // create-diff (NOT an error that blocks the initial promotion).
    let git: DesiredState;
    try {
      git = manifestPath !== undefined
        ? await readCanonicalManifest(params.repoPath, manifestPath)
        : await readCanonicalManifest(params.repoPath);
    } catch (e) {
      if (
        e instanceof ReconcileError &&
        e.errorClass === "precondition" &&
        /cannot read manifest/.test(e.message)
      ) {
        git = {};
      } else {
        throw e;
      }
    }

    // Pure structural diff (uses the shared collision-free entityKey).
    const drift = diffManifest(working, git);
    if (drift.length === 0) {
      // Nothing to promote: a no-op. NO approval is opened, NO write, NO
      // commit — working already matches git canonical (fail-safe & idempotent
      // re-promote).
      return applied();
    }

    // There IS a diff ⇒ SENSITIVE. Route through the SAME 4.3 gate. The gate
    // key (scope,op,entity) is deterministic & unique for this repo+path so a
    // concurrent/re-evaluated promote dedupes onto one pending (no flap).
    const entity = entityKey(
      "manifest",
      params.repoPath,
      manifestPath ?? "",
    );
    const gateScope = `agent:${actor}:${scope}`;
    const item: PlanItem = {
      op: "update",
      entity,
      change: `promote ${drift.length} working→git manifest change(s)`,
      impact:
        "writes & commits the canonical manifest in git — approval required",
    };
    const gate = makeGate(() => true); // a manifest diff is always sensitive
    const gctx: GateContext = { scope: gateScope, actor };
    const decision = await gate.evaluate([item], gctx);

    if (decision.denied.length > 0) {
      // Withheld: there is NO approved decision (pending / rejected / expired
      // / first-time). ABSOLUTELY NO write, NO commit — surface the exact
      // pending approval id the gate opened/reused (its additive channel),
      // never a scope-only requery.
      const picked = (decision.pendingApprovals ?? []).find(
        (p) => p.entity === entity && p.op === "update",
      );
      if (picked) return pendingApproval(picked.approvalId);
      // No approved decision and no open pending reported ⇒ a rejected/expired
      // terminal record exists but no fresh pending was opened by THIS gate
      // (the gate opens a fresh pending only when none is open). Re-query the
      // open pending defensively; if truly none, it's an internal invariant
      // breach — fail-safe (never a false `applied`, never a silent write).
      const apr = await pool.query<{ id: string }>(
        `SELECT id FROM approvals
           WHERE scope = $1 AND op = 'update' AND entity = $2
             AND status = 'pending'
           ORDER BY requested_at DESC, id DESC
           LIMIT 1`,
        [gateScope, entity],
      );
      const id = apr.rows[0]?.id;
      if (id) return pendingApproval(id);
      throw new ReconcileError(
        "conflict",
        "promote withheld by the approval gate but no pending approval was found",
        { entity },
      );
    }

    // Approved ⇒ apply: serialize the WORKING desired-state to the canonical
    // YAML and create ONE forward commit. Refs stay refs (no secret resolve);
    // no history rewrite, no remote. Order: write THEN commit so a write
    // failure never produces an empty/false commit.
    const written = manifestPath !== undefined
      ? await writeCanonicalManifest(params.repoPath, working, manifestPath)
      : await writeCanonicalManifest(params.repoPath, working);
    await commitManifest(
      params.repoPath,
      manifestPath ?? written.slice(params.repoPath.length + 1),
      "chore(manifest): promote working state to git canonical (bevox-hetzner-mcp)",
    );
    return applied();
  }

  // -- read tools ----------------------------------------------------------

  async function doRead(
    name: ToolName,
    input: Record<string, unknown>,
    scope: string,
  ): Promise<unknown> {
    switch (name) {
      case "get_state": {
        // Observed reality for the scope (the contract State shape). A read —
        // NEVER resolves secrets, NEVER mutates.
        return getObservedState(pool, scope);
      }
      case "diff": {
        // desired (working) × observed → plan items (drift surface).
        const desired = await loadDesired(scope);
        const observed = await getObservedState(pool, scope);
        return plan(desired, observed);
      }
      case "events": {
        return queryEvents(pool, {
          ...(input.actor !== undefined
            ? { actor: str(input.actor) }
            : {}),
          ...(input.entity !== undefined
            ? { entity: str(input.entity) }
            : {}),
          ...(input.result !== undefined
            ? { result: str(input.result) }
            : {}),
        });
      }
      case "health": {
        // Minimal contract HealthReport. Rich circuit-breaker/drift telemetry
        // is Fase-6; here we surface the shape the contract requires with the
        // currently-knowable fields (no fabricated data).
        return {
          circuit_breakers: [],
          degraded: [],
          blocked: [],
          drift: [],
          reconciler: {
            state: "idle",
            last_cycle: "",
            last_result: "",
            next_cycle_in: "",
            total_cycles: 0,
          },
        };
      }
      default:
        // Unreachable: doRead is only called for read-policy tools.
        throw new ReconcileError(
          "fatal",
          `not a read tool: "${name}"`,
          { entity: "agent" },
        );
    }
  }

  // -- the single shared dispatch ------------------------------------------

  async function executeTool(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    // Unknown tool: fatal BEFORE any authz/side effect. (assertCapability
    // would also reject it, but a typed catalog should fail clearly here.)
    if (!TOOL_NAME_SET.has(name)) {
      return toErrorEnvelope(
        new ReconcileError(
          "fatal",
          `unknown tool: "${name}"`,
          { entity: "agent" },
        ),
      );
    }
    const tool = name as ToolName;
    const policy = TOOL_POLICY[tool];
    const rec = asRecord(input);
    const { credential, scope } = ctx;
    // The 4.2 audit identity (actor) is taken from the verified credential by
    // authorizeAndRecord; we pass a stable entity for the audit row.
    const auditEntity = `tool:${tool}`;

    // For reads we capture the read payload inside the audited action so the
    // 4.2 spine still owns deny-before-anything + audit-on-both-outcomes; the
    // read performs NO mutation.
    let readPayload: unknown;
    let writeEnvelope: WriteEnvelope | undefined;

    const action = async (): Promise<void> => {
      if (policy === "read") {
        readPayload = await doRead(tool, rec, scope);
        return;
      }
      // Mutating tools: produce a WriteEnvelope. A `planned`/`applied`/
      // `pending_approval` is a SUCCESS for the audit (the call was honoured);
      // an `error` envelope means the action failed — we throw so the 4.2
      // spine records result:"error" (then we convert the thrown error to the
      // envelope below).
      let env: WriteEnvelope;
      switch (tool) {
        case "provision_server":
          env = await doProvisionServer(rec, scope, actorFrom(credential));
          break;
        case "deploy_service":
          env = await doDeployService(rec, scope, actorFrom(credential));
          break;
        case "scale_service":
          env = await doScaleService(rec, scope, actorFrom(credential));
          break;
        case "set_dns":
          env = await doSetDns(rec, scope, actorFrom(credential));
          break;
        case "apply_manifest":
          env = await doApplyManifest(rec, scope, actorFrom(credential));
          break;
        case "snapshot":
          env = await doGatedOp(
            "snapshot",
            str(rec.target) || "backup:unknown",
            scope,
            actorFrom(credential),
            false, // none policy
            rec.dry_run === true,
          );
          break;
        case "restore":
          env = await doGatedOp(
            "restore",
            str(rec.target) || "backup:unknown",
            scope,
            actorFrom(credential),
            true, // always policy
            rec.dry_run === true,
          );
          break;
        case "destroy":
          env = await doGatedOp(
            "destroy",
            str(rec.entity) || `${scope}:unknown`,
            scope,
            actorFrom(credential),
            true, // always policy
            rec.dry_run === true,
          );
          break;
        default:
          throw new ReconcileError(
            "fatal",
            `tool "${tool}" has no handler`,
            { entity: "agent" },
          );
      }
      if (env.status === "error") {
        // Make the 4.2 spine audit this as result:"error"; the original
        // ReconcileError (if any) is preserved by re-throwing a typed error.
        throw new ReconcileError(
          (env.error?.code as ReconcileError["errorClass"]) ?? "fatal",
          env.error?.message ?? "tool action failed",
          { entity: env.error?.entity ?? "agent" },
        );
      }
      writeEnvelope = env;
    };

    try {
      await authorizeAndRecord(
        pool,
        credential,
        tool,
        {
          op: tool,
          entity: auditEntity,
          result: "ok",
        },
        action,
      );
    } catch (err) {
      // Covers BOTH: (a) deny-before-write (assertCapability threw fatal — NO
      // event written, per 4.2) and (b) an authorized-but-failed action (4.2
      // already audited result:"error" and re-threw). Either way the caller
      // gets a contract `error()` envelope; secrets never leak (toErrorEnvelope
      // emits only the ReconcileError's safe class/message).
      return toErrorEnvelope(err);
    }

    if (policy === "read") {
      return { status: "ok", data: readPayload };
    }
    // writeEnvelope is set for every non-error mutating path above.
    return writeEnvelope as WriteEnvelope;
  }

  /**
   * CORE-INTERNAL promote (Task 4.8). NOT routed through `executeTool`/the
   * 12-tool dispatch (it is not a `ToolName`), but it STILL goes through the
   * SAME 4.2 authz spine (`authorizeAndRecord`) so it is deny-before-write +
   * audited on both outcomes exactly like the 12. Authz reuses the agent's
   * `apply_manifest` capability — promote IS the git-side of manifest
   * application, so no new capability vocabulary is minted (the FROZEN
   * `ALL_TOOLS`/12-tool surface and the 4.6 contract oracle are untouched).
   */
  async function promoteManifest(
    params: PromoteParams,
    ctx: ToolContext,
  ): Promise<WriteEnvelope> {
    const { credential, scope } = ctx;
    let env: WriteEnvelope | undefined;
    const action = async (): Promise<void> => {
      const e = await doPromote(params, scope, actorFrom(credential));
      if (e.status === "error") {
        throw new ReconcileError(
          (e.error?.code as ReconcileError["errorClass"]) ?? "fatal",
          e.error?.message ?? "promote failed",
          { entity: e.error?.entity ?? "manifest" },
        );
      }
      env = e;
    };
    try {
      await authorizeAndRecord(
        pool,
        credential,
        // Reuse the existing apply_manifest capability (a real ToolName) —
        // deny-before-write + audited. No new vocabulary, no contract change.
        "apply_manifest",
        { op: "promote_manifest", entity: "manifest:promote", result: "ok" },
        action,
      );
    } catch (err) {
      return toErrorEnvelope(err);
    }
    return env as WriteEnvelope;
  }

  /**
   * v2 read-only resolution — Task 0.4. Pure read: authn is the CALLER's
   * responsibility (REST/MCP both authn-gate BEFORE invoking this method,
   * same deny-before-write discipline as every other read). No catalog
   * audit/StateEvent: the read carries operational metadata only (server
   * names + labels — no secret material by construction).
   */
  async function resolveSelector(
    selector: SelectorInput,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const state = await observedReader(ctx.scope);
      const matched = resolveServerSelector(selector, state.servers);
      return { status: "ok", data: { matched } };
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }

  return { executeTool, promoteManifest, resolveSelector };
}

/**
 * Read the audit actor from the verified credential WITHOUT exposing the
 * capability brand. capability.ts owns `actorOf` (brand-guarded, fails closed
 * on a forged credential); we re-derive via the 4.2 re-export to avoid a
 * second brand reader. authorizeAndRecord also derives the actor internally
 * for the audit row — this local copy is ONLY for the per-tool desired-state
 * key/scope; it is consistent because it comes from the same accessor. A
 * forged credential never reaches here: authorizeAndRecord's deny-before-write
 * rejects it first.
 */
function actorFrom(cred: VerifiedCredential): string {
  return actorOf(cred);
}
