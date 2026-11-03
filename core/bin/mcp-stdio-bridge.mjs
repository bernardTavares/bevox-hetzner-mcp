#!/usr/bin/env node
/**
 * core/bin/mcp-stdio-bridge.mjs
 *
 * Thin MCP-over-stdio bridge that proxies tool calls to the bevox-hetzner-mcp
 * daemon's REST API. The daemon (`npm --prefix core start`) only exposes REST
 * today; this bridge is what an MCP client (e.g. Claude Desktop) spawns to
 * talk to a remote (or local) daemon as if it were a local stdio MCP server.
 *
 * Env:
 *   BEVOX_REST_URL    - default http://localhost:8787 — the daemon's REST root.
 *   BEVOX_AGENT_TOKEN - REQUIRED — the bearer token (matches one of the keys
 *                       in AGENT_CREDENTIALS the daemon loaded). Capabilities
 *                       and the StateEvent actor are derived from this token.
 *   BEVOX_CF_ACCESS_CLIENT_ID     - OPTIONAL — Cloudflare Access service token
 *                                   client id. When set together with the secret,
 *                                   sent as `CF-Access-Client-Id` header so the
 *                                   request is allowed by an Access policy that
 *                                   includes this service token (non_identity).
 *   BEVOX_CF_ACCESS_CLIENT_SECRET - OPTIONAL — paired secret; sent as
 *                                   `CF-Access-Client-Secret`. Required only if
 *                                   the daemon is behind Cloudflare Access. Both
 *                                   must be set together — having only one is
 *                                   treated as misconfiguration.
 *
 * Run manually for debugging:
 *   BEVOX_REST_URL=http://server:8787 BEVOX_AGENT_TOKEN=... \
 *     node core/bin/mcp-stdio-bridge.mjs
 *
 * Behind Cloudflare Access:
 *   BEVOX_REST_URL=https://hetzner-mcp.example.com BEVOX_AGENT_TOKEN=... \
 *     BEVOX_CF_ACCESS_CLIENT_ID=... BEVOX_CF_ACCESS_CLIENT_SECRET=... \
 *     node core/bin/mcp-stdio-bridge.mjs
 *
 * No build step; pure ESM, only @modelcontextprotocol/sdk (already in core's
 * deps). Run from the core/ directory (so node_modules resolves) or set
 * --experimental-import-meta-resolve and absolute paths.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const REST_URL = (process.env.BEVOX_REST_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const TOKEN = process.env.BEVOX_AGENT_TOKEN;
if (!TOKEN) {
  process.stderr.write("FATAL: BEVOX_AGENT_TOKEN env is required\n");
  process.exit(1);
}
// Cloudflare Access service-token headers. Both required together OR neither
// (asymmetric config almost always means a typo and would silently fail at edge).
const CF_ACCESS_CLIENT_ID = process.env.BEVOX_CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.BEVOX_CF_ACCESS_CLIENT_SECRET;
if (Boolean(CF_ACCESS_CLIENT_ID) !== Boolean(CF_ACCESS_CLIENT_SECRET)) {
  process.stderr.write(
    "FATAL: BEVOX_CF_ACCESS_CLIENT_ID and BEVOX_CF_ACCESS_CLIENT_SECRET must be set together (or both unset).\n",
  );
  process.exit(1);
}
const CF_ACCESS_ENABLED = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET);

/**
 * Dispatch table: MCP tool name -> { method, urlFor(args), bodyFor(args), description }.
 * urlFor / bodyFor must be pure functions of the parsed args object.
 * isWrite is informational only — both reads and writes go through fetch().
 */
