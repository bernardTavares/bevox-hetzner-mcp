/**
 * core/src/agent/v2/expose-service.ts
 *
 * Task F6.1 — `expose_service` (v2 write tool, BUNDLED approval).
 *
 * Surface: a single `exposeService(input, ctx, deps)` function that BOTH the
 * REST `POST /api/v2/expose` route and the MCP `expose_service` tool call —
 * single source of truth across transports. The tool synthesises the three
 * canonical sub-entities (Certificate + LoadBalancer + Ingress) needed to
 * expose a service publicly and writes them to the three respective working
 * desired-state stores in ONE bundled operation gated by a SINGLE Approval
 * row (cf. F5.3 set-ingress.ts header for the per-tool gating pattern this
 * generalises).
 *
 * Bundle design (app-layer, NOT a gate extension):
 *
 *   The v1 approval gate is 1:1 with one PlanItem. F6.1 needs a 1:N
 *   relationship (one approval ↔ three sub-entity writes). Rather than widen
 *   the gate semantics (which every other v2 tool would have to learn), we
 *   keep the gate untouched and bundle at THIS application layer:
 *
 *     1. Synthesise the three sub-entity desired values (cert / lb / ingress)
 *        sharing a canonical slug `<service>-<first-dns-label-of-hostname>`.
 *     2. Build ONE wrapper PlanItem `{ op:"create", entity:"expose:<slug>",
 *        change/impact:"creates certificate + load_balancer + ingress" }`.
 *        The wrapper IS the unit of approval: the gate sees exactly one item
 *        and creates exactly one approval row keyed by the bundle entity name.
 *     3. Route the wrapper through `ReconcileGate.evaluate()`:
 *          - DENIED (pending) ⇒ return `pending_approval` with the bundle's
 *            approval_id and the 3-entity plan ops. NO sub-store writes.
 *          - APPROVED (the gate already holds an approved row for this exact
 *            (scope, op, entity) — i.e. a follow-up call after the agent
 *            confirmed the approval) ⇒ proceed to write all three sub-stores.
 *     4. On approve-pass-through, write cert (if managed), lb, ingress to
 *        their respective working stores SEQUENTIALLY. A mid-bundle store
 *        failure is fail-safe: prior writes stand (idempotent on retry), the
 *        envelope surfaces an error, and the agent re-runs to converge.
 *
 *   This avoids ANY change to approval-gate.ts: the bundle wrapper rides the
 *   exact same evaluate(items, ctx) interface as every other v2 tool. The
 *   single approval the gate creates references the wrapper's `entity:
 *   "expose:<slug>"`; the metadata recorded with that approval (impact text)
 *   identifies the three sub-entities, so `GET /api/approvals` shows the
 *   human what they're approving.
 *
 * TLS branching:
 *   - `tls === "managed"` ⇒ synthesise a managed Certificate AND its lb +
 *     ingress (cert.name = slug, ingress.tls.certificate_ref = slug); the
 *     bundle holds 3 entities.
 *   - `tls === <existing-cert-ref>` (any other string) ⇒ REUSE that cert; do
 *     NOT synthesise one. The bundle holds 2 entities (lb + ingress) but is
 *     still wrapped in ONE approval (the agent's bundle of intent).
 *
 * Entity name synthesis: `<service>-<first-DNS-label-of-hostname>`. E.g.
 *   exposeService(service:"bevox-web", hostname:"app.example.com") ⇒ slug
 *   "bevox-web-app". All three (cert/lb/ingress) share the same slug — this
 *   gives the agent a single grep handle for the trio in observability.
 *
 * Idempotency: a second call with the same inputs is a no-op when all three
 * sub-entities are already present in their working stores with the synthesised
 * shape. We compare by deep-equal on the sub-entities; if all match, surface
 * `applied` with empty ops (no approval, no rewrite).
 *
 * Collision: if a sub-entity slug already exists in its working store with a
 * DIFFERENT shape than what we'd synthesise, surface `precondition` —
 * fail-safe (the agent must explicitly resolve the conflicting name).
 *
 * Gate sensitivity: callers MUST construct `approvalGate` with
 * `isSensitive: () => true` so the wrapper PlanItem (`op:"create"`) is gated
 * (`"create"` is NOT in `defaultSensitiveOps`). Same contract as
 * F2.4 / F3.5-uploaded / F4.4.
 *
 * StateEvent on `applied` carries `capability_token_id: null` (Bloco C
 * activates real population). One StateEvent is emitted PER sub-entity write
 * — the bundle's audit trail is the triple plus the approval's own event.
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
import {
  CertificateSchema,
  IngressSchema,
  LoadBalancerSchema,
  type Certificate,
  type Ingress,
  type LoadBalancer,
} from "../../domain/entities-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import type { PlanItem } from "../../domain/entities.js";
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";
import { appendEvent } from "../../store/state-events.js";
// Spec docs/specs/2026-05-27-mcp-string-interop-batch.md — defensive MCP
// client interop helpers (string→object/bool coercion).
import { asBool } from "../tools.js";
import type { WorkingCertificateStore } from "./set-certificate.js";
import type { WorkingLoadBalancerStore } from "./set-load-balancer.js";
import type { WorkingIngressStore } from "./set-ingress.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

export interface ExposeServiceInput {
  /** Pure planning — never writes desired-state, never opens approvals. */
  readonly dry_run?: boolean;
  /** Logical service name (label used as LB target + ingress selector). */
  readonly service: string;
  /** Public FQDN the LB will terminate TLS for. */
  readonly hostname: string;
  /**
   * `"managed"` ⇒ synthesise a managed Cert; any other string ⇒ reuse the
   * named existing cert (no Cert synthesis).
   */
  readonly tls: "managed" | string;
  /** Hetzner location for the LB. Defaults to "fsn1". */
  readonly location?: string;
}

