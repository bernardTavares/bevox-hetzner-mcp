/**
 * core/src/agent/mcp.ts
 *
 * Task 4.7 — the MCP server. A SECOND transport over the EXACT same 4.4 shared
 * tool catalog the REST API (4.5) uses. It owns NO policy: it lists the 12
 * tools (names from the single 4.2 `ALL_TOOLS` source) and routes every
 * `tools/call` through the SINGLE `ToolCatalog.executeTool` with the SAME
 * `ToolContext` (credential + scope) construction REST uses. An MCP `destroy`
 * and a REST `POST /api/destroy` therefore produce the SAME `WriteEnvelope`
 * AND the SAME `StateEvent` — the logic is the shared catalog, never forked.
 *
 * Transport decision (minimal-dep / security-first):
 *   `@modelcontextprotocol/sdk` is ALREADY a ratified runtime dependency
 *   (core/package.json + CLAUDE.md §Stack name it for MCP). No NEW dependency
 *   is introduced — so the faithful path is to wire the SDK's `Server` with
 *   real `ListTools` + `CallTool` request handlers. Tests drive it through the
 *   SDK `Client` over `InMemoryTransport.createLinkedPair()` (in-process, no
 *   stdio/socket race, deterministic) so the protocol-faithful path AND the
 *   REST-vs-MCP parity assertion are both exercised against the same catalog/
 *   pg/approval-gate/clock. (This mirrors Task 0's discipline: prefer the
 *   already-vetted dependency; add nothing new.)
 *
 * Design principles (CLAUDE.md non-negotiables; CONTRACT.md is FROZEN):
 *
 *   - SAME CORE, NO PARALLEL LOGIC. `mcp.ts` is a thin transport: list →
 *     `catalog.executeTool` → serialize. No authz/approval/reconcile/envelope
 *     logic is re-implemented. `dry_run` and approval policy are whatever the
 *     shared catalog already does (never re-decided here).
 *
 *   - TOOL SURFACE = THE 12, EXACTLY. The advertised tool list is derived from
 *     `ALL_TOOLS` (the single 4.2 source — never a second hardcoded list) and
 *     `TOOL_POLICY` (for the description). The per-call reconcile `scope` is a
 *     small DATA table mirroring the frozen CONTRACT.md Tool→scope mapping the
 *     REST routes also use — DATA, not logic (rest.ts uses the identical
 *     mapping in its own ROUTES table; the shared invariant is the single
 *     `ALL_TOOLS` tool vocabulary + the single `executeTool`).
 *
 *   - CREDENTIAL SEAM (4.2) & DENY-BEFORE-WRITE. The agent credential arrives
 *     in the `CallTool` arguments under the reserved `_credential` field (an
 *     opaque token string — the MCP transport's auth carrier), is resolved via
 *     the injected 4.2 `authenticate` seam, and passed through identically to
 *     the SAME `executeTool`. A missing/invalid credential → the SAME
 *     contract-shaped fatal error result REST produces, BEFORE any tool
 *     executes (deny-before-write: no reconcile, no StateEvent, no approval
 *     row). The token is NEVER echoed or logged.
 *
 *   - FAIL-SAFE & NO-LEAK. A tool error is serialized as the SAME contract
 *     `WriteEnvelope.error()` body the catalog produced, surfaced through the
 *     MCP `CallTool` result with `isError:true` (the structured payload in
 *     `structuredContent` + a value-free text mirror). Destructive ops still
 *     go through the 4.3 gate (`pending_approval`) — MCP cannot bypass it.
 *     No stack/secret/token ever reaches a result or a log.
 *
 *   - DRY/YAGNI. ONLY the MCP transport adapter + the 12-tool listing +
 *     dispatch. NO new tools, NO contract change, NO new business logic, NO
 *     new runtime dependency. Minimal exported surface.
 *
 * Exported API (ONLY these — minimal surface):
 *   createMcpServer(deps) → McpServer   — { server, connect, close }
 *   interface McpServer / McpServerDeps
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { authenticate, type CredentialStore } from "./auth.js";
import { ALL_TOOLS, type ToolName, type V2ToolName } from "./capability.js";
import { TOOL_POLICY, type ToolCatalog, type ToolResult } from "./tools.js";
import { error as errorEnvelope, type WriteEnvelope } from "./envelope.js";
import { ReconcileError } from "../domain/errors.js";
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

// ---------------------------------------------------------------------------
// Dependencies / public types
// ---------------------------------------------------------------------------

export interface McpServerDeps {
  /** The SINGLE 4.4 shared tool catalog (REST/MCP both call this — no fork). */
  readonly catalog: ToolCatalog;
  /** The 4.2 credential resolution seam (injected; v1 in-memory store). */
  readonly credentials: CredentialStore;
  /**
   * Opt-in v2 tools to advertise (Task 0.4 introduced this seam; F1.4
   * generalised it from a single boolean to a set as the second v2 tool
   * landed). Each name listed appears in `tools/list` IN ADDITION to the
   * FROZEN 12 and becomes callable via `tools/call`.
   *
   * BACKWARD-COMPAT: defaults to an empty set — the FROZEN 12-tool listing
   * assertion (mcp.test.ts §"lists EXACTLY the 12 ALL_TOOLS tools") and the
   * 4.6 contract-conformance oracle stay byte-for-byte intact for every
   * prior caller. v2 tools ONLY appear when explicitly opted in.
   */
  readonly v2Tools?: ReadonlySet<V2ToolName>;
  /**
   * Deps for the v2 `set_firewall` tool. Required iff `v2Tools` contains
   * `"set_firewall"`; otherwise unused. Kept separate from the catalog so
   * the v1 catalog surface is unchanged.
   */
  readonly setFirewall?: SetFirewallDeps;
  /**
   * Deps for the v2 `set_primary_ip` tool (Task F2.4). Required iff
   * `v2Tools` contains `"set_primary_ip"`; otherwise unused. Approval-always
   * (a PrimaryIP is billed even when unassigned) — see set-primary-ip.ts.
   */
  readonly setPrimaryIp?: SetPrimaryIpDeps;
  /**
   * Deps for the v2 `set_certificate` tool (Task F3.5). Required iff
   * `v2Tools` contains `"set_certificate"`; otherwise unused. Approval
   * branching is type-based (managed ⇒ no approval; uploaded ⇒ approval).
   * See set-certificate.ts.
   */
  readonly setCertificate?: SetCertificateDeps;
  /**
   * Deps for the v2 `set_load_balancer` tool (Task F4.4). Required iff
   * `v2Tools` contains `"set_load_balancer"`; otherwise unused. APPROVAL
   * ALWAYS for every non-no-op (cost + possible recreation); a location
   * change surfaces as a `recreate` plan op carrying the
   * `impact:"public IP will change"` note. See set-load-balancer.ts.
   */
  readonly setLoadBalancer?: SetLoadBalancerDeps;
  /**
   * Deps for the v2 `set_ingress` tool (Task F5.3). Required iff `v2Tools`
   * contains `"set_ingress"`; otherwise unused. Approval branching is
   * DNS-touch-based: a hostname change OR a load_balancer_ref change ⇒
   * Approval (destructive: existing A/AAAA records become stale). A fresh
   * ingress (no prior working desired) ⇒ no Approval (consistent with v1
   * `set_dns`). See set-ingress.ts.
   */
  readonly setIngress?: SetIngressDeps;
  /**
   * Deps for the v2 `expose_service` tool (Task F6.1). Required iff
   * `v2Tools` contains `"expose_service"`; otherwise unused. Bundled approval
   * at the app layer: the tool synthesises three sub-entities
   * (certificate + load_balancer + ingress) sharing a canonical slug
   * `<service>-<first-dns-label-of-hostname>` and writes them under ONE
   * approval (the v1 gate stays 1:1 with one wrapper PlanItem). Callers MUST
   * construct `approvalGate` with `isSensitive: () => true`.
   */
  readonly exposeService?: ExposeServiceDeps;
  /**
   * Deps for the v2 `run_migrations` tool (Task 7.2). Required iff
   * `v2Tools` contains `"run_migrations"`; otherwise unused. ALWAYS-SENSITIVE
   * per spec §1.3 — callers MUST construct `approvalGate` with
   * `isSensitive: () => true` (DDL/DML on a live database is destructive by
   * category, regardless of SQL contents). See run-migrations.ts.
   */
  readonly runMigrations?: RunMigrationsDeps;
  /**
   * Deps for the v2 `kubectl_apply` tool (Bloco E Task 14). Required iff
   * `v2Tools` contains `"kubectl_apply"`; otherwise unused. ALWAYS-SENSITIVE —
   * applying a manifest to a live cluster is destructive by category, so
   * callers MUST construct `approvalGate` with `isSensitive: () => true`. The
   * named `host` resolves SERVER-SIDE (Q-c: the SSH key never travels in input);
   * the target namespace must already exist (Q-d: never created). See
   * kubectl-apply.ts.
   */
  readonly kubectlApply?: KubectlApplyDeps;
  /**
   * Deps for the v2 `ensure_k3s` tool (Bloco E Task 23). Required iff `v2Tools`
   * contains `"ensure_k3s"`; otherwise unused. ALWAYS-SENSITIVE — installing k3s
   * on a live host is destructive by category, so callers MUST construct
   * `approvalGate` with `isSensitive: () => true`. The named `host` resolves
   * SERVER-SIDE (Q-c: the SSH key never travels in input). INSTALL-ONLY /
   * fail-safe: never uninstall, never auto-upgrade (Q-a). See ensure-k3s.ts.
   */
  readonly ensureK3s?: EnsureK3sToolDeps;
}