const TOOLS = {
  // ── v1 reads ──
  get_state: {
    description: "Return the observed + desired state snapshot.",
    method: "GET",
    urlFor: () => `/api/state`,
  },
  diff: {
    description: "Diff working desired state vs observed (no apply). Args: { source?: 'working'|'git' }.",
    method: "GET",
    urlFor: (a) => `/api/diff${a?.source ? `?source=${encodeURIComponent(a.source)}` : ""}`,
  },
  events: {
    description: "Query the StateEvent audit trail. Args: { actor?, entity?, result? }.",
    method: "GET",
    urlFor: (a) => {
      const q = new URLSearchParams();
      if (a?.actor) q.set("actor", a.actor);
      if (a?.entity) q.set("entity", a.entity);
      if (a?.result) q.set("result", a.result);
      const s = q.toString();
      return `/api/events${s ? `?${s}` : ""}`;
    },
  },
  health: {
    description: "Aggregated health: circuit breakers, degraded entities, drift, reconciler.",
    method: "GET",
    urlFor: () => `/api/health`,
  },

  // ── v1 writes ──
  provision_server: { description: "Create/adjust a Hetzner server (+ private net).", method: "POST", urlFor: () => `/api/servers` },
  deploy_service: { description: "Create/update a Docker service (containers).", method: "POST", urlFor: () => `/api/services` },
  scale_service: {
    description: "Adjust replicas of a service. Args MUST include { name, replicas, dry_run? }.",
    method: "POST",
    urlFor: (a) => `/api/services/${encodeURIComponent(a?.name ?? "")}/scale`,
    bodyFor: (a) => ({ replicas: a?.replicas, dry_run: a?.dry_run }),
  },
  set_dns: { description: "Upsert a DNS record (non-destructive).", method: "POST", urlFor: () => `/api/dns` },
  snapshot: {
    description: "Take a restic backup snapshot for a target. Args MUST include { target }.",
    method: "POST",
    urlFor: (a) => `/api/backups/${encodeURIComponent(a?.target ?? "")}/snapshot`,
    bodyFor: () => ({}),
  },
  restore: {
    description: "Restore a restic snapshot (DESTRUCTIVE, gated). Args MUST include { target, snapshot_id }.",
    method: "POST",
    urlFor: (a) => `/api/backups/${encodeURIComponent(a?.target ?? "")}/restore`,
    bodyFor: (a) => ({ snapshot_id: a?.snapshot_id, dry_run: a?.dry_run }),
  },
  destroy: { description: "Remove a server/service/volume (DESTRUCTIVE, gated).", method: "POST", urlFor: () => `/api/destroy` },
  apply_manifest: { description: "Reconcile the full manifest against observed (idempotent).", method: "POST", urlFor: () => `/api/apply` },

  // ── v1 approvals lifecycle ──
  list_approvals: { description: "List pending/resolved approval requests.", method: "GET", urlFor: () => `/api/approvals` },
  approve: {
    description: "Approve a pending approval. Args MUST include { approval_id }.",
    method: "POST",
    urlFor: (a) => `/api/approvals/${encodeURIComponent(a?.approval_id ?? "")}/approve`,
    bodyFor: () => ({}),
  },
  reject: {
    description: "Reject a pending approval. Args MUST include { approval_id, reason? }.",
    method: "POST",
    urlFor: (a) => `/api/approvals/${encodeURIComponent(a?.approval_id ?? "")}/reject`,
    bodyFor: (a) => ({ reason: a?.reason }),
  },

  // ── v2 Bloco A ──
  resolve_selector: { description: "Resolve a server/service selector to the matched entity names.", method: "POST", urlFor: () => `/api/v2/selectors/resolve` },
  set_firewall: { description: "Declare a v2 Firewall (allow-list; applies to backend Servers via selector).", method: "POST", urlFor: () => `/api/v2/firewalls` },
  set_primary_ip: { description: "Declare a v2 PrimaryIP (cost-billed, always Approval-gated).", method: "POST", urlFor: () => `/api/v2/primary-ips` },
  set_certificate: { description: "Declare a v2 Certificate (managed=ACME / uploaded=PEM+secret).", method: "POST", urlFor: () => `/api/v2/certificates` },
  set_load_balancer: { description: "Declare a v2 LoadBalancer (Approval always; location change is destructive).", method: "POST", urlFor: () => `/api/v2/load-balancers` },
  set_ingress: { description: "Declare a v2 Ingress (composite: Cert+LB+Firewall+DNS).", method: "POST", urlFor: () => `/api/v2/ingresses` },
  expose_service: { description: "Convenience: expose a Service publicly under HTTPS (one bundled approval).", method: "POST", urlFor: () => `/api/v2/expose` },
};

// Build the MCP `tools/list` reply once.
const TOOL_LIST = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  // Permissive — daemon does the real Zod parse. Keeps the bridge small.
  inputSchema: { type: "object", additionalProperties: true },
}));

async function callRest(method, path, args) {
  const url = `${REST_URL}${path}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  if (CF_ACCESS_ENABLED) {
    init.headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
    init.headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
  }
  if (method !== "GET" && method !== "DELETE") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args ?? {});
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  // Return a structured payload — MCP clients render JSON tool results natively.
  return { status: res.status, ok: res.ok, body };
}

const server = new Server(
  { name: "bevox-hetzner-mcp-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  const tool = TOOLS[name];
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  try {
    const path = tool.urlFor(args);
    const body = tool.bodyFor ? tool.bodyFor(args) : args;
    const result = await callRest(tool.method, path, body);
    const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2);
    return {
      isError: !result.ok,
      content: [{ type: "text", text: `HTTP ${result.status} ${tool.method} ${path}\n\n${text}` }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `bridge error calling ${name}: ${err?.message ?? String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `bevox-hetzner-mcp bridge connected (REST=${REST_URL}` +
    (CF_ACCESS_ENABLED ? `, CF-Access=enabled` : ``) +
    `)\n`,
);