export interface ExposeServiceCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope (defaulted to "expose" by callers). */
  readonly scope: string;
}

/**
 * Injected dependencies. The tool OWNS no I/O — it wires the three working
 * stores + a gate + the pg pool for StateEvent append.
 *
 * IMPORTANT: `approvalGate` MUST be constructed with `isSensitive: () => true`
 * so the wrapper PlanItem (`op:"create"`) is gated (the default sensitive set
 * only covers destroy/remove/restore — using the default here would silently
 * bypass approval for the bundle).
 */
export interface ExposeServiceDeps {
  readonly pool: pg.Pool;
  readonly approvalGate: ReconcileGate;
  readonly certificateStore: WorkingCertificateStore;
  readonly loadBalancerStore: WorkingLoadBalancerStore;
  readonly ingressStore: WorkingIngressStore;
}

// ---------------------------------------------------------------------------
// Slug + sub-entity synthesis (deterministic)
// ---------------------------------------------------------------------------

function firstDnsLabel(hostname: string): string {
  const i = hostname.indexOf(".");
  return (i === -1 ? hostname : hostname.slice(0, i)).trim().toLowerCase();
}

function slugFor(service: string, hostname: string): string {
  const label = firstDnsLabel(hostname);
  return `${service}-${label}`;
}

interface Synthesised {
  readonly slug: string;
  readonly cert: Certificate | null;
  readonly lb: LoadBalancer;
  readonly ingress: Ingress;
}

function synthesise(
  input: ExposeServiceInput,
): Synthesised {
  const { service, hostname, tls } = input;
  const location = input.location ?? "fsn1";
  const slug = slugFor(service, hostname);
  const isManaged = tls === "managed";

  const cert: Certificate | null = isManaged
    ? {
        name: slug,
        type: "managed",
        domains: [hostname],
      }
    : null;

  const lb: LoadBalancer = {
    name: slug,
    location,
    algorithm: "round_robin",
    targets: { label: service },
    health_check: {
      protocol: "http",
      port: 80,
      path: "/",
      interval: 15,
      timeout: 10,
      retries: 3,
    },
  };

  const ingress: Ingress = {
    name: slug,
    hostname,
    tls: { certificate_ref: isManaged ? slug : tls },
    routes: [
      {
        path: "/",
        backend: {
          service_selector: { label: service },
          port: 80,
        },
      },
    ],
    load_balancer_ref: slug,
  };

  return { slug, cert, lb, ingress };
}

// ---------------------------------------------------------------------------
// Plan-ops projection (deterministic, sorted by entity ascending)
// ---------------------------------------------------------------------------

interface BundleOp {
  readonly op: "create";
  readonly entity: string;
  readonly kind: "certificate" | "load_balancer" | "ingress";
}

