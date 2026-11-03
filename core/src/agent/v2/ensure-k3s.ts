/**
 * core/src/agent/v2/ensure-k3s.ts
 *
 * `ensure_k3s` (v2 write tool) — Bloco E Task 23, the Phase-2 production
 * capstone (host axis).
 *
 * Single `ensureK3s(input, ctx, deps)` function shared by both the REST
 * `POST /api/v2/k3s/ensure` route and the MCP `ensure_k3s` tool call (single
 * source of truth across transports).
 *
 * Template: `kubectl-apply.ts` (Task 14, which itself mirrors `run-migrations.ts`
 * — the DIRECT-drive v2-tool shape: it does NOT route through the reconciler
 * composite; it drives its provider/seam directly behind the always-sensitive
 * Approval Gate). The shape, step-by-step:
 *
 *   (1) DENY-BEFORE-WRITE. Assert the `ensure_k3s` v2 capability FIRST. An
 *       out-of-scope call short-circuits the entire path: no parse, no host
 *       resolution, no gate, no apply, no StateEvent.
 *   (2) Input parse via the FROZEN `EnsureK3sSchema` (host/version/role;
 *       `.strict()` rejects any free-exec field — D7). VALUE-FREE precondition
 *       error (the message never echoes the input values).
 *   (3) Q-c HOST RESOLUTION. The named `host` is resolved to a SERVER-SIDE
 *       SSH/provider config via `deps.resolveHost` — the SSH key / connection
 *       config is NEVER present in the tool input (the input carries ONLY the
 *       named ref).
 *   (4) ALWAYS-SENSITIVE Approval Gate. Synthesise ONE PlanItem(op="create") and
 *       route it through the SAME `ReconcileGate.evaluate()` the v1 catalog uses.
 *       Sensitivity is the CALLER's wiring contract (`makeGate(() => true)`); the
 *       tool never decides sensitivity. A denial ⇒ `pending_approval` envelope;
 *       an approval ⇒ proceed to apply.
 *   (5) APPLY. Drive `EnsureK3sProvider.apply(desired, observed)` directly. NOTE
 *       (vs kubectl_apply): EnsureK3s.apply takes NO `ApplyContext` — the install
 *       recipe resolves no secret, so there is no per-call apply token to mint;
 *       there is ALSO no namespace precondition (that was kube-specific, Q-d).
 *       The actor is sourced from the verified credential (state-event-actor.md).
 *
 * The provider apply is INSTALL-ONLY (fail-safe.md / D7): k3s absent ⇒ install
 * (`changed:true`); present at the same version ⇒ no-op (`changed:false`);
 * present at a DIFFERENT version ⇒ DRIFT (`changed:false`, `result:"drift"` —
 * Q-a: NEVER auto-upgrade). The drift outcome is a CONVERGENCE DECISION, NOT a
 * transport failure, so it surfaces as `status:"applied"` with the op carrying
 * `result:"drift"` (value-free — the divergent versions are NOT copied).
 *
 * NO THROW — every failure (authz, parse, host, gate, apply) becomes a
 * contract-shaped v2 error/pending envelope. EnsureK3s carries no secret
 * material (the typed recipe has no secret:<ref> tokens), so this tool resolves
 * nothing and leaks nothing.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 23)
 */

import {
  assertV2Capability,
  type VerifiedCredential,
} from "../capability.js";
import { actorOf } from "../auth.js";
import {
  buildV2WriteEnvelope,
  type WriteEnvelopeV2,
} from "./envelope-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import { EnsureK3sSchema } from "../../domain/entities-v2.js";
import type { EnsureK3s } from "../../domain/entities-v2.js";
import {
  k3sIdentityKey,
  type EnsureK3sProvider,
} from "../../providers/v2/ensure-k3s.js";
import type { PlanItem } from "../../domain/entities.js";
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

/** The tool input — the FROZEN `EnsureK3s` recipe (re-exported for callers). */
export type { EnsureK3s as EnsureK3sInput } from "../../domain/entities-v2.js";

/** Per-call context the caller (REST/MCP) supplies. */
export interface EnsureK3sCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope the tool acts on (callers default to "server"). */
  readonly scope: string;
}

/**
 * The SERVER-SIDE resolved host config for a named `host` ref (Q-c).
 *
 * Opaque-by-design at this layer: the tool NEVER reads SSH key / connection
 * material off it — it only hands the resolved config back to
 * `deps.getEnsureK3sProvider`. The credential/key is resolved SERVER-SIDE and is
 * NEVER present in the tool input. Carries the (non-secret) host identifier for
 * observability. Structurally identical to `kubectl_apply`'s `KubeHostConfig`.
 */
export interface EnsureK3sHostConfig {
  /** The (non-secret) host identifier the named ref resolved to. */
  readonly host: string;
}

