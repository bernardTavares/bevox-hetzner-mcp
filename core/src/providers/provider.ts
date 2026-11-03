/**
 * core/src/providers/provider.ts
 *
 * The Provider port and its idempotency conformance harness.
 *
 * A Provider is the seam between the reconciler and a concrete backend
 * (HetznerCloud, HetznerDNS, Docker, WireGuard, Backup/restic — Fase 2/3/5).
 * Every concrete provider implements the SAME three-method contract so the
 * reconciler stays provider-agnostic.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; YAGNI):
 *
 *   - IDEMPOTENCY IS THE CENTRAL INVARIANT. apply(action) MUST converge
 *     reality toward `action.desired` and then be a NO-OP: once verify(action)
 *     returns true, a subsequent apply(action) MUST NOT perform another write
 *     and MUST report `changed:false`. The reconciler relies on this to apply
 *     a plan repeatedly without divergence or duplicate side-effects.
 *
 *   - FAIL-SAFE. Nothing in this port performs, implies, or rewards
 *     destructive / auto-delete behaviour. `op` carries the plan's intent
 *     (aligned with the frozen console PlanOp vocabulary); a provider acts
 *     only on the explicit action it is handed — it never deletes a resource
 *     it was not asked to.
 *
 *   - MINIMAL SURFACE. Only the port, the three supporting types it needs,
 *     and the conformance harness are exported. No concrete provider, no
 *     HTTP, no DB — those are later tasks (2.2–2.9, Fase 3, Fase 5).
 *
 * Exported API:
 *   interface Provider                       — the port
 *   type PlanAction / ApplyResult / ObservedSlice — supporting shapes
 *   conformanceHarness(makeProvider, action, scope?) — reusable idempotency assertion
 *     (imported & reused by every concrete provider test in 2.4 / Fase 3)
 */

import { ReconcileError } from "../domain/errors.js";
import type { ApplyContext as SecretApplyContext } from "../store/secrets.js";

// ---------------------------------------------------------------------------
// Supporting types — minimal, aligned with the frozen console contract
// (PlanOp vocabulary) and the (scope, entity) key convention used by
// core/src/store/observed-store.ts. Kept intentionally narrow (YAGNI):
// only what the port + 2.1 harness need. 2.4–2.9 consume these as-is.
// ---------------------------------------------------------------------------

/**
 * The intent of a plan action. Mirrors the FROZEN console PlanOp enum
 * (console/src/api/contract.ts) by value — core conforms to it; we do not
 * import the console package (same boundary rule as errors.ts) and do not
 * invent divergent names. Kept as a string-literal union (not a Zod schema):
 * the canonical PlanOpEnum/PlanItemSchema is introduced by its owning task
 * (2.5) per entities.ts §"Intentionally NOT defined here".
 */
export type PlanOp =
  | "create"
  | "add"
  | "update"
  | "scale"
  | "drift"
  | "remove"
  | "destroy"
  | "noop"
  | "upsert"
  | "snapshot"
  | "restore";

/**
 * A single unit of work for a provider: the operation intent, the entity key
 * it targets (the same `"<kind>:<name>"` convention used across the store
 * layer, e.g. "server:app-1"), and the desired entity payload.
 *
 * `desired` is `unknown` here on purpose — the concrete entity type is
 * narrowed by each provider (against entities.ts schemas) in its own task.
 * 2.1 must not over-specify it (YAGNI).
 *
 * The reconciler derives the `observe()` scope from an action's `entity`:
 * scope is the `<kind>` prefix of the `"<kind>:<name>"` key (the `kind:`
 * partition, exactly as `state-store-helper.ts` routes rows by
 * `startsWith("kind:")`).
 */
export interface PlanAction {
  readonly op: PlanOp;
  readonly entity: string;
  readonly desired: unknown;
  /**
   * 3.3 APPLY-ONLY SECRET CAPABILITY (OPTIONAL — additive, backward-compat).
   *
   * The unforgeable secrets.ts `ApplyContext` token, present ONLY on actions
   * built by the real apply boundary (applyPlan) when secret resolution is
   * enabled. A secret-aware provider (DockerProvider) uses it to pass
   * secrets.ts's gate and resolve `secret:<ref>` env bindings AT APPLY.
   *
   * SECURITY INVARIANT: this is `undefined` on every plan/dry_run/observe/
   * verify path — those code paths never mint it (only the apply step does),
   * so they are STRUCTURALLY unable to resolve a secret value. It carries NO
   * secret material (it is an opaque capability brand).
   */
  readonly applyContext?: SecretApplyContext;
}

/**
 * The outcome of a single apply(). `changed` is the idempotency signal:
 * true  ⇒ this call mutated reality;
 * false ⇒ reality already matched desired, NO write was performed (no-op).
 */
export interface ApplyResult {
  readonly entity: string;
  readonly op: PlanOp;
  readonly changed: boolean;
  /**
   * OPTIONAL (additive, backward-compat). Provider-surfaced StateEvents the
   * reconciler's Record step persists — each with the CYCLE actor + scope (the
   * provider has neither). Use for outcomes that are not the apply item itself,
   * e.g. wait-for-healthy `service.wait_skipped` / `service.dep_health_timeout`
   * (spec 2026-05-28-manifest-schema-gaps.md rev b §1.5/§3). Absent ⇒ behaviour
   * is exactly as before; `conformanceHarness` is unaffected.
   */
  readonly events?: ReadonlyArray<{
    readonly op: string;
    readonly after?: Record<string, unknown>;
  }>;
}

