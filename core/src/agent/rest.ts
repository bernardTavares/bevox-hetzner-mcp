/**
 * core/src/agent/rest.ts
 *
 * Task 4.5 — the REST API implementing `console/CONTRACT.md` EXACTLY.
 *
 * This is a THIN HTTP adapter over the 4.4 shared tool catalog. It owns NO
 * policy: it parses an HTTP request into a tool input + `ToolContext`, calls
 * the SINGLE `ToolCatalog.executeTool`, and serializes the `ToolResult` back
 * onto the frozen contract HTTP response. ALL authz / approval / reconcile /
 * audit lives in 4.1–4.4 (reused). A REST `POST /api/destroy` and the later MCP
 * `destroy` (4.7) therefore produce the SAME envelope + SAME StateEvent — the
 * logic is the shared catalog, never duplicated here.
 *
 * Design principles (CLAUDE.md non-negotiables; CONTRACT.md is FROZEN):
 *
 *   - CONTRACT-FROZEN I/O. Every endpoint's METHOD + path + query + body +
 *     response matches `console/CONTRACT.md` and the console `client.ts` calls
 *     byte-for-faithful. The Tool→Endpoint mapping is DATA (`ROUTES`); reads
 *     return the contract entity/state/events/health shapes, writes return the
 *     4.1 `WriteEnvelope`. console/ is never modified — rest.ts conforms.
 *
 *   - CREDENTIAL SEAM (4.2). The agent credential is extracted from the request
 *     `Authorization: Bearer <token>` header and resolved via the injected
 *     `CredentialStore` (the 4.2 `authenticate` seam — injectable for tests).
 *     A missing/invalid credential → a contract-shaped `error()` envelope with
 *     the correct status and NO tool executed (deny-before-write). The token /
 *     any secret is NEVER logged or echoed.
 *
 *   - THIN ADAPTER, NO PARALLEL LOGIC. rest.ts ONLY does HTTP parse → route →
 *     `executeTool` → serialize + status-map. No business rule, no second
 *     approval/auth/reconcile path. `dry_run` is passed through verbatim (the
 *     catalog's always-policy gate is the destructive-op safety net per
 *     CONTRACT.md's Write-Envelope lifecycle — CONTRACT.md does NOT mandate a
 *     forced `dry_run:true` default, so none is fabricated).
 *
 *   - FAIL-SAFE & NO-LEAK. An error `ToolResult` is serialized as the contract
 *     `WriteEnvelope` `error()` body with the ReconcileError class mapped to
 *     the conventional HTTP status (fatal/authz→403, precondition→400,
 *     conflict→409, transient→503, partial→409); the body STAYS contract-
 *     shaped. No stack/secret/token ever reaches the body or logs.
 *
 *   - SECRETS READ (4.5b). `GET /api/secrets` is the console-only read NOT in
 *     the Tool→Endpoint table. HARD INVARIANT: no secret value EVER leaves the
 *     core here. The handler maps the injected `SecretResolver.describe()`
 *     METADATA ONLY → the frozen `.strict()` `SecretSchema` shape
 *     ({name, keys-COUNT, used_by}); it NEVER calls `resolve()` and has no
 *     `ApplyContext` (it is a read path). The secrets dep is OPTIONAL — absent
 *     ⇒ `[]` (every prior 4.x caller is byte-for-byte unaffected).
 *
 *   - BACKUPS READ (5.4). `GET /api/backups` is the console-only enriched
 *     read NOT in the Tool→Endpoint table (the FROZEN 12-tool catalog has no
 *     list-backups tool; minting one would break the 12-tool conformance
 *     oracle + the mcp/capability tests). It mirrors the 4.5b `/api/secrets`
 *     seam EXACTLY: an OPTIONAL injected `backups.list()` producing the frozen
 *     contract `BackupEntry[]` (the 5.3 BackupProvider.listBackup over the
 *     desired backup policies). Authn-gated like every other read
 *     (deny-before-write), NO mutation, NO StateEvent, unwrapped
 *     `BackupEntry[]` body. The dep is OPTIONAL — absent ⇒ `[]`, so every
 *     prior 4.x/5.x caller is byte-for-byte unaffected. No restic password /
 *     repo credential ever crosses it (5.3 guarantees BackupEntry is
 *     non-secret operational metadata only).
 *
 *   - HEALTH AGGREGATION (6.4). `GET /api/health` returns the REAL aggregated
 *     contract `HealthReport` when the OPTIONAL `health` seam is wired —
 *     `health.ts` PURE-folds the signals 6.1/6.2/6.3 already produce (breaker
 *     registry snapshots, the last reconcile/drift state); rest.ts only
 *     authn-gates → calls the seam → serializes (thin-adapter rule; no fold
 *     logic here). Same read discipline as `/api/secrets`/`/api/backups`:
 *     authn-gated (deny-before-write), NO catalog/tool call, NO mutation, NO
 *     StateEvent, unwrapped contract body, names/counts/timestamps only — no
 *     secret. The dep is OPTIONAL — absent ⇒ the route falls through to the
 *     existing catalog `health` placeholder tool, so every prior caller/test
 *     is byte-for-byte unaffected (backward-compatible, no flap).
 *
 *   - DRY/YAGNI. ONLY the CONTRACT.md Tool→Endpoint surface + the approvals
 *     resolution endpoints (the 4.3 webhook path, NOT a catalog tool) + the
 *     4.5b `/api/secrets` read + the 5.4 `/api/backups` read. NOT the 4.6
 *     oracle, NOT MCP (4.7). Minimal exported surface: `createRestServer(deps)`.
 *
 * Exported API (ONLY these — minimal surface):
 *   createRestServer(deps) → RestServer   — { handle, listen, close }
 *   interface RestServer / RestServerDeps  (deps.secrets is OPTIONAL — 4.5b)
 */

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { authenticate, actorOf, type CredentialStore } from "./auth.js";
import type { VerifiedCredential } from "./capability.js";
import { asBool, type ToolCatalog, type ToolResult } from "./tools.js";
import type { ApprovalGate } from "./approval-gate.js";
import { error as errorEnvelope, type WriteEnvelope } from "./envelope.js";
import { ReconcileError, type ErrorClass } from "../domain/errors.js";
import type { SecretResolver } from "../store/secrets.js";
import type { BackupEntry } from "../providers/backup-restic.js";
import { aggregateHealth, type HealthSource } from "./health.js";
import type { SelectorInput } from "./v2/resolve-selector.js";
import {
  setFirewall,
  type SetFirewallDeps,
  type SetFirewallInput,
} from "./v2/set-firewall.js";
import {
  setPrimaryIp,
  type SetPrimaryIpDeps,
  type SetPrimaryIpInput,
} from "./v2/set-primary-ip.js";
import {
  setCertificate,
  type SetCertificateDeps,
  type SetCertificateInput,
} from "./v2/set-certificate.js";
import {
  setLoadBalancer,
  type SetLoadBalancerDeps,
  type SetLoadBalancerInput,
} from "./v2/set-load-balancer.js";
import {
  setIngress,
  type SetIngressDeps,
  type SetIngressInput,
} from "./v2/set-ingress.js";
import {
  exposeService,
  type ExposeServiceDeps,
  type ExposeServiceInput,
} from "./v2/expose-service.js";
import {
  runMigrations,
  type RunMigrationsDeps,
  type RunMigrationsInput,
} from "./v2/run-migrations.js";
import {
  kubectlApply,
  type KubectlApplyDeps,
  type KubectlApplyInput,
} from "./v2/kubectl-apply.js";
import {
  ensureK3s,
  type EnsureK3sToolDeps,
  type EnsureK3sInput,
} from "./v2/ensure-k3s.js";
import type { WriteEnvelopeV2 } from "./v2/envelope-v2.js";

