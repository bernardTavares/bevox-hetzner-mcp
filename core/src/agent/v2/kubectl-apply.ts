/**
 * core/src/agent/v2/kubectl-apply.ts
 *
 * `kubectl_apply` (v2 write tool) — Bloco E Task 14, the Phase-1 capstone.
 *
 * Single `kubectlApply(input, ctx, deps)` function shared by both the REST
 * `POST /api/v2/kube/apply` route and the MCP `kubectl_apply` tool call
 * (single source of truth across transports).
 *
 * Template: `run-migrations.ts` (the DIRECT-drive v2-tool shape — it does NOT
 * route through the reconciler composite; it drives its provider/seam directly
 * behind the always-sensitive Approval Gate). The shape, step-by-step:
 *
 *   (1) DENY-BEFORE-WRITE. Assert the `kubectl_apply` v2 capability FIRST. An
 *       out-of-scope call short-circuits the entire path: no parse, no host
 *       resolution, no namespace precondition, no gate, no apply, no StateEvent.
 *   (2) Input parse via the FROZEN `KubeManifestSchema`. VALUE-FREE precondition
 *       error (the message never echoes the manifest body / names).
 *   (3) Q-c HOST RESOLUTION. The manifest's named `host` is resolved to a
 *       SERVER-SIDE SSH/provider config via `deps.resolveHost` — the SSH key /
 *       connection config is NEVER present in the tool input (the input carries
 *       ONLY the named ref).
 *   (4) Q-d NAMESPACE PRECONDITION (BEFORE the gate). The target namespace MUST
 *       already exist — a missing namespace is a precondition error and the
 *       namespace is NEVER created. Checked BEFORE the always-sensitive gate so a
 *       pending_approval path NEVER touches the cluster.
 *   (5) ALWAYS-SENSITIVE Approval Gate. Synthesise ONE PlanItem(op="create") and
 *       route it through the SAME `ReconcileGate.evaluate()` the v1 catalog uses.
 *       Sensitivity is the CALLER's wiring contract (`makeGate(() => true)`); the
 *       tool never decides sensitivity. A denial ⇒ `pending_approval` envelope;
 *       an approval ⇒ proceed to apply.
 *   (6) APPLY. Drive `KubernetesProvider.apply(desired, observed, ctx)` behind a
 *       per-call `ApplyContext` (minted by `deps.makeApplyContext`). The actor is
 *       sourced from the verified credential (state-event-actor.md).
 *
 * NO THROW — every failure (authz, parse, host, precondition, gate, apply)
 * becomes a contract-shaped v2 error/pending envelope. Secrets never appear in
 * the envelope / log / error: the manifest `body` may carry `secret:<ref>`
 * tokens, resolved ONLY inside the provider's apply() behind `ApplyContext`
 * (ground rule #4 / secrets-resolution.md) — this tool never resolves a value.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 14)
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
import { KubeManifestSchema } from "../../domain/entities-v2.js";
import type { KubeManifest } from "../../domain/entities-v2.js";
import { kubeIdentityKey, manifestHash } from "../../providers/v2/kube-apply.js";
import type { KubernetesProvider } from "../../providers/v2/kube-apply.js";
import type { ApplyContext } from "../../store/secrets.js";
import type { PlanItem } from "../../domain/entities.js";
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

/** The tool input — the FROZEN `KubeManifest` envelope (re-exported for callers). */
export type { KubeManifest as KubectlApplyInput } from "../../domain/entities-v2.js";

/** Per-call context the caller (REST/MCP) supplies. */
export interface KubectlApplyCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope the tool acts on (callers default to "service"). */
  readonly scope: string;
}

/**
 * The SERVER-SIDE resolved host config for a named `host` ref (Q-c).
 *
 * Opaque-by-design at this layer: the tool NEVER reads SSH key / connection
 * material off it — it only hands the resolved config back to `deps.getProvider`
 * / `deps.namespaceExists`. The credential/key is resolved SERVER-SIDE and is
 * NEVER present in the tool input. Carries the (non-secret) host identifier for
 * observability; concrete SSH fields are wired by Tasks 21/23 (production).
 */
export interface KubeHostConfig {
  /** The (non-secret) host identifier the named ref resolved to. */
  readonly host: string;
}