/**
 * One observed entity: its `${kind}:${name}` key plus the raw observed object.
 * The `payload` is `unknown` ON PURPOSE — the observed-state adapter validates
 * it through the `entities.ts` Zod schemas (never an `as` on a wire-ish value).
 * Spec 2026-06-02-observed-state-adapter §1.1 (Q1).
 */
export interface ObservedEntity {
  /** The `${kind}:${name}` key, same convention as observed-store.ts. */
  readonly key: string;
  /** The observed object; validated by the adapter against entities.ts. */
  readonly payload: unknown;
}

/**
 * The slice of observed reality a provider can see for one `scope`.
 * `scope` and the entity keys follow the (scope, entity) convention of
 * observed-store.ts. Each entry now carries a validatable `payload` so the
 * observed-state adapter can build a typed `State` (get_state/diff reflect
 * reality); the key survives for the per-entity reconcile via verify().
 */
export interface ObservedSlice {
  readonly scope: string;
  readonly entities: ReadonlyArray<ObservedEntity>;
}

// ---------------------------------------------------------------------------
// Provider — the port every concrete backend implements
// ---------------------------------------------------------------------------

/**
 * A backend adapter the reconciler drives. All three methods are async and
 * side-effect-honest:
 *
 *   observe(scope)  — read-only; return what the backend currently has.
 *   apply(action)   — converge reality toward action.desired. MUST be
 *                     IDEMPOTENT: if verify(action) is already true, this is
 *                     a no-op returning { changed:false }.
 *   verify(action)  — read-only; true iff reality matches action.desired.
 *
 * `name` identifies the provider in StateEvents / health output.
 */
export interface Provider {
  readonly name: string;
  observe(scope: string): Promise<ObservedSlice>;
  /** MUST be idempotent — see module + ApplyResult docs. */
  apply(action: PlanAction): Promise<ApplyResult>;
  /** Read-only. true ⇒ reality matches action.desired. */
  verify(action: PlanAction): Promise<boolean>;
  /**
   * OPTIONAL approved-destroy execution (additive). The reconcile path NEVER
   * deletes (apply(op:"destroy") is a no-op; orphans are drift-only) — this is
   * the SANCTIONED destructive path of `.claude/rules/fail-safe.md`
   * §"Approval Gate gates destruction": invoked ONLY by the catalog's gated
   * destroy handler AFTER the Approval Gate approves the explicit request.
   * Idempotent: an already-absent resource ⇒ `changed:false`. Providers that
   * do not implement it leave the gated op a recorded no-op (back-compat).
   */
  destroy?(action: PlanAction): Promise<ApplyResult>;
}

// ---------------------------------------------------------------------------
// conformanceHarness — the reusable idempotency contract assertion
// ---------------------------------------------------------------------------

/**
 * Assert that `makeProvider()` produces a provider honouring the idempotency
 * contract for `action`:
 *
 *   1. first apply(action)  ⇒ converges (changed:true) ...
 *   2. verify(action)       ⇒ true (reality now matches desired)
 *   3. second apply(action) ⇒ NO-OP: MUST return changed:false
 *      (a non-idempotent provider writes again / returns changed:true here
 *       and is REJECTED — the harness has teeth)
 *   4. verify(action)       ⇒ still true (no-op did not regress reality)
 *
 * A fresh provider per call keeps the assertion deterministic and isolated.
 * Reused by every concrete provider test (2.4, Fase 3) — keep this minimal
 * and provider-agnostic. Throws ReconcileError("conflict") on violation:
 * an idempotency breach is observed reality diverging from contract.
 *
 * When `scope` is supplied, the harness additionally asserts observe() teeth:
 * after the converging applies, observe(scope) MUST report the converged
 * entity. This catches a provider that writes but never surfaces the entity
 * through observe() (e.g. wrongly reports changed:false / forgets to record).
 * Omitting `scope` skips this assertion (backward compatible).
 */
export async function conformanceHarness(
  makeProvider: () => Provider,
  action: PlanAction,
  scope?: string,
): Promise<void> {
  const provider = makeProvider();

  const first = await provider.apply(action);
  if (first.changed !== true) {
    throw new ReconcileError(
      "conflict",
      `conformanceHarness[${provider.name}]: first apply() must converge ` +
        `(expected changed:true, got changed:${first.changed})`,
      { entity: action.entity },
    );
  }

  if ((await provider.verify(action)) !== true) {
    throw new ReconcileError(
      "conflict",
      `conformanceHarness[${provider.name}]: verify() must be true after ` +
        `a converging apply()`,
      { entity: action.entity },
    );
  }

  const second = await provider.apply(action);
  if (second.changed !== false) {
    throw new ReconcileError(
      "conflict",
      `conformanceHarness[${provider.name}]: second apply() must be a NO-OP ` +
        `once verify() is satisfied (expected changed:false, got ` +
        `changed:${second.changed}) — provider is NOT idempotent`,
      { entity: action.entity },
    );
  }

  if ((await provider.verify(action)) !== true) {
    throw new ReconcileError(
      "conflict",
      `conformanceHarness[${provider.name}]: verify() must remain true after ` +
        `the no-op second apply()`,
      { entity: action.entity },
    );
  }

  if (scope !== undefined) {
    const obs = await provider.observe(scope);
    if (!obs.entities.some((e) => e.key === action.entity)) {
      throw new ReconcileError(
        "conflict",
        `conformanceHarness[${provider.name}]: observe(${scope}) must report ` +
          `the converged entity (expected entities to include ` +
          `"${action.entity}") — provider wrote but does not surface it`,
        { entity: action.entity },
      );
    }
  }
}