// ---------------------------------------------------------------------------
// Dependencies / public types
// ---------------------------------------------------------------------------

export interface RestServerDeps {
  /** The SINGLE 4.4 shared tool catalog (REST/MCP both call this — no fork). */
  readonly catalog: ToolCatalog;
  /** The 4.2 credential resolution seam (injected; v1 in-memory store). */
  readonly credentials: CredentialStore;
  /**
   * The 4.3 Approval Gate instance. `/api/approvals*` are the webhook/poll
   * resolution path the gate exposes — NOT catalog tools — so the gate is
   * wired here directly. It MUST be the SAME gate the catalog's reconcile
   * builds approvals with (caller's responsibility) so list/resolve see them.
   */
  readonly approvalGate: ApprovalGate;
  /**
   * OPTIONAL secrets-read seam for `GET /api/secrets` (Task 4.5b — the
   * console-only read, NOT a catalog tool). `refs` is the enumerable list of
   * known "secret:<name>" refs; `resolver.describe(ref)` returns METADATA
   * ONLY. This is backward-compatible: omitted ⇒ `/api/secrets` ⇒ `[]`, so
   * every prior 4.x `createRestServer` caller is byte-for-byte unaffected.
   *
   * SECURITY: only `resolver.describe()` is ever called from the read path —
   * `resolver.resolve()` (the value path) is NEVER invoked here and the route
   * holds no `ApplyContext`, mirroring the 1.9/3.3 no-value guard.
   */
  readonly secrets?: {
    readonly resolver: SecretResolver;
    readonly refs: readonly string[];
  };
  /**
   * OPTIONAL backups-read seam for `GET /api/backups` (Task 5.4 — the
   * console-only enriched read, NOT a catalog tool). `list()` returns the
   * frozen contract `BackupEntry[]` (the caller wires the 5.3
   * `BackupProvider.listBackup` over the desired backup policies). This is
   * backward-compatible: omitted ⇒ `/api/backups` ⇒ `[]`, so every prior
   * 4.x/5.x `createRestServer` caller is byte-for-byte unaffected.
   *
   * READ DISCIPLINE: this is a pure read — authn-gated (deny-before-write),
   * NO mutation, NO StateEvent, no `ApplyContext`. The contract `BackupEntry`
   * is non-secret operational metadata ONLY (5.3 guarantees the restic
   * password / repo credentials never cross into it).
   */
  readonly backups?: {
    readonly list: () => Promise<readonly BackupEntry[]>;
  };
  /**
   * OPTIONAL health-aggregation seam for `GET /api/health` (Task 6.4). When
   * supplied, the route returns the REAL aggregated `HealthReport` folded from
   * the signals 6.1/6.2/6.3 already produce (breaker registry snapshots, the
   * last reconcile/drift state) — NOT the 4.4 catalog `health` placeholder.
   *
   * BACKWARD-COMPAT: omitted ⇒ `/api/health` falls through to the existing
   * catalog `health` read tool (the all-clear placeholder body + its audited
   * StateEvent), so every prior 4.x/5.x/6.x caller/test is byte-for-byte
   * unaffected and the no-fault path is unchanged.
   *
   * READ DISCIPLINE: pure read — authn-gated (deny-before-write: a
   * missing/invalid credential throws fatal/403 BEFORE `snapshot()` is ever
   * called), NO mutation, NO StateEvent, no `ApplyContext`, unwrapped contract
   * `HealthReport` body. `snapshot()` exposes ONLY names/states/counts/
   * timestamps/entity-keys — NEVER a secret value (1.9/3.3; the 6.2 breaker
   * snapshot is already name+counts only).
   */
  readonly health?: HealthSource;
  /**
   * OPTIONAL deps for the v2 `set_firewall` write tool (Task F1.4). When
   * supplied, `POST /api/v2/firewalls` is wired and routes through the
   * SHARED `setFirewall(...)` function (same source as MCP `set_firewall`).
   * Omitted ⇒ the route is absent and falls through to the standard 404.
   *
   * Per-capability `set_firewall` scope is enforced inside `setFirewall`
   * itself (deny-before-write); REST only adds the authn gate (extract +
   * resolve the bearer token).
   */
  readonly setFirewall?: SetFirewallDeps;
  /**
   * OPTIONAL deps for the v2 `set_primary_ip` write tool (Task F2.4). When
   * supplied, `POST /api/v2/primary-ips` is wired and routes through the
   * SHARED `setPrimaryIp(...)` function (same source as MCP
   * `set_primary_ip`). Omitted ⇒ the route is absent and falls through to
   * the standard 404.
   *
   * Per-capability `set_primary_ip` scope is enforced inside `setPrimaryIp`
   * itself (deny-before-write); REST only adds the authn gate.
   */
  readonly setPrimaryIp?: SetPrimaryIpDeps;
  /**
   * OPTIONAL deps for the v2 `set_certificate` write tool (Task F3.5). When
   * supplied, `POST /api/v2/certificates` is wired and routes through the
   * SHARED `setCertificate(...)` function (same source as MCP
   * `set_certificate`). Omitted ⇒ the route is absent and falls through to
   * the standard 404.
   *
   * Per-capability `set_certificate` scope is enforced inside
   * `setCertificate` itself (deny-before-write); REST only adds the authn
   * gate. Type-based Approval branching is owned by `setCertificate`:
   * managed ⇒ no approval; uploaded ⇒ approval-gated.
   */
  readonly setCertificate?: SetCertificateDeps;
  /**
   * OPTIONAL deps for the v2 `set_load_balancer` write tool (Task F4.4). When
   * supplied, `POST /api/v2/load-balancers` is wired and routes through the
   * SHARED `setLoadBalancer(...)` function (single source of truth with the
   * MCP `set_load_balancer` tool). Omitted ⇒ the route is absent and falls
   * through to the standard 404.
   *
   * Per-capability `set_load_balancer` scope is enforced inside
   * `setLoadBalancer` itself (deny-before-write); REST only adds the authn
   * gate. APPROVAL ALWAYS for every non-no-op (cost + possible recreation);
   * a location change is surfaced as a `recreate` plan op carrying the
   * `impact:"public IP will change"` note.
   */
  readonly setLoadBalancer?: SetLoadBalancerDeps;
  /**
   * OPTIONAL deps for the v2 `set_ingress` write tool (Task F5.3). When
   * supplied, `POST /api/v2/ingresses` is wired and routes through the
   * SHARED `setIngress(...)` function (single source of truth with the MCP
   * `set_ingress` tool). Omitted ⇒ the route is absent and falls through to
   * the standard 404.
   *
   * Per-capability `set_ingress` scope is enforced inside `setIngress`
   * itself (deny-before-write). DNS-touch destructive classification
   * (hostname change / load_balancer_ref change) is the only Approval path;
   * a brand-new Ingress is no-Approval (consistent with v1 `set_dns`).
   */
  readonly setIngress?: SetIngressDeps;
  /**
   * OPTIONAL deps for the v2 `expose_service` write tool (Task F6.1). When
   * supplied, `POST /api/v2/expose` is wired and routes through the SHARED
   * `exposeService(...)` function (single source of truth with the MCP
   * `expose_service` tool). Omitted ⇒ the route is absent and falls through
   * to the standard 404.
   *
   * Per-capability `expose_service` scope is enforced inside `exposeService`
   * itself (deny-before-write). The tool synthesises three sub-entities
   * (certificate + load_balancer + ingress) sharing a canonical slug and
   * writes them under ONE bundled approval (app-layer bundle — the v1
   * approval-gate stays 1:1 with one wrapper PlanItem). Callers MUST
   * construct `approvalGate` with `isSensitive: () => true` (the wrapper's
   * `op:"create"` is not in `defaultSensitiveOps`).
   */
  readonly exposeService?: ExposeServiceDeps;
  /**
   * OPTIONAL deps for the v2 `run_migrations` write tool (Task 7.1). When
   * supplied, `POST /api/v2/migrations` is wired and routes through the
   * SHARED `runMigrations(...)` function (single source of truth with the
   * MCP `run_migrations` tool). Omitted ⇒ the route is absent and falls
   * through to the standard 404.
   *
   * Per-capability `run_migrations` scope is enforced inside `runMigrations`
   * itself (deny-before-write); REST only adds the authn gate. The runner
   * is ALWAYS-SENSITIVE per spec §1.3 — callers MUST construct the gate in
   * `deps.approvalGate` with `isSensitive: () => true`.
   */
  readonly runMigrations?: RunMigrationsDeps;
  /**
   * OPTIONAL deps for the v2 `kubectl_apply` write tool (Bloco E Task 14). When
   * supplied, `POST /api/v2/kube/apply` is wired and routes through the SHARED
   * `kubectlApply(...)` function (single source of truth with the MCP
   * `kubectl_apply` tool). Omitted ⇒ the route is absent and falls through to
   * the standard 404.
   *
   * Per-capability `kubectl_apply` scope is enforced inside `kubectlApply`
   * itself (deny-before-write); REST only adds the authn gate. ALWAYS-SENSITIVE
   * — callers MUST construct `approvalGate` with `isSensitive: () => true`. The
   * named `host` resolves SERVER-SIDE (Q-c); the target namespace must already
   * exist (Q-d).
   */
  readonly kubectlApply?: KubectlApplyDeps;
  /**
   * OPTIONAL deps for the v2 `ensure_k3s` write tool (Bloco E Task 23). When
   * supplied, `POST /api/v2/k3s/ensure` is wired and routes through the SHARED
   * `ensureK3s(...)` function (single source of truth with the MCP `ensure_k3s`
   * tool). Omitted ⇒ the route is absent and falls through to the standard 404.
   *
   * Per-capability `ensure_k3s` scope is enforced inside `ensureK3s` itself
   * (deny-before-write); REST only adds the authn gate. ALWAYS-SENSITIVE —
   * callers MUST construct `approvalGate` with `isSensitive: () => true`. The
   * named `host` resolves SERVER-SIDE (Q-c). INSTALL-ONLY / fail-safe: never
   * uninstall, never auto-upgrade (Q-a).
   */
  readonly ensureK3s?: EnsureK3sToolDeps;
  /**
   * Ignored at runtime by REST (the v2 routes are gated solely on the
   * respective deps being supplied). Accepted for symmetry with the MCP
   * surface so a single caller can pass the same opt-in set to both.
   */
  readonly v2Tools?: ReadonlySet<string>;
}