/**
 * Injected dependencies (deps seam — tests inject fakes; production wired in
 * Task 23). Mirrors `KubectlApplyDeps` MINUS the kube-specific seams: there is
 * NO `namespaceExists` (no Q-d precondition for a host recipe) and NO
 * `makeApplyContext` (EnsureK3s.apply takes no ApplyContext — it resolves no
 * secret). Do NOT wire real buildBootDeps here.
 */
export interface EnsureK3sToolDeps {
  /**
   * Q-c — resolve the input's named `host` to a SERVER-SIDE config. The SSH key
   * / connection config is resolved here, SERVER-SIDE; it is NEVER present in the
   * tool input. A throw ⇒ surfaced as a contract error envelope (no apply). The
   * non-secret host identifier is the only thing that flows.
   */
  readonly resolveHost: (host: string) => Promise<EnsureK3sHostConfig>;
  /**
   * Obtain the `EnsureK3sProvider` (over the resolved host's `KubeTransport`)
   * the apply step drives directly. Separated from `resolveHost` so production
   * can cache/construct the transport per host without leaking it into the
   * resolver's return shape.
   */
  readonly getEnsureK3sProvider: (cfg: EnsureK3sHostConfig) => EnsureK3sProvider;
  /**
   * Approval Gate strategy. `ensure_k3s` is ALWAYS sensitive — installing k3s on
   * a live host is a destructive-by-category host mutation. The CALLER wires this
   * seam, typically with `makeGate(() => true)` so every invocation routes
   * through the real Fase-4 approval gate. The tool never makes a sensitivity
   * decision; it only consults `evaluate()` and follows the decision.
   */
  readonly approvalGate: ReconcileGate;
  /**
   * StateEvent append seam (Task 25, ground rule #5). The tool emits ONE
   * StateEvent on the SUCCESSFUL apply path (post-gate, after the provider
   * apply returns) — mirrors `kubectl-apply.ts` / `set-firewall.ts` /
   * `run-migrations.ts`. The `actor` is sourced from the verified credential
   * (state-event-actor.md). The `after` payload is SECRET-FREE and VALUE-FREE:
   * identity + the install outcome (`changed`, plus the value-free
   * `result:"drift"` marker on version-divergence — Q-a). EnsureK3s carries no
   * secret material, and the divergent version strings are NEVER copied into
   * the payload (do NOT leak versions — mirror the value-free drift
   * representation the provider exposes).
   *
   * Optional in the deps shape so the in-memory unit tests (deny/pending/parse
   * paths) can omit it; when omitted, the tool does NOT emit a StateEvent
   * (production callers MUST wire this). The deny/pending/precondition/parse
   * paths emit NOTHING regardless.
   *
   * The `pool` first arg is the pg Pool/PoolClient passed through to the
   * underlying `appendEvent` in `core/src/store/state-events.ts`; typed as
   * `unknown` here to keep the tool free of a hard `pg` dependency. Same shape
   * as `RunMigrationsDeps.appendEvent`.
   */
  readonly appendEvent?: (
    pool: unknown,
    event: {
      readonly actor: string;
      readonly scope: string;
      readonly entity: string;
      readonly op: "create";
      readonly result: "applied";
      readonly after?: Record<string, unknown>;
    },
  ) => Promise<void>;
  /**
   * pg Pool/PoolClient threaded into `appendEvent`. Optional alongside
   * `appendEvent` itself — the tool passes whatever the caller provides
   * (production: the real Postgres pool; tests: a pg-harness pool / fake).
   */
  readonly pool?: unknown;
}

// ---------------------------------------------------------------------------
// ensureK3s — the single dispatch
// ---------------------------------------------------------------------------

/**
 * Execute the `ensure_k3s` tool. NEVER throws — every failure (authz, parse,
 * host, gate, apply) is captured into a contract-shaped v2 envelope. Returns
 * `WriteEnvelopeV2`.
 */