function bundleOps(s: Synthesised): BundleOp[] {
  const ops: BundleOp[] = [];
  if (s.cert !== null) {
    ops.push({
      op: "create",
      entity: `certificate:${s.slug}`,
      kind: "certificate",
    });
  }
  ops.push({
    op: "create",
    entity: `ingress:${s.slug}`,
    kind: "ingress",
  });
  ops.push({
    op: "create",
    entity: `load_balancer:${s.slug}`,
    kind: "load_balancer",
  });
  // Sorted by entity ascending — deterministic; covers cert/ingress/lb.
  ops.sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));
  return ops;
}

// ---------------------------------------------------------------------------
// Idempotency + collision detection
// ---------------------------------------------------------------------------

interface PriorShape {
  readonly cert: Certificate | null;
  readonly lb: LoadBalancer | null;
  readonly ingress: Ingress | null;
}

async function readPrior(
  deps: ExposeServiceDeps,
  slug: string,
): Promise<PriorShape> {
  const [cert, lb, ingress] = await Promise.all([
    deps.certificateStore.get(slug),
    deps.loadBalancerStore.get(slug),
    deps.ingressStore.get(slug),
  ]);
  return { cert, lb, ingress };
}

/** Deep equality via canonical JSON — sufficient for plain manifest data. */
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns `true` iff EVERY required sub-entity already matches `s` exactly. */
function isFullyApplied(s: Synthesised, prior: PriorShape): boolean {
  if (s.cert !== null && !eq(prior.cert, s.cert)) return false;
  if (!eq(prior.lb, s.lb)) return false;
  if (!eq(prior.ingress, s.ingress)) return false;
  return true;
}

/**
 * If ANY sub-entity is already present in its working store with a SHAPE
 * DIFFERENT from what we'd synthesise, return a description of the conflict;
 * otherwise null. Missing prior entities are fine (we'll create them); a
 * matching prior is fine (idempotency).
 */