export interface RestServer {
  /**
   * Handle one request in-process (the real routing/serialization path). Bound
   * to `node:http` by `listen()`, but also callable directly so tests exercise
   * the exact handler WITHOUT binding a port (deterministic, no port race).
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Bind an ephemeral (or given) loopback port. Returns the bound port. */
  listen(port?: number): Promise<number>;
  /** Close the bound server (no-op if never listened). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP status mapping — ReconcileError class → conventional code
//
// The BODY always stays the contract WriteEnvelope `error()` shape; only the
// status line varies. CONTRACT.md does not enumerate codes, so the
// conventional mapping for each error class is used (errors.ts §classify is
// the inverse: 401/403→fatal, 5xx/429→transient, …).
// ---------------------------------------------------------------------------

const STATUS_BY_CLASS: Readonly<Record<ErrorClass, number>> = {
  fatal: 403, // authz / permanent mis-config (errors.ts maps 401/403→fatal)
  precondition: 400, // a dependency/input is missing — client must fix & retry
  conflict: 409, // observed diverges from desired (drift) — needs review
  transient: 503, // temporary upstream failure — safe to retry
  partial: 409, // some sub-ops failed — needs review before retry
};

function httpStatusForError(env: WriteEnvelope): number {
  const code = env.error?.code;
  if (code && code in STATUS_BY_CLASS) {
    return STATUS_BY_CLASS[code as ErrorClass];
  }
  return 500;
}

// ---------------------------------------------------------------------------
// JSON I/O helpers (no leak — never echoes the raw request or the token)
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Serialize a contract error WITHOUT leaking internals (safe class/message). */
function sendError(
  res: ServerResponse,
  err: ReconcileError,
): void {
  const env = errorEnvelope(err);
  sendJson(res, httpStatusForError(env), env);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Bound the body so a hostile client cannot exhaust memory (1 MiB is far
  // beyond any legitimate manifest the contract carries).
  const MAX = 1024 * 1024;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX) {
      throw new ReconcileError("precondition", "request body too large", {
        entity: "agent",
      });
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echo the offending body (it may carry secret refs/values).
    throw new ReconcileError("precondition", "request body is not valid JSON", {
      entity: "agent",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReconcileError(
      "precondition",
      "request body must be a JSON object",
      { entity: "agent" },
    );
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Credential extraction — the 4.2 seam (deny-before-write)
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token and resolve it via the 4.2 `authenticate` seam.
 * A missing/invalid credential throws ReconcileError("fatal") (authz) BEFORE
 * any tool executes — exactly the deny-before-write contract. The token is
 * never logged or echoed.
 */
function authenticateRequest(
  req: IncomingMessage,
  store: CredentialStore,
): VerifiedCredential {
  const header = req.headers["authorization"];
  const raw = Array.isArray(header) ? header[0] : header;
  const token =
    raw && /^Bearer\s+/i.test(raw) ? raw.replace(/^Bearer\s+/i, "").trim() : "";
  // authenticate() throws fatal on empty/unknown token (message never reveals
  // which tokens exist — capability.ts owns the wording).
  return authenticate(store, token);
}

// ---------------------------------------------------------------------------
// The Tool → Endpoint table — DATA, not conditionals (CONTRACT.md §Tool table)
//
// Each write route maps a contract endpoint to ONE catalog tool, the scope the
// reconcile partition uses, and how path params + query merge into the tool
// input. rest.ts adds NO logic — the catalog (4.4) owns every rule.
// ---------------------------------------------------------------------------

interface WriteRoute {
  readonly method: "POST";
  /** Path matcher; `:param` segments are captured into the tool input. */
  readonly pattern: string;
  readonly tool: string;
  /** The reconcile scope (`<kind>` partition) this tool acts on. */
  readonly scope: string;
  /**
   * Merge captured path params into the tool input under these keys (e.g. the
   * `:name` in `/api/services/:name/scale` → input.name). Body keys win for
   * everything else; path params are authoritative for the routed resource id.
   */
  readonly pathParams?: Readonly<Record<string, string>>;
}

interface ReadRoute {
  readonly method: "GET";
  readonly pattern: string;
  readonly tool: string;
  readonly scope: string;
  /** Query keys forwarded into the read tool input verbatim. */
  readonly query?: readonly string[];
}

// Frozen CONTRACT.md Tool→Endpoint table (write side).
const WRITE_ROUTES: readonly WriteRoute[] = [
  { method: "POST", pattern: "/api/servers", tool: "provision_server", scope: "server" },
  { method: "POST", pattern: "/api/services", tool: "deploy_service", scope: "service" },
  {
    method: "POST",
    pattern: "/api/services/:name/scale",
    tool: "scale_service",
    scope: "service",
    pathParams: { name: "name" },
  },
  { method: "POST", pattern: "/api/dns", tool: "set_dns", scope: "dns" },
  {
    method: "POST",
    pattern: "/api/backups/:target/snapshot",
    tool: "snapshot",
    scope: "volume",
    pathParams: { target: "target" },
  },
  {
    method: "POST",
    pattern: "/api/backups/:target/restore",
    tool: "restore",
    scope: "volume",
    pathParams: { target: "target" },
  },
  { method: "POST", pattern: "/api/destroy", tool: "destroy", scope: "server" },
  { method: "POST", pattern: "/api/apply", tool: "apply_manifest", scope: "manifest" },
];

// Frozen CONTRACT.md Tool→Endpoint table (read side).
const READ_ROUTES: readonly ReadRoute[] = [
  { method: "GET", pattern: "/api/state", tool: "get_state", scope: "server" },
  { method: "GET", pattern: "/api/diff", tool: "diff", scope: "server", query: ["source"] },
  {
    method: "GET",
    pattern: "/api/events",
    tool: "events",
    scope: "server",
    query: ["actor", "entity", "result"],
  },
  { method: "GET", pattern: "/api/health", tool: "health", scope: "server" },
];

// ---------------------------------------------------------------------------
// Path matching (no router dependency — minimal, exact-segment matcher)
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Match a concrete path against a `:param` pattern. Returns the captured
 * params, or undefined if the segment counts/literals do not match.
 */
function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const pSeg = segments(pattern);
  const aSeg = segments(path);
  if (pSeg.length !== aSeg.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSeg.length; i++) {
    const p = pSeg[i]!;
    const a = aSeg[i]!;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return undefined;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// ToolResult → contract HTTP response
// ---------------------------------------------------------------------------

/**
 * Serialize a `ToolResult` to the exact contract HTTP shape:
 *   - read tools: the unwrapped contract entity/state/events/health payload
 *     (the console client parses the raw shape, NOT a `{status,data}` wrapper);
 *   - write tools: the 4.1 `WriteEnvelope` verbatim — 200 for
 *     planned/pending_approval/applied, the mapped status for `error` (body
 *     stays the contract envelope so the console client throws the typed
 *     ApiError).
 */
function sendToolResult(res: ServerResponse, result: ToolResult): void {
  if (result.status === "ok") {
    sendJson(res, 200, (result as { data: unknown }).data);
    return;
  }
  const env = result as WriteEnvelope;
  if (env.status === "error") {
    sendJson(res, httpStatusForError(env), env);
    return;
  }
  // planned | pending_approval | applied — a successful write envelope.
  sendJson(res, 200, env);
}

// ---------------------------------------------------------------------------
// Approvals projection — internal ApprovalRecord → frozen ApprovalSchema
//
// The 4.3 lifecycle superset (pending|approved|rejected|cancelled) is mapped
// back onto the FROZEN console enum (pending|approved|rejected): a `cancelled`
// (rejected OR expired) projects to "rejected" — core never widens the
// contract (approval-gate.ts §LIFECYCLE documents exactly this projection).
// ---------------------------------------------------------------------------

interface ContractApproval {
  readonly id: string;
  readonly action: string;
  readonly entity: string;
  readonly actor: string;
  readonly requested_at: string;
  readonly ttl_remaining: string;
  readonly impact: string;
  readonly status: "pending" | "approved" | "rejected";
}

function projectApproval(
  rec: {
    id: string;
    op: string;
    entity: string;
    actor: string;
    status: "pending" | "approved" | "rejected" | "cancelled";
    impact: string;
    requestedAt: string;
    expiresAt: string;
  },
  nowMs: number,
): ContractApproval {
  const status: "pending" | "approved" | "rejected" =
    rec.status === "approved"
      ? "approved"
      : rec.status === "pending"
        ? "pending"
        : "rejected"; // rejected OR cancelled (expired) → "rejected"
  const remainingMs =
    rec.status === "pending"
      ? Math.max(0, new Date(rec.expiresAt).getTime() - nowMs)
      : 0;
  return {
    id: rec.id,
    action: rec.op,
    entity: rec.entity,
    actor: rec.actor,
    requested_at: rec.requestedAt,
    ttl_remaining: `${Math.floor(remainingMs / 1000)}s`,
    impact: rec.impact,
    status,
  };
}

// ---------------------------------------------------------------------------
// createRestServer
// ---------------------------------------------------------------------------

export function createRestServer(deps: RestServerDeps): RestServer {
  const { catalog, credentials, approvalGate, secrets, backups, health } =
    deps;
  const setFirewallDeps = deps.setFirewall;
  const setPrimaryIpDeps = deps.setPrimaryIp;
  const setCertificateDeps = deps.setCertificate;
  const setLoadBalancerDeps = deps.setLoadBalancer;
  const setIngressDeps = deps.setIngress;
  const exposeServiceDeps = deps.exposeService;
  const runMigrationsDeps = deps.runMigrations;
  const kubectlApplyDeps = deps.kubectlApply;
  const ensureK3sDeps = deps.ensureK3s;
  let server: Server | undefined;

  /**
   * Project ONE secret ref to the frozen console `SecretSchema` shape using
   * `describe()` METADATA ONLY. SECURITY: `keys` is collapsed to a COUNT (the
   * key NAMES never leave the core), `used_by` is copied verbatim, and
   * `resolve()` / any value path is NEVER touched (no `ApplyContext` here).
   * Mirrors the 1.9/3.3 no-value guard — the response can carry NO secret
   * material by construction.
   */
  function describeSecret(
    ref: string,
  ): { name: string; keys: number; used_by: string[] } {
    // describe() returns {name, keys: string[] (names), used_by} — metadata
    // only, by the 1.9 contract. We expose ONLY the count of keys.
    const meta = secrets!.resolver.describe(ref);
    return {
      name: meta.name,
      keys: meta.keys.length,
      used_by: [...meta.used_by],
    };
  }

  /**
   * Route + serialize one request. EVERY mutating/reading path authenticates
   * FIRST (deny-before-write); only then is the catalog (4.4) invoked. rest.ts
   * itself adds no authz/policy.
   */
  async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;

    // --- approvals webhook/poll path (4.3 gate — NOT a catalog tool) -------
    if (path === "/api/approvals" && method === "GET") {
      // Authn gate ONLY (deny-before-write throws inside): the 4.3 gate list
      // already carries each record's actor/scope, so no credential is bound.
      authenticateRequest(req, credentials);
      const records = await approvalGate.listApprovals();
      const nowMs = Date.now();
      sendJson(
        res,
        200,
        records.map((r) => projectApproval(r, nowMs)),
      );
      return;
    }
    {
      const approve = matchPattern("/api/approvals/:id/approve", path);
      const reject = matchPattern("/api/approvals/:id/reject", path);
      if ((approve || reject) && method === "POST") {
        const cred = authenticateRequest(req, credentials);
        // resolver = the verified acting agent via the brand-guarded accessor
        // (fails closed on a forged credential; never caller-supplied body).
        const resolver = actorOf(cred);
        const id = (approve ?? reject)!["id"]!;
        const body = await readJsonBody(req);
        const reason =
          typeof body["reason"] === "string"
            ? (body["reason"] as string)
            : undefined;
        const rec = await approvalGate.resolveApproval(
          id,
          approve ? "approved" : "rejected",
          resolver,
          reason,
        );
        sendJson(res, 200, projectApproval(rec, Date.now()));
        return;
      }
    }

    // --- secrets read (4.5b — console-only, NOT a catalog tool) -----------
    // HARD INVARIANT: refs/usage only, NEVER a value. Authn-gated like every
    // other read (deny-before-write: authenticate() throws fatal/403 on a
    // missing/invalid credential BEFORE any metadata is touched). No store
    // mutation, no StateEvent, no `resolve()`/`ApplyContext`. Unwrapped
    // `SecretSchema[]` body. Absent dep ⇒ `[]` (backward-compatible).
    if (path === "/api/secrets" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = secrets ? secrets.refs.map((ref) => describeSecret(ref)) : [];
      sendJson(res, 200, items);
      return;
    }

    // --- backups read (5.4 — console-only enriched read, NOT a catalog tool)
    // Same discipline as `/api/secrets`: authn-gated (deny-before-write —
    // authenticate() throws fatal/403 on a missing/invalid credential BEFORE
    // any listing), NO store mutation, NO StateEvent, no `ApplyContext`.
    // Unwrapped contract `BackupEntry[]` body (the console client parses the
    // raw array, NOT a `{status,data}` wrapper). Absent dep ⇒ `[]`
    // (backward-compatible). `BackupEntry` is non-secret operational metadata
    // ONLY (5.3 — the restic password / repo credentials never reach here).
    if (path === "/api/backups" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = backups ? await backups.list() : [];
      sendJson(res, 200, items);
      return;
    }

    // --- health aggregation (6.4 — REAL fold of 6.1/6.2/6.3 signals) ------
    // When the optional `health` seam is wired, `/api/health` returns the
    // genuine aggregated contract `HealthReport` instead of the 4.4 catalog
    // placeholder. Same read discipline as every other read: authn-gated
    // (deny-before-write — authenticate() throws fatal/403 BEFORE snapshot()
    // is ever touched), NO catalog/tool invocation, NO mutation, NO
    // StateEvent, no `ApplyContext`, unwrapped contract `HealthReport` body.
    // The fold is PURE (health.ts) and carries ONLY names/states/counts/
    // timestamps/entity-keys (no secret material by construction). Absent dep
    // ⇒ this block is skipped and the catalog `health` read tool answers
    // (backward-compatible: prior body + its audited StateEvent unchanged).
    if (path === "/api/health" && method === "GET" && health) {
      authenticateRequest(req, credentials);
      const snap = await health.snapshot();
      sendJson(res, 200, aggregateHealth(snap));
      return;
    }

    // --- v2 read: GET /api/v2/firewalls (Task F1.5) -------------------------
    // Lists the working desired-state firewalls (the canonical manifest shape
    // — FirewallSchema[]). Authn-gated like every other read
    // (deny-before-write); NO catalog/tool call, NO mutation, NO StateEvent,
    // unwrapped contract `Firewall[]` body. Returns `[]` when no working
    // store is wired (backward-compatible with callers that don't opt in to
    // F1.4/F1.5).
    if (path === "/api/v2/firewalls" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = setFirewallDeps
        ? await setFirewallDeps.workingStore.list()
        : [];
      sendJson(res, 200, items);
      return;
    }

    // --- v2 read: GET /api/v2/primary-ips (Task F2.5) -----------------------
    // Lists the working desired-state PrimaryIPs (the canonical manifest
    // shape — PrimaryIPSchema[]). Authn-gated like every other read
    // (deny-before-write); NO catalog/tool call, NO mutation, NO StateEvent,
    // unwrapped contract `PrimaryIP[]` body. Returns `[]` when no working
    // store is wired (backward-compatible with callers that don't opt in to
    // F2.4/F2.5). Mirrors the F1.5 firewalls read endpoint verbatim.
    if (path === "/api/v2/primary-ips" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = setPrimaryIpDeps
        ? await setPrimaryIpDeps.workingStore.list()
        : [];
      sendJson(res, 200, items);
      return;
    }

    // --- v2 write: POST /api/v2/firewalls (Task F1.4) -----------------------
    // Wired ONLY when `deps.setFirewall` is supplied. Routes through the
    // SHARED `setFirewall(...)` function (single source of truth with the
    // MCP `set_firewall` tool). Authn gate runs FIRST (deny-before-write —
    // missing/invalid credential ⇒ 403, NO StateEvent, NO approval row);
    // per-capability `set_firewall` scope is enforced inside `setFirewall`.
    if (
      path === "/api/v2/firewalls" &&
      method === "POST" &&
      setFirewallDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: SetFirewallInput = {
        dry_run: asBool(body["dry_run"]),
        firewall: body["firewall"],
      };
      const env: WriteEnvelopeV2 = await setFirewall(
        input,
        { credential: cred, scope: "firewall" },
        setFirewallDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 write: POST /api/v2/primary-ips (Task F2.4) --------------------
    // Wired ONLY when `deps.setPrimaryIp` is supplied. Routes through the
    // SHARED `setPrimaryIp(...)` function (single source of truth with the
    // MCP `set_primary_ip` tool). Authn gate runs FIRST (deny-before-write);
    // per-capability `set_primary_ip` scope is enforced inside
    // `setPrimaryIp` itself. APPROVAL-ALWAYS for every non-no-op (a
    // PrimaryIP is billed even when unassigned).
    if (
      path === "/api/v2/primary-ips" &&
      method === "POST" &&
      setPrimaryIpDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: SetPrimaryIpInput = {
        dry_run: asBool(body["dry_run"]),
        primary_ip: body["primary_ip"],
      };
      const env: WriteEnvelopeV2 = await setPrimaryIp(
        input,
        { credential: cred, scope: "primary_ip" },
        setPrimaryIpDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 read: GET /api/v2/certificates (Task F3.5/F3.6) ----------------
    // Lists the working desired-state Certificates (CertificateSchema[]).
    // Same read discipline as F1.5 / F2.5 — authn-gated, no mutation, no
    // StateEvent. Returns `[]` when no working store is wired.
    if (path === "/api/v2/certificates" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = setCertificateDeps
        ? await setCertificateDeps.workingStore.list()
        : [];
      sendJson(res, 200, items);
      return;
    }

    // --- v2 write: POST /api/v2/certificates (Task F3.5) -------------------
    // Wired ONLY when `deps.setCertificate` is supplied. Routes through the
    // SHARED `setCertificate(...)` function (single source of truth with the
    // MCP `set_certificate` tool). Authn gate runs FIRST
    // (deny-before-write); per-capability `set_certificate` scope is
    // enforced inside `setCertificate`. Approval branching depends on the
    // desired type: managed ⇒ no approval (Hetzner-owned ACME; not
    // destructive); uploaded ⇒ approval-gated (touches a secret).
    if (
      path === "/api/v2/certificates" &&
      method === "POST" &&
      setCertificateDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: SetCertificateInput = {
        dry_run: asBool(body["dry_run"]),
        certificate: body["certificate"],
      };
      const env: WriteEnvelopeV2 = await setCertificate(
        input,
        { credential: cred, scope: "certificate" },
        setCertificateDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 read: GET /api/v2/load-balancers (Task F4.4) -------------------
    // Lists the working desired-state LoadBalancers (LoadBalancerSchema[]).
    // Same read discipline as F1.5 / F2.5 / F3.5 read endpoints. Returns `[]`
    // when no working store is wired.
    if (path === "/api/v2/load-balancers" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = setLoadBalancerDeps
        ? await setLoadBalancerDeps.workingStore.list()
        : [];
      sendJson(res, 200, items);
      return;
    }

    // --- v2 write: POST /api/v2/load-balancers (Task F4.4) -----------------
    // Wired ONLY when `deps.setLoadBalancer` is supplied. Routes through the
    // SHARED `setLoadBalancer(...)` function (single source of truth with the
    // MCP `set_load_balancer` tool). Authn gate runs FIRST
    // (deny-before-write); per-capability `set_load_balancer` scope is
    // enforced inside `setLoadBalancer` itself. APPROVAL ALWAYS for every
    // non-no-op (cost + possible recreation); a location change surfaces as
    // a `recreate` plan op carrying `impact:"public IP will change"`.
    if (
      path === "/api/v2/load-balancers" &&
      method === "POST" &&
      setLoadBalancerDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: SetLoadBalancerInput = {
        dry_run: asBool(body["dry_run"]),
        load_balancer: body["load_balancer"],
      };
      const env: WriteEnvelopeV2 = await setLoadBalancer(
        input,
        { credential: cred, scope: "load_balancer" },
        setLoadBalancerDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 read: GET /api/v2/ingresses (Task F5.3) ------------------------
    // Lists the working desired-state Ingresses (IngressSchema[]). Same read
    // discipline as F1.5 / F2.5 / F3.5 / F4.4 read endpoints — authn-gated,
    // no mutation, no StateEvent. Returns `[]` when no working store is wired.
    if (path === "/api/v2/ingresses" && method === "GET") {
      authenticateRequest(req, credentials);
      const items = setIngressDeps
        ? await setIngressDeps.workingStore.list()
        : [];
      sendJson(res, 200, items);
      return;
    }

    // --- v2 write: POST /api/v2/ingresses (Task F5.3) ----------------------
    // Wired ONLY when `deps.setIngress` is supplied. Routes through the
    // SHARED `setIngress(...)` function (single source of truth with the MCP
    // `set_ingress` tool). Authn gate runs FIRST (deny-before-write);
    // per-capability `set_ingress` scope is enforced inside `setIngress`
    // itself. Approval only on DNS-touch destructive changes (hostname or
    // load_balancer_ref change); fresh ingresses are no-Approval.
    if (
      path === "/api/v2/ingresses" &&
      method === "POST" &&
      setIngressDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: SetIngressInput = {
        dry_run: asBool(body["dry_run"]),
        ingress: body["ingress"],
      };
      const env: WriteEnvelopeV2 = await setIngress(
        input,
        { credential: cred, scope: "ingress" },
        setIngressDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 write: POST /api/v2/expose (Task F6.1) -------------------------
    // Wired ONLY when `deps.exposeService` is supplied. Routes through the
    // SHARED `exposeService(...)` function (single source of truth with the
    // MCP `expose_service` tool). Authn gate runs FIRST (deny-before-write);
    // per-capability `expose_service` scope is enforced inside
    // `exposeService` itself. Bundled approval at the app layer: one
    // approval row covers all three sub-entity writes (cert/lb/ingress).
    if (
      path === "/api/v2/expose" &&
      method === "POST" &&
      exposeServiceDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const input: ExposeServiceInput = {
        dry_run: asBool(body["dry_run"]),
        service: (body["service"] as string) ?? "",
        hostname: (body["hostname"] as string) ?? "",
        tls: (body["tls"] as string) ?? "",
        ...(typeof body["location"] === "string"
          ? { location: body["location"] as string }
          : {}),
      };
      const env: WriteEnvelopeV2 = await exposeService(
        input,
        { credential: cred, scope: "expose" },
        exposeServiceDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 write: POST /api/v2/migrations (Task 7.1) ----------------------
    // Wired ONLY when `deps.runMigrations` is supplied. Routes through the
    // SHARED `runMigrations(...)` function (single source of truth with the
    // MCP `run_migrations` tool). Authn gate runs FIRST (deny-before-write —
    // missing/invalid credential ⇒ 403, NO StateEvent, NO approval row);
    // per-capability `run_migrations` scope is enforced inside
    // `runMigrations`. ALWAYS-SENSITIVE per spec §1.3 — every invocation
    // routes through the Approval Gate (the runner wires its gate with
    // `isSensitive: () => true`). Per-migration failures stay HTTP 200
    // with envelope `status:"applied"` + `report.applied[i].error_code`
    // (spec §2.3 — data, not HTTP failure).
    if (
      path === "/api/v2/migrations" &&
      method === "POST" &&
      runMigrationsDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const env: WriteEnvelopeV2 = await runMigrations(
        body as unknown as RunMigrationsInput,
        { credential: cred, scope: "service" },
        runMigrationsDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 write: POST /api/v2/kube/apply (Bloco E Task 14) ---------------
    // Wired ONLY when `deps.kubectlApply` is supplied. Routes through the
    // SHARED `kubectlApply(...)` function (single source of truth with the MCP
    // `kubectl_apply` tool). Authn gate runs FIRST (deny-before-write —
    // missing/invalid credential ⇒ 403, NO StateEvent, NO approval row);
    // per-capability `kubectl_apply` scope is enforced inside `kubectlApply`.
    // ALWAYS-SENSITIVE — every invocation routes through the Approval Gate.
    if (
      path === "/api/v2/kube/apply" &&
      method === "POST" &&
      kubectlApplyDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const env: WriteEnvelopeV2 = await kubectlApply(
        body as unknown as KubectlApplyInput,
        { credential: cred, scope: "service" },
        kubectlApplyDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 write: POST /api/v2/k3s/ensure (Bloco E Task 23) ---------------
    // Wired ONLY when `deps.ensureK3s` is supplied. Routes through the SHARED
    // `ensureK3s(...)` function (single source of truth with the MCP
    // `ensure_k3s` tool). Authn gate runs FIRST (deny-before-write —
    // missing/invalid credential ⇒ 403, NO StateEvent, NO approval row);
    // per-capability `ensure_k3s` scope is enforced inside `ensureK3s`.
    // ALWAYS-SENSITIVE — every invocation routes through the Approval Gate.
    // INSTALL-ONLY / fail-safe: never uninstall, never auto-upgrade (Q-a).
    if (
      path === "/api/v2/k3s/ensure" &&
      method === "POST" &&
      ensureK3sDeps !== undefined
    ) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const env: WriteEnvelopeV2 = await ensureK3s(
        body as unknown as EnsureK3sInput,
        { credential: cred, scope: "server" },
        ensureK3sDeps,
      );
      const status =
        env.status === "error"
          ? STATUS_BY_CLASS[
              (env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"
            ] ?? 500
          : 200;
      sendJson(res, status, env);
      return;
    }

    // --- v2 read: POST /api/v2/selectors/resolve (Task 0.4) ----------------
    // Read-only selector resolution against the current observed Server[]
    // for `scope` (query param; defaults to the "server" partition the v1
    // `get_state` route also uses). POST (not GET) because the selector body
    // is JSON — same convention v1 `set_*` tools use even with `dry_run=true`.
    //
    // Routed through the SHARED catalog's v2 `resolveSelector` method (NOT
    // the FROZEN 12-tool dispatch): single source of truth across REST/MCP/
    // reconciler. The route adds NO logic — authn-gate FIRST
    // (deny-before-write), then dispatch, then serialize the `ToolResult`
    // `{ status:"ok", data:{ matched } }` as the unwrapped `data` payload
    // (same read-tool serialization v1 reads use).
    if (path === "/api/v2/selectors/resolve" && method === "POST") {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const selector =
        body["selector"] !== undefined &&
        body["selector"] !== null &&
        typeof body["selector"] === "object"
          ? (body["selector"] as SelectorInput)
          : {};
      const scope = url.searchParams.get("scope") ?? "server";
      const result = await catalog.resolveSelector(selector, {
        credential: cred,
        scope,
      });
      sendToolResult(res, result);
      return;
    }

    // --- read endpoints ----------------------------------------------------
    if (method === "GET") {
      const r = READ_ROUTES.find((rt) => rt.pattern === path);
      if (r) {
        const cred = authenticateRequest(req, credentials);
        const input: Record<string, unknown> = {};
        for (const q of r.query ?? []) {
          const v = url.searchParams.get(q);
          if (v !== null) input[q] = v;
        }
        const result = await catalog.executeTool(r.tool, input, {
          credential: cred,
          scope: r.scope,
        });
        sendToolResult(res, result);
        return;
      }
    }

    // --- write endpoints ---------------------------------------------------
    if (method === "POST") {
      for (const r of WRITE_ROUTES) {
        const params = matchPattern(r.pattern, path);
        if (!params) continue;
        const cred = authenticateRequest(req, credentials);
        const body = await readJsonBody(req);
        // Path params are authoritative for the routed resource id; body
        // supplies the rest. The mapping is data (r.pathParams) — no logic.
        const input: Record<string, unknown> = { ...body };
        for (const [seg, key] of Object.entries(r.pathParams ?? {})) {
          if (params[seg] !== undefined) input[key] = params[seg];
        }
        const result = await catalog.executeTool(r.tool, input, {
          credential: cred,
          scope: r.scope,
        });
        sendToolResult(res, result);
        return;
      }
    }

    // --- no route: contract-shaped not-found (still a WriteEnvelope error) -
    sendJson(
      res,
      404,
      errorEnvelope(
        new ReconcileError("fatal", "no such endpoint", { entity: "agent" }),
      ),
    );
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      await route(req, res);
    } catch (err) {
      // Single fail-safe boundary: ANY thrown error (auth deny, body parse,
      // gate precondition, …) becomes the contract `error()` envelope with the
      // mapped status. NEVER leak stack/secret/token — toApiError() drops the
      // cause; a non-ReconcileError collapses to a value-free fatal.
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ReconcileError) {
        sendError(res, err);
        return;
      }
      sendError(
        res,
        new ReconcileError("fatal", "request failed", { entity: "agent" }),
      );
    }
  }

  return {
    handle,
    async listen(port?: number): Promise<number> {
      if (server) {
        const a = server.address() as AddressInfo;
        return a.port;
      }
      const s = createServer((req, res) => {
        void handle(req, res);
      });
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        // Loopback only — never expose beyond localhost (internal control
        // plane; spec §"Não-objetivos": no external UX).
        s.listen(port ?? 0, "127.0.0.1", () => {
          s.off("error", reject);
          resolve();
        });
      });
      return (s.address() as AddressInfo).port;
    },
    async close(): Promise<void> {
      const s = server;
      if (!s) return;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