export interface McpServer {
  /** The underlying MCP SDK server (advanced use / introspection). */
  readonly server: Server;
  /** Bind a transport (e.g. stdio in prod, in-memory pair in tests). */
  connect(transport: Transport): Promise<void>;
  /** Close the bound transport (no-op if never connected). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool → reconcile scope — DATA mirroring the FROZEN CONTRACT.md mapping.
//
// This is the SAME `<kind>` partition rest.ts threads into the `ToolContext`
// from its own ROUTES table (server/service/dns/volume/manifest). It is DATA,
// not logic; the shared invariants are the single `ALL_TOOLS` vocabulary and
// the single `executeTool` dispatch — both honoured below. Keyed over EVERY
// `ALL_TOOLS` entry so the list can never silently drift from the 12.
// ---------------------------------------------------------------------------

const TOOL_SCOPE: Readonly<Record<ToolName, string>> = {
  get_state: "server",
  diff: "server",
  events: "server",
  health: "server",
  provision_server: "server",
  deploy_service: "service",
  scale_service: "service",
  set_dns: "dns",
  snapshot: "volume",
  restore: "volume",
  destroy: "server",
  apply_manifest: "manifest",
};

/** The reserved CallTool argument carrying the opaque agent credential token. */
const CREDENTIAL_FIELD = "_credential";

// ---------------------------------------------------------------------------
// Tool list — derived from the SINGLE `ALL_TOOLS` source (never hardcoded)
//
// The catalog (4.4) owns all input validation/shaping (rest.ts likewise passes
// raw bodies straight through), so the advertised inputSchema is the permissive
// open object the contract tools accept; the policy is surfaced in the
// description so an agent knows whether a call may yield `pending_approval`.
// ---------------------------------------------------------------------------

/** The v2 read-only tool name (NOT in the FROZEN 12; only listed when wired). */
const V2_RESOLVE_SELECTOR = "resolve_selector";
const V2_SET_FIREWALL = "set_firewall";
const V2_SET_PRIMARY_IP = "set_primary_ip";
const V2_SET_CERTIFICATE = "set_certificate";
const V2_SET_LOAD_BALANCER = "set_load_balancer";
const V2_SET_INGRESS = "set_ingress";
const V2_EXPOSE_SERVICE = "expose_service";
const V2_RUN_MIGRATIONS = "run_migrations";
const V2_KUBECTL_APPLY = "kubectl_apply";
const V2_ENSURE_K3S = "ensure_k3s";

function listToolsResult(v2Tools: ReadonlySet<V2ToolName>): ListToolsResult {
  // Typed permissively to admit BOTH the FROZEN 12 (whose names are pulled
  // from the `ALL_TOOLS` literal tuple) and the additive v2 tool name —
  // without leaking `ToolName` widening anywhere else in the file.
  const tools: ListToolsResult["tools"] = ALL_TOOLS.map((name) => ({
    name: name as string,
    description:
      `bevox control-plane tool "${name}" (approval policy: ` +
      `${TOOL_POLICY[name]}). Mutating tools return a contract ` +
      `WriteEnvelope; reads return the contract entity/state/events/health ` +
      `shape — identical to the REST transport (shared core).`,
    inputSchema: {
      type: "object" as const,
      // The shared catalog validates/normalises the actual input; the
      // credential token rides under the reserved `_credential` field.
      properties: {
        [CREDENTIAL_FIELD]: {
          type: "string",
          description:
            "Opaque agent credential token (4.2 auth seam). Required; " +
            "resolved server-side, never echoed.",
        },
      },
      additionalProperties: true,
    },
  }));
  // v2 tools are advertised SEPARATELY from the FROZEN 12 (the
  // contract-conformance oracle + the existing "exactly 12 tools" mcp test
  // are byte-for-byte unaffected when the v2 seam is absent).
  if (v2Tools.has("resolve_selector")) {
    tools.push({
      name: V2_RESOLVE_SELECTOR,
      description:
        `bevox v2 read-only tool "${V2_RESOLVE_SELECTOR}" — resolves a ` +
        `{ label, name, ... } selector against the current observed ` +
        `Server[] and returns { matched: string[] } (sorted, deterministic). ` +
        `No approval, no mutation. Same source as POST ` +
        `/api/v2/selectors/resolve.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          selector: {
            type: "object",
            description:
              "Selector object. Recognised keys: `label` (string — required " +
              "label-key presence), `name` (string — exact match). Additional " +
              "keys are treated as further required label-key presences. " +
              "Multiple keys are AND-ed.",
          },
          scope: {
            type: "string",
            description:
              "Observed-state partition to read (defaults to 'server').",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("set_firewall")) {
    tools.push({
      name: V2_SET_FIREWALL,
      description:
        `bevox v2 write tool "${V2_SET_FIREWALL}" — apply a desired Firewall ` +
        `(create or update). Removing a rule from a firewall applied to ≥1 ` +
        `active server requires approval (destructive). Returns a v2 ` +
        `WriteEnvelope (planned | pending_approval | applied | error). ` +
        `Same source as POST /api/v2/firewalls.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          firewall: {
            type: "object",
            description: "The desired Firewall (parsed via FirewallSchema).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("set_certificate")) {
    tools.push({
      name: V2_SET_CERTIFICATE,
      description:
        `bevox v2 write tool "${V2_SET_CERTIFICATE}" — apply a desired ` +
        `Certificate (create or update). Approval branching is type-based: ` +
        `managed certs (Hetzner-owned ACME) are NOT approval-gated; ` +
        `uploaded certs (operator-supplied PEM + secret-ref key) are ` +
        `approval-gated on every non-no-op (touches a secret). Returns a v2 ` +
        `WriteEnvelope. Same source as POST /api/v2/certificates.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          certificate: {
            type: "object",
            description:
              "The desired Certificate (parsed via CertificateSchema).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("set_load_balancer")) {
    tools.push({
      name: V2_SET_LOAD_BALANCER,
      description:
        `bevox v2 write tool "${V2_SET_LOAD_BALANCER}" — apply a desired ` +
        `LoadBalancer (create or update). APPROVAL ALWAYS for every ` +
        `non-no-op: an LB is a billed Hetzner resource, and a location ` +
        `change forces a destroy+create (the plan surfaces a single ` +
        `recreate op carrying impact:"public IP will change"). Returns a v2 ` +
        `WriteEnvelope. Same source as POST /api/v2/load-balancers.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          load_balancer: {
            type: "object",
            description:
              "The desired LoadBalancer (parsed via LoadBalancerSchema).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("set_ingress")) {
    tools.push({
      name: V2_SET_INGRESS,
      description:
        `bevox v2 write tool "${V2_SET_INGRESS}" — apply a desired Ingress ` +
        `(composite: certificate + load-balancer + firewall + DNS). Approval ` +
        `is required ONLY for DNS-touch destructive changes (hostname change ` +
        `or load_balancer_ref change — existing A/AAAA records become stale). ` +
        `A brand-new Ingress is no-Approval (consistent with v1 set_dns). ` +
        `Returns a v2 WriteEnvelope. Same source as POST /api/v2/ingresses.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          ingress: {
            type: "object",
            description: "The desired Ingress (parsed via IngressSchema).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("expose_service")) {
    tools.push({
      name: V2_EXPOSE_SERVICE,
      description:
        `bevox v2 write tool "${V2_EXPOSE_SERVICE}" — expose a service ` +
        `publicly under one hostname. Synthesises three sub-entities ` +
        `(certificate when tls="managed" + load_balancer + ingress) sharing ` +
        `a canonical slug "<service>-<first-dns-label-of-hostname>" and ` +
        `writes them under ONE bundled approval. Returns a v2 ` +
        `WriteEnvelope. Same source as POST /api/v2/expose.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          service: {
            type: "string",
            description: "Logical service name (LB target / ingress selector).",
          },
          hostname: {
            type: "string",
            description: "Public FQDN the LB terminates TLS for.",
          },
          tls: {
            type: "string",
            description:
              '"managed" ⇒ synthesise a managed Certificate; any other ' +
              "string is treated as an existing certificate reference to reuse.",
          },
          location: {
            type: "string",
            description: "Hetzner location for the LB (defaults to fsn1).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("run_migrations")) {
    tools.push({
      name: V2_RUN_MIGRATIONS,
      description:
        `bevox v2 write tool "${V2_RUN_MIGRATIONS}" — apply a list of SQL ` +
        `migrations against a target Postgres service. ALWAYS APPROVAL: ` +
        `DDL/DML on a live database is destructive by category, regardless ` +
        `of SQL contents (spec §1.3). Per-migration failures stay envelope ` +
        `status:"applied" with report.applied[i].error_code (spec §2.3 — ` +
        `data, not transport failure). Same source as POST ` +
        `/api/v2/migrations.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          target_service: {
            type: "string",
            description: "Logical service name of the target Postgres container.",
          },
          database: {
            type: "string",
            description: "Target database name inside the Postgres instance.",
          },
          migrations: {
            type: "array",
            description: "Ordered list of { filename, sql } migration entries.",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("kubectl_apply")) {
    tools.push({
      name: V2_KUBECTL_APPLY,
      description:
        `bevox v2 write tool "${V2_KUBECTL_APPLY}" — apply a Kubernetes/k3s ` +
        `manifest to a live cluster via \`kubectl apply -f -\` (NEVER --prune). ` +
        `ALWAYS APPROVAL: applying a manifest to a live cluster is destructive ` +
        `by category. The named "host" resolves SERVER-SIDE (the SSH key never ` +
        `travels in input); the target "namespace" must already exist (it is ` +
        `never created). The "body" may carry secret:<ref> tokens, resolved ` +
        `ONLY at apply behind the unforgeable ApplyContext. Same source as ` +
        `POST /api/v2/kube/apply.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          host: {
            type: "string",
            description:
              "Named reference to a server-side SSH host config (Q-c). The " +
              "credential/key is NEVER carried in this input.",
          },
          apiVersion: { type: "string", description: "k8s apiVersion." },
          kind: { type: "string", description: "k8s kind." },
          metadata: {
            type: "object",
            description: "k8s metadata; { name } is required for identity.",
          },
          namespace: {
            type: "string",
            description: "Target namespace (must already exist; never created).",
          },
          body: {
            type: "string",
            description:
              "The opaque k8s document piped to `kubectl apply -f -`.",
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("ensure_k3s")) {
    tools.push({
      name: V2_ENSURE_K3S,
      description:
        `bevox v2 write tool "${V2_ENSURE_K3S}" — ensure k3s is installed on a ` +
        `live host (INSTALL-ONLY). ALWAYS APPROVAL: installing k3s on a live ` +
        `host is destructive by category. The named "host" resolves SERVER-SIDE ` +
        `(the SSH key never travels in input). Typed recipe only (host/version/ ` +
        `role) — no arbitrary command (D7). FAIL-SAFE: k3s present at a ` +
        `different version reports DRIFT and is NEVER auto-upgraded/reinstalled ` +
        `(Q-a); there is NO uninstall path. Same source as POST ` +
        `/api/v2/k3s/ensure.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          host: {
            type: "string",
            description:
              "Named reference to a server-side SSH host config (Q-c). The " +
              "credential/key is NEVER carried in this input.",
          },
          version: {
            type: "string",
            description: "Desired k3s version channel/tag (e.g. v1.30.2+k3s1).",
          },
          role: {
            type: "string",
            description: '"server" (control-plane) or "agent" (worker).',
          },
        },
        additionalProperties: true,
      },
    });
  }
  if (v2Tools.has("set_primary_ip")) {
    tools.push({
      name: V2_SET_PRIMARY_IP,
      description:
        `bevox v2 write tool "${V2_SET_PRIMARY_IP}" — apply a desired ` +
        `PrimaryIP (create or assignment update). APPROVAL ALWAYS for every ` +
        `non-no-op: a PrimaryIP is billed even when unassigned, so even a ` +
        `fresh allocation requires approval. Returns a v2 WriteEnvelope ` +
        `(planned | pending_approval | applied | error). Same source as ` +
        `POST /api/v2/primary-ips.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          [CREDENTIAL_FIELD]: {
            type: "string",
            description:
              "Opaque agent credential token (4.2 auth seam). Required.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, returns a `planned` envelope; writes NO desired-state.",
          },
          primary_ip: {
            type: "object",
            description:
              "The desired PrimaryIP (parsed via PrimaryIPSchema).",
          },
        },
        additionalProperties: true,
      },
    });
  }
  return { tools };
}

// ---------------------------------------------------------------------------
// ToolResult → MCP CallToolResult (the SAME contract payload REST serializes)
// ---------------------------------------------------------------------------

/**
 * Serialize a shared-catalog `ToolResult` onto an MCP `CallToolResult`. The
 * STRUCTURED payload is byte-identical to what REST puts in its HTTP body:
 *   - read tools  → the unwrapped contract entity/state/events/health shape;
 *   - write tools → the 4.1 `WriteEnvelope` verbatim.
 * An `error` envelope sets `isError:true` (the body STAYS the contract
 * envelope). The text block is a no-leak JSON mirror (the same value-free
 * contract payload — toErrorEnvelope/envelope already stripped any secret).
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  const payload: unknown =
    result.status === "ok"
      ? (result as { data: unknown }).data
      : (result as WriteEnvelope);
  const isError =
    result.status !== "ok" && (result as WriteEnvelope).status === "error";
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/** A contract-shaped fatal error result (no-leak) for the MCP error channel. */
function fatalResult(err: unknown): CallToolResult {
  const env: WriteEnvelope =
    err instanceof ReconcileError
      ? errorEnvelope(err)
      : errorEnvelope(
          new ReconcileError("fatal", "request failed", { entity: "agent" }),
        );
  return {
    content: [{ type: "text", text: JSON.stringify(env) }],
    structuredContent: env as unknown as Record<string, unknown>,
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// createMcpServer
// ---------------------------------------------------------------------------

export function createMcpServer(deps: McpServerDeps): McpServer {
  const { catalog, credentials } = deps;
  const v2Tools: ReadonlySet<V2ToolName> =
    deps.v2Tools ?? new Set<V2ToolName>();
  let bound: Transport | undefined;

  const server = new Server(
    { name: "bevox-hetzner-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    listToolsResult(v2Tools),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    // --- v2 read-only tool: resolve_selector --------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch (this name is NOT in
    // ALL_TOOLS). Routes through the SHARED `catalog.resolveSelector` so
    // REST/MCP/reconciler all share one resolution path. Authn-gated like
    // every other call (deny-before-write).
    if (name === V2_RESOLVE_SELECTOR && v2Tools.has("resolve_selector")) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const selector =
        args["selector"] !== undefined &&
        args["selector"] !== null &&
        typeof args["selector"] === "object"
          ? (args["selector"] as SelectorInput)
          : {};
      const scope =
        typeof args["scope"] === "string" ? (args["scope"] as string) : "server";
      try {
        const result = await catalog.resolveSelector(selector, {
          credential,
          scope,
        });
        return toCallToolResult(result);
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: set_firewall ----------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `setFirewall(...)` function (single source of truth with REST
    // `POST /api/v2/firewalls`). Authn-gated like every other call
    // (deny-before-write); per-capability `set_firewall` scope is enforced
    // by `setFirewall` itself.
    if (
      name === V2_SET_FIREWALL &&
      v2Tools.has("set_firewall") &&
      deps.setFirewall
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: SetFirewallInput = {
        dry_run: args["dry_run"] === true,
        firewall: args["firewall"],
      };
      try {
        const env = await setFirewall(
          input,
          { credential, scope: "firewall" },
          deps.setFirewall,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: set_primary_ip --------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `setPrimaryIp(...)` function (single source of truth with REST
    // `POST /api/v2/primary-ips`). Authn-gated like every other call
    // (deny-before-write); per-capability `set_primary_ip` scope is enforced
    // by `setPrimaryIp` itself. APPROVAL ALWAYS for every non-no-op.
    if (
      name === V2_SET_PRIMARY_IP &&
      v2Tools.has("set_primary_ip") &&
      deps.setPrimaryIp
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: SetPrimaryIpInput = {
        dry_run: args["dry_run"] === true,
        primary_ip: args["primary_ip"],
      };
      try {
        const env = await setPrimaryIp(
          input,
          { credential, scope: "primary_ip" },
          deps.setPrimaryIp,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: set_certificate -------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `setCertificate(...)` function (single source of truth with REST
    // `POST /api/v2/certificates`). Authn-gated like every other call
    // (deny-before-write); per-capability `set_certificate` scope is enforced
    // by `setCertificate` itself. Approval branching is type-based: managed
    // ⇒ no approval; uploaded ⇒ approval-gated.
    if (
      name === V2_SET_CERTIFICATE &&
      v2Tools.has("set_certificate") &&
      deps.setCertificate
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: SetCertificateInput = {
        dry_run: args["dry_run"] === true,
        certificate: args["certificate"],
      };
      try {
        const env = await setCertificate(
          input,
          { credential, scope: "certificate" },
          deps.setCertificate,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: set_load_balancer -----------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `setLoadBalancer(...)` function (single source of truth with REST
    // `POST /api/v2/load-balancers`). Authn-gated like every other call
    // (deny-before-write); per-capability `set_load_balancer` scope is
    // enforced by `setLoadBalancer` itself. APPROVAL ALWAYS for every
    // non-no-op (cost + possible recreation).
    if (
      name === V2_SET_LOAD_BALANCER &&
      v2Tools.has("set_load_balancer") &&
      deps.setLoadBalancer
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: SetLoadBalancerInput = {
        dry_run: args["dry_run"] === true,
        load_balancer: args["load_balancer"],
      };
      try {
        const env = await setLoadBalancer(
          input,
          { credential, scope: "load_balancer" },
          deps.setLoadBalancer,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: set_ingress -----------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `setIngress(...)` function (single source of truth with REST
    // `POST /api/v2/ingresses`). Authn-gated like every other call
    // (deny-before-write); per-capability `set_ingress` scope is enforced by
    // `setIngress` itself. Approval only on DNS-touch destructive changes
    // (hostname or load_balancer_ref change); fresh ingresses are no-Approval.
    if (
      name === V2_SET_INGRESS &&
      v2Tools.has("set_ingress") &&
      deps.setIngress
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: SetIngressInput = {
        dry_run: args["dry_run"] === true,
        ingress: args["ingress"],
      };
      try {
        const env = await setIngress(
          input,
          { credential, scope: "ingress" },
          deps.setIngress,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: expose_service --------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `exposeService(...)` function (single source of truth with REST
    // `POST /api/v2/expose`). Authn-gated like every other call
    // (deny-before-write); per-capability `expose_service` scope is enforced
    // by `exposeService` itself. App-layer bundle: one approval covers three
    // sub-entity writes (cert/lb/ingress) under the wrapper entity
    // `expose:<slug>`.
    if (
      name === V2_EXPOSE_SERVICE &&
      v2Tools.has("expose_service") &&
      deps.exposeService
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      const input: ExposeServiceInput = {
        dry_run: args["dry_run"] === true,
        service: (args["service"] as string) ?? "",
        hostname: (args["hostname"] as string) ?? "",
        tls: (args["tls"] as string) ?? "",
        ...(typeof args["location"] === "string"
          ? { location: args["location"] as string }
          : {}),
      };
      try {
        const env = await exposeService(
          input,
          { credential, scope: "expose" },
          deps.exposeService,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: run_migrations --------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `runMigrations(...)` function (single source of truth with REST
    // `POST /api/v2/migrations`). Authn-gated like every other call
    // (deny-before-write); per-capability `run_migrations` scope is enforced
    // by `runMigrations` itself. ALWAYS-SENSITIVE per spec §1.3 — every
    // invocation routes through the Approval Gate; per-migration failures
    // surface as envelope `status:"applied"` + `report.applied[i].error_code`.
    if (
      name === V2_RUN_MIGRATIONS &&
      v2Tools.has("run_migrations") &&
      deps.runMigrations
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      // Strip the credential carrier; pass the rest of args as the input
      // (the runner's Zod schema does the actual parse/validation).
      const { [CREDENTIAL_FIELD]: _omit, ...input } = args;
      void _omit;
      try {
        const env = await runMigrations(
          input as unknown as RunMigrationsInput,
          { credential, scope: "service" },
          deps.runMigrations,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: kubectl_apply ---------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `kubectlApply(...)` function (single source of truth with REST
    // `POST /api/v2/kube/apply`). Authn-gated like every other call
    // (deny-before-write); per-capability `kubectl_apply` scope is enforced by
    // `kubectlApply` itself. ALWAYS-SENSITIVE — every invocation routes through
    // the Approval Gate; the named `host` resolves server-side (Q-c) and the
    // target namespace must already exist (Q-d).
    if (
      name === V2_KUBECTL_APPLY &&
      v2Tools.has("kubectl_apply") &&
      deps.kubectlApply
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      // Strip the credential carrier; pass the rest of args as the input
      // (the tool's Zod schema does the actual parse/validation).
      const { [CREDENTIAL_FIELD]: _omit, ...input } = args;
      void _omit;
      try {
        const env = await kubectlApply(
          input as unknown as KubectlApplyInput,
          { credential, scope: "service" },
          deps.kubectlApply,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // --- v2 write tool: ensure_k3s ------------------------------------------
    // Out-of-band of the FROZEN 12-tool dispatch. Routes through the SHARED
    // `ensureK3s(...)` function (single source of truth with REST
    // `POST /api/v2/k3s/ensure`). Authn-gated like every other call
    // (deny-before-write); per-capability `ensure_k3s` scope is enforced by
    // `ensureK3s` itself. ALWAYS-SENSITIVE — every invocation routes through the
    // Approval Gate; the named `host` resolves server-side (Q-c). INSTALL-ONLY /
    // fail-safe: never uninstall, never auto-upgrade (Q-a).
    if (
      name === V2_ENSURE_K3S &&
      v2Tools.has("ensure_k3s") &&
      deps.ensureK3s
    ) {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const rawToken = args[CREDENTIAL_FIELD];
      const token = typeof rawToken === "string" ? rawToken : "";
      let credential;
      try {
        credential = authenticate(credentials, token);
      } catch (err) {
        return fatalResult(err);
      }
      // Strip the credential carrier; pass the rest of args as the input
      // (the tool's Zod schema does the actual parse/validation).
      const { [CREDENTIAL_FIELD]: _omit, ...input } = args;
      void _omit;
      try {
        const env = await ensureK3s(
          input as unknown as EnsureK3sInput,
          { credential, scope: "server" },
          deps.ensureK3s,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(env) }],
          structuredContent: env as unknown as Record<string, unknown>,
          ...(env.status === "error" ? { isError: true } : {}),
        };
      } catch (err) {
        return fatalResult(err);
      }
    }
    // Unknown tool: the shared catalog itself returns the contract fatal
    // envelope (single source of truth) — route it through too, no fork.
    if (!(ALL_TOOLS as readonly string[]).includes(name)) {
      const result = await catalog.executeTool(name, {}, {
        // Safe by invariant: tools.ts `executeTool` checks `TOOL_NAME_SET`
        // and returns the fatal envelope for an unknown tool BEFORE it
        // destructures `ctx` (i.e. before `credential` is ever read or any
        // authz/side effect). No real credential exists on this path (no
        // validated CREDENTIAL_FIELD contract for unknown tools), so we pass
        // `undefined`; the `as never` only satisfies the non-optional
        // `ToolContext.credential` type for a value the catalog provably
        // never observes here. Routing through the shared catalog (vs a local
        // fork) keeps the fatal envelope a single source of truth / REST==MCP.
        credential: undefined as never,
        scope: "server",
      });
      return toCallToolResult(result);
    }
    const tool = name as ToolName;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // --- credential seam (4.2) — deny-before-write -------------------------
    // Extract the opaque token from the reserved field, resolve via the SAME
    // injected `authenticate` seam REST uses. A missing/invalid credential →
    // the SAME contract fatal error, BEFORE executeTool runs (no tool
    // executes ⇒ no reconcile, no StateEvent, no approval row). The token is
    // never echoed/logged; it is dropped from the input handed to the catalog.
    const rawToken = args[CREDENTIAL_FIELD];
    const token = typeof rawToken === "string" ? rawToken : "";
    let credential;
    try {
      // authenticate() throws fatal on empty/unknown token — identical to the
      // REST bearer path; the message never reveals which tokens exist.
      credential = authenticate(credentials, token);
    } catch (err) {
      return fatalResult(err);
    }

    // Strip the credential carrier so it never reaches the catalog input,
    // any reconcile/desired-state write, or any echoed result.
    const { [CREDENTIAL_FIELD]: _omit, ...input } = args;
    void _omit;

    // --- the SINGLE shared dispatch (same path REST uses) ------------------
    // executeTool never throws (every failure is a contract error envelope);
    // the surrounding try is a defensive no-leak fail-safe boundary only.
    try {
      const result = await catalog.executeTool(tool, input, {
        credential,
        scope: TOOL_SCOPE[tool],
      });
      return toCallToolResult(result);
    } catch (err) {
      return fatalResult(err);
    }
  });

  return {
    server,
    async connect(transport: Transport): Promise<void> {
      if (bound) return;
      bound = transport;
      await server.connect(transport);
    },
    async close(): Promise<void> {
      if (!bound) return;
      bound = undefined;
      await server.close();
    },
  };
}