function findCollision(s: Synthesised, prior: PriorShape): string | null {
  if (s.cert !== null && prior.cert !== null && !eq(prior.cert, s.cert)) {
    return `certificate:${s.slug} exists with a different shape`;
  }
  if (prior.lb !== null && !eq(prior.lb, s.lb)) {
    return `load_balancer:${s.slug} exists with a different shape`;
  }
  if (prior.ingress !== null && !eq(prior.ingress, s.ingress)) {
    return `ingress:${s.slug} exists with a different shape`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// exposeService — the single dispatch
// ---------------------------------------------------------------------------

export async function exposeService(
  input: ExposeServiceInput,
  ctx: ExposeServiceCtx,
  deps: ExposeServiceDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE.
  try {
    assertV2Capability(ctx.credential, "expose_service");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Validate input shape. The synthesised sub-entities must each parse
  //     against their FROZEN schemas — we run them through to catch a hostile
  //     `service`/`hostname` BEFORE any working-store write.
  if (
    typeof input.service !== "string" ||
    input.service.trim() === "" ||
    typeof input.hostname !== "string" ||
    input.hostname.trim() === "" ||
    typeof input.tls !== "string" ||
    input.tls.trim() === ""
  ) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        "expose_service: service, hostname, and tls are required non-empty strings",
        { entity: "expose" },
      ),
    );
  }

  let s: Synthesised;
  try {
    s = synthesise(input);
    if (s.cert !== null) CertificateSchema.parse(s.cert);
    LoadBalancerSchema.parse(s.lb);
    IngressSchema.parse(s.ingress);
  } catch (err) {
    return toErrorEnvelope(
      new ReconcileError(
        "precondition",
        `invalid expose_service input: ${(err as Error).message}`,
        { entity: "expose" },
      ),
    );
  }

  const dryRun = asBool(input.dry_run);
  const entity = `expose:${s.slug}`;
  const actor = actorOf(ctx.credential);
  const ops = bundleOps(s);

  // (3) Dry-run → planned. Pure planning; never writes / never opens approval.
  if (dryRun) {
    return buildV2WriteEnvelope({
      status: "planned",
      plan: { ops: [...ops] },
    });
  }

  // (4) Read prior shapes from the three working stores. We need them BOTH
  //     for idempotency (no-op when fully applied) AND for collision
  //     detection (a slug already taken by a different shape ⇒ precondition).
  let prior: PriorShape;
  try {
    prior = await readPrior(deps, s.slug);
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (5) Collision: slug taken by a different shape ⇒ precondition (fail-safe).
  const collision = findCollision(s, prior);
  if (collision !== null) {
    return toErrorEnvelope(
      new ReconcileError("precondition", collision, { entity }),
    );
  }

  // (6) Idempotent no-op: everything we'd write already matches ⇒ applied
  //     empty-ops; NO approval, NO rewrite, NO StateEvent.
  if (isFullyApplied(s, prior)) {
    return buildV2WriteEnvelope({
      status: "applied",
      plan: { ops: [] },
    });
  }

  // (7) Bundle approval. ONE wrapper PlanItem covers all three sub-entities;
  //     the gate creates exactly one approval row. The impact text names the
  //     bundle so `GET /api/approvals` surfaces what's being approved.
  const subEntities = ops.map((o) => o.entity).join(", ");
  const item: PlanItem = {
    op: "create",
    entity,
    change: `expose ${input.service} as ${input.hostname}`,
    impact:
      s.cert !== null
        ? `bundled create: ${subEntities} (managed cert + lb + ingress)`
        : `bundled create: ${subEntities} (reuse cert ${input.tls}; lb + ingress)`,
  };
  const gateCtx: GateContext = {
    scope: `agent:${actor}:${ctx.scope}`,
    actor,
  };

  let approvalId: string | undefined;
  let approved = false;
  try {
    const decision = await deps.approvalGate.evaluate([item], gateCtx);
    if (decision.denied.length > 0) {
      const picked = (decision.pendingApprovals ?? []).find(
        (p) => p.entity === entity && p.op === "create",
      );
      approvalId = picked?.approvalId;
    } else if (decision.approved.length > 0) {
      approved = true;
    }
  } catch (err) {
    return toErrorEnvelope(err);
  }

  if (!approved) {
    // Pending / withheld ⇒ surface the bundle's approval_id + the 3-op plan
    // (so the agent sees what the human is approving) and STOP. NO sub-store
    // writes — fail-safe (the bundle is atomic at intent level).
    if (approvalId === undefined) {
      return toErrorEnvelope(
        new ReconcileError(
          "fatal",
          "expose_service withheld but no pending approval id was reported",
          { entity },
        ),
      );
    }
    return buildV2WriteEnvelope({
      status: "pending_approval",
      approval_id: approvalId,
      plan: { ops: [...ops] },
    });
  }

  // (8) Approved (gate found a pre-existing approved row for this exact
  //     (scope, op, entity)). Write the three sub-entities sequentially to
  //     their respective working stores + emit a StateEvent per write. A
  //     mid-bundle failure is fail-safe: prior writes stand (idempotent on
  //     retry) and the agent sees a precondition/transient envelope.
  if (s.cert !== null) {
    try {
      await deps.certificateStore.put(s.cert.name, s.cert);
      await appendEvent(deps.pool, {
        actor,
        scope: ctx.scope,
        op: "create",
        entity: `certificate:${s.cert.name}`,
        result: "applied",
        after: {
          type: s.cert.type,
          domains: [...s.cert.domains],
          bundle: entity,
          capability_token_id: null,
        },
      });
    } catch (err) {
      return toErrorEnvelope(err);
    }
  }
  try {
    await deps.loadBalancerStore.put(s.lb.name, s.lb);
    await appendEvent(deps.pool, {
      actor,
      scope: ctx.scope,
      op: "create",
      entity: `load_balancer:${s.lb.name}`,
      result: "applied",
      after: {
        location: s.lb.location,
        algorithm: s.lb.algorithm,
        targets: s.lb.targets,
        bundle: entity,
        capability_token_id: null,
      },
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }
  try {
    await deps.ingressStore.put(s.ingress.name, s.ingress);
    await appendEvent(deps.pool, {
      actor,
      scope: ctx.scope,
      op: "create",
      entity: `ingress:${s.ingress.name}`,
      result: "applied",
      after: {
        hostname: s.ingress.hostname,
        load_balancer_ref: s.ingress.load_balancer_ref,
        tls: { certificate_ref: s.ingress.tls.certificate_ref },
        bundle: entity,
        capability_token_id: null,
      },
    });
  } catch (err) {
    return toErrorEnvelope(err);
  }

  return buildV2WriteEnvelope({
    status: "applied",
    plan: { ops: [...ops] },
  });
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
    error: new ReconcileError("fatal", "expose_service failed", {
      entity: "expose",
    }).toApiError(),
  });
}