export async function ensureK3s(
  input: unknown,
  ctx: EnsureK3sCtx,
  deps: EnsureK3sToolDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE. Out-of-scope / forged credential short-circuits the
  // entire path BEFORE any parse / host resolution / write — no StateEvent, no
  // approval row, no apply.
  try {
    assertV2Capability(ctx.credential, "ensure_k3s");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse the input through the FROZEN `EnsureK3sSchema`. VALUE-FREE error
  // message: the precondition envelope must NOT echo any input value (uniform
  // with the rest of the v2 surface even though EnsureK3s carries no secret).
  // `.strict()` rejects any unknown free-exec key (`command`/`script`/…) — D7.
  let recipe: EnsureK3s;
  try {
    recipe = EnsureK3sSchema.parse(input);
  } catch {
    return toErrorEnvelope(
      new ReconcileError("precondition", "invalid ensure_k3s input", {
        entity: "k3s",
      }),
    );
  }

  const entity = k3sIdentityKey(recipe);

  // (3) Q-c HOST RESOLUTION. The named `host` resolves to a SERVER-SIDE config;
  // the SSH key / connection config is NEVER in the tool input. A throw becomes
  // a contract error envelope (no apply).
  let hostConfig: EnsureK3sHostConfig;
  try {
    hostConfig = await deps.resolveHost(recipe.host);
  } catch {
    return toErrorEnvelope(
      new ReconcileError("precondition", "ensure_k3s: host not found", {
        entity,
      }),
    );
  }

  // (4) ALWAYS-SENSITIVE Approval Gate. Synthesise ONE PlanItem(op="create",
  // entity=k3sIdentityKey) and route it through the SAME `ReconcileGate` the v1
  // catalog uses. Sensitivity is the CALLER's wiring contract
  // (`makeGate(() => true)`). On any denial we surface the gate's pending
  // approval id; NOTHING is applied (fail-safe — a pending approval ⇒ NO
  // mutation). The actor is sourced from the verified credential.
  const actor = actorOf(ctx.credential);
  const item: PlanItem = {
    op: "create",
    entity,
    change: `ensure k3s ${entity}`,
    impact: "installs k3s on a live host — approval required",
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
        (p) => p.entity === entity && p.op === "create",
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

  // (5) APPLY. Drive `EnsureK3sProvider.apply(desired, observed)` directly.
  // NOTE (vs kubectl_apply): apply takes NO `ApplyContext` — the install recipe
  // resolves no secret. INSTALL-ONLY / fail-safe: a failed apply leaves host
  // state in place — we NEVER uninstall/destroy on an error path. A
  // version-divergence DRIFT (`result:"drift"`) is a convergence decision (Q-a:
  // NEVER auto-upgrade), NOT a transport failure, so it surfaces as
  // `status:"applied"` with the op carrying `result:"drift"` (value-free). We
  // wrap any provider error so nothing can leak into the envelope.
  const provider = deps.getEnsureK3sProvider(hostConfig);
  try {
    const observed = await provider.observe(recipe);
    const result = await provider.apply(recipe, observed);
    // (6) STATE EVENT (Task 25, ground rule #5). One StateEvent per converging
    // host mutation — actor sourced from the verified credential (NEVER
    // synthesised); entity = `k3s:<host>`. The `after` payload is SECRET-FREE
    // and VALUE-FREE: the install outcome only (`changed`, plus the value-free
    // `result:"drift"` marker on version-divergence — Q-a). The divergent
    // version strings are NEVER copied (do NOT leak versions / do NOT set
    // changed:true on a drift — mirror the provider's value-free drift). Emitted
    // ONLY on the successful apply path — the deny/pending/precondition/parse
    // paths above all return before reaching here, so they emit NOTHING
    // (fail-safe, mirrors set-firewall.ts). Optional seam: unwired in-memory
    // unit tests still succeed; production wires the real pool/appendEvent.
    if (deps.appendEvent !== undefined) {
      await deps.appendEvent(deps.pool ?? null, {
        actor,
        scope: ctx.scope,
        op: "create",
        entity,
        result: "applied",
        after: {
          k3s: entity,
          changed: result.changed,
          ...(result.result !== undefined ? { result: result.result } : {}),
          capability_token_id: null,
        },
      });
    }
    return buildV2WriteEnvelope({
      status: "applied",
      plan: {
        ops: [
          {
            op: "create",
            entity,
            changed: result.changed,
            // Surface the value-free drift discriminator ONLY when the provider
            // reported version-divergence (Q-a). Absent on a converged no-op or
            // a fresh install so consumers can tell the three apart.
            ...(result.result !== undefined ? { result: result.result } : {}),
          },
        ],
      },
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
}

// ---------------------------------------------------------------------------
// Internal: error envelope (no-leak)
// ---------------------------------------------------------------------------

/**
 * Map any failure to a contract-shaped v2 error envelope. A `ReconcileError`
 * surfaces its class/message verbatim (those are secret-free by construction —
 * the provider/transport already scrub their messages). Anything else collapses
 * to a generic `fatal` so an upstream error body can never leak a value.
 */
function toErrorEnvelope(err: unknown): WriteEnvelopeV2 {
  if (err instanceof ReconcileError) {
    return buildV2WriteEnvelope({
      status: "error",
      error: err.toApiError(),
    });
  }
  return buildV2WriteEnvelope({
    status: "error",
    error: new ReconcileError("fatal", "ensure_k3s failed", {
      entity: "k3s",
    }).toApiError(),
  });
}