/**
 * Injected dependencies (deps seam — tests inject fakes; production wired in
 * Tasks 21/23). Mirrors `RunMigrationsDeps`: the approval gate, a HOST-CONFIG
 * RESOLVER seam (Q-c), a namespace-precondition reader (Q-d), the per-call
 * ApplyContext mint, and a way to obtain the `KubernetesProvider` for a
 * resolved host. Do NOT wire real buildBootDeps here.
 */
export interface KubectlApplyDeps {
  /**
   * Q-c — resolve the manifest's named `host` to a SERVER-SIDE config. The
   * SSH key / connection config is resolved here, SERVER-SIDE; it is NEVER
   * present in the tool input. A throw ⇒ surfaced as a contract error envelope
   * (no apply). The non-secret host identifier is the only thing that flows.
   */
  readonly resolveHost: (host: string) => Promise<KubeHostConfig>;
  /**
   * Obtain the `KubernetesProvider` (over the resolved host's `KubeTransport`)
   * the apply step drives directly. Separated from `resolveHost` so production
   * can cache/construct the transport per host without leaking it into the
   * resolver's return shape.
   */
  readonly getProvider: (cfg: KubeHostConfig) => KubernetesProvider;
  /**
   * Q-d — namespace precondition reader. Returns `true` iff the target
   * namespace EXISTS on the resolved host (e.g. `kubectl get namespace <ns>`).
   * Read-only: the tool NEVER creates a namespace (fail-safe). A missing
   * namespace ⇒ precondition error BEFORE the gate.
   */
  readonly namespaceExists: (
    cfg: KubeHostConfig,
    namespace: string,
  ) => Promise<boolean>;
  /**
   * Approval Gate strategy. `kubectl_apply` is ALWAYS sensitive — applying a
   * manifest to a live cluster is destructive by category. The CALLER wires
   * this seam, typically with `makeGate(() => true)` so every invocation routes
   * through the real Fase-4 approval gate. The tool never makes a sensitivity
   * decision; it only consults `evaluate()` and follows the decision.
   */
  readonly approvalGate: ReconcileGate;
  /**
   * Mint the per-call apply-only `ApplyContext` (secrets.ts
   * `createApplyContext()`). Forwarded into `provider.apply(...)` so the
   * provider can resolve `secret:<ref>` tokens ONLY at apply, behind the
   * unforgeable gate. Plan/dry-run paths never mint one. The tool obtains it
   * ONLY after the gate approves.
   */
  readonly makeApplyContext: () => ApplyContext;
  /**
   * StateEvent append seam (Task 25, ground rule #5). The tool emits ONE
   * StateEvent on the SUCCESSFUL apply path (post-gate, after the provider
   * apply returns) — mirrors `set-firewall.ts` / `run-migrations.ts`. The
   * `actor` is sourced from the verified credential (state-event-actor.md);
   * the `after` payload is SECRET-FREE (identity + manifest-hash — NEVER the
   * manifest body, NEVER a resolved secret — mirrors observe's minimal
   * projection / secrets-resolution.md).
   *
   * Optional in the deps shape so the in-memory unit tests (deny/pending/
   * parse paths, which never reach apply) can omit it; when omitted, the tool
   * does NOT emit a StateEvent (production callers MUST wire this). The deny/
   * pending/precondition/parse paths emit NOTHING regardless.
   *
   * The `pool` first arg is the pg Pool/PoolClient passed through to the
   * underlying `appendEvent` in `core/src/store/state-events.ts`; typed as
   * `unknown` here to keep the tool free of a hard `pg` dependency (the caller
   * wires the real pool). Same shape as `RunMigrationsDeps.appendEvent`.
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
// kubectlApply — the single dispatch
// ---------------------------------------------------------------------------

/**
 * Execute the `kubectl_apply` tool. NEVER throws — every failure (authz, parse,
 * host, precondition, gate, apply) is captured into a contract-shaped v2
 * envelope. Returns `WriteEnvelopeV2`.
 */
export async function kubectlApply(
  input: unknown,
  ctx: KubectlApplyCtx,
  deps: KubectlApplyDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE. Out-of-scope / forged credential short-circuits the
  // entire path BEFORE any parse / host resolution / precondition / write — no
  // StateEvent, no approval row, no apply.
  try {
    assertV2Capability(ctx.credential, "kubectl_apply");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse the input through the FROZEN `KubeManifestSchema`. VALUE-FREE
  // error message: the precondition envelope must NOT echo any manifest value
  // (ground rule I4 — the body may carry `secret:<ref>` tokens).
  let manifest: KubeManifest;
  try {
    manifest = KubeManifestSchema.parse(input);
  } catch {
    return toErrorEnvelope(
      new ReconcileError("precondition", "invalid kubectl_apply input", {
        entity: "kube",
      }),
    );
  }

  const entity = kubeIdentityKey(manifest);

  // (3) Q-c HOST RESOLUTION. The named `host` resolves to a SERVER-SIDE config;
  // the SSH key / connection config is NEVER in the tool input. A throw becomes
  // a contract error envelope (no apply).
  let hostConfig: KubeHostConfig;
  try {
    hostConfig = await deps.resolveHost(manifest.host);
  } catch {
    return toErrorEnvelope(
      new ReconcileError("precondition", "kubectl_apply: host not found", {
        entity,
      }),
    );
  }

  // (4) Q-d NAMESPACE PRECONDITION — BEFORE the gate. The target namespace MUST
  // exist; a missing namespace is a precondition error and is NEVER created
  // (fail-safe). Checked here, before the always-sensitive gate, so a
  // pending_approval path NEVER touches the cluster.
  let nsExists: boolean;
  try {
    nsExists = await deps.namespaceExists(hostConfig, manifest.namespace);
  } catch (err) {
    return toErrorEnvelope(err);
  }
  if (!nsExists) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        "kubectl_apply: target namespace does not exist",
        { entity },
      ),
    );
  }

  // (5) ALWAYS-SENSITIVE Approval Gate. Synthesise ONE PlanItem(op="create",
  // entity=kubeIdentityKey) and route it through the SAME `ReconcileGate` the
  // v1 catalog uses. Sensitivity is the CALLER's wiring contract
  // (`makeGate(() => true)`). On any denial we surface the gate's pending
  // approval id; NOTHING is applied (fail-safe — a pending approval ⇒ NO
  // mutation). The actor is sourced from the verified credential.
  const actor = actorOf(ctx.credential);
  const item: PlanItem = {
    op: "create",
    entity,
    change: `kubectl apply ${entity}`,
    impact: "applies a manifest to a live cluster — approval required",
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

  // (6) APPLY. Drive `KubernetesProvider.apply` directly behind a per-call
  // ApplyContext (minted ONLY now, post-gate). The provider observes by
  // identity, hash-compares for idempotency, and pipes the body via
  // `kubectl apply -f -` (NEVER --prune). FAIL-SAFE: a failed apply leaves
  // cluster state in place — we NEVER delete/destroy on an error path. We wrap
  // the provider error so a resolved secret can never leak into the envelope.
  const provider = deps.getProvider(hostConfig);
  const applyCtx = deps.makeApplyContext();
  try {
    const observed = await provider.observe(manifest);
    const result = await provider.apply(manifest, observed, applyCtx);
    // (7) STATE EVENT (Task 25, ground rule #5). One StateEvent per converging
    // mutation — actor sourced from the verified credential (NEVER synthesised);
    // entity = the kube identity; SECRET-FREE `after` (identity + manifest-hash
    // — the same one-way digest observe()'s minimal projection exposes; NEVER
    // the manifest body, NEVER a resolved `secret:<ref>` value). Emitted ONLY on
    // the successful apply path — the deny/pending/precondition/parse paths
    // above all return before reaching here, so they emit NOTHING (fail-safe,
    // mirrors set-firewall.ts). Optional seam: when unwired (in-memory unit
    // tests) the apply still succeeds; production wires the real pool/appendEvent.
    if (deps.appendEvent !== undefined) {
      await deps.appendEvent(deps.pool ?? null, {
        actor,
        scope: ctx.scope,
        op: "create",
        entity,
        result: "applied",
        after: {
          kube: entity,
          manifest_hash: manifestHash(manifest.body),
          changed: result.changed,
          capability_token_id: null,
        },
      });
    }
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [{ op: "create", entity, changed: result.changed }] },
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
 * to a generic `fatal` so an upstream error body can never leak a secret value.
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
    error: new ReconcileError("fatal", "kubectl_apply failed", {
      entity: "kube",
    }).toApiError(),
  });
}
