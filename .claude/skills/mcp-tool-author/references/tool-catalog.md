# Tool Catalog Reference

Current state of the bevox-hetzner-mcp tool surface. Derived from
`core/src/agent/capability.ts` (`ALL_TOOLS`, `V2_TOOLS`) and
`core/src/agent/tools.ts` (`TOOL_POLICY`).

If you are adding a tool, your name MUST NOT appear here. If a
similar tool already exists, prefer extending its input shape over
minting a new tool (but only if the spec / contract oracle allows).

---

## V1 catalog — FROZEN (12 tools)

Location: `core/src/agent/`. Single dispatch in `tools.ts`. Console
oracle: `console/src/api/contract.ts`. Conformance test:
`core/src/agent/contract-conformance.test.ts`.

Policy values: `read` (no side effect) · `none` (write, no approval)
· `conditional` (per-call sensitivity predicate) · `always` (every
call gates).

| # | Tool             | Policy        | What it does (one line) |
|---|------------------|---------------|--------------------------|
| 1 | `get_state`      | `read`        | Return the current observed state snapshot per scope. |
| 2 | `diff`           | `read`        | Plan-only diff between desired and observed; emits PlanItems, no apply. |
| 3 | `events`         | `read`        | Return recent StateEvents (paginated, optionally filtered by scope/actor). |
| 4 | `health`         | `read`        | Aggregate provider/reconciler/circuit-breaker health. |
| 5 | `provision_server` | `always`    | Create / update a Hetzner server (always approval-gated). |
| 6 | `deploy_service` | `conditional` | Deploy / update a Docker service on the WG mesh (gate on sensitivity predicate). |
| 7 | `scale_service`  | `conditional` | Change replica count of a service (gate on magnitude/sensitivity). |
| 8 | `set_dns`        | `none`        | Upsert a Hetzner DNS record (idempotent, fail-safe, no approval). |
| 9 | `snapshot`       | `none`        | Trigger a restic snapshot (no approval; restore IS gated). |
|10 | `restore`        | `always`      | Restore from a restic snapshot — overwrites — always gated. |
|11 | `destroy`        | `always`      | Remove a resource explicitly named by the caller — always gated. |
|12 | `apply_manifest` | `conditional` | Apply a desired-state manifest revision (gate per item via TOOL_POLICY). |

Capability vocabulary that maps to these tools is also defined in
`capability.ts`. Read-only credentials cannot reach any of items 5-12.

**Adding a 13th v1 tool requires:**
1. A new spec revision under `docs/specs/`.
2. Update to `console/src/api/contract.ts` (the oracle).
3. Update to `ALL_TOOLS` and `TOOL_POLICY`.
4. Update to `contract-conformance.test.ts` (the 12-tool assertion
   becomes a 13-tool assertion).
5. MCP `server.tool(...)` registration.
6. REST route mirror.

In practice: push back. The v1 surface is intentionally minimal.

---

## V2 catalog — additive Bloco-A (7 tools)

Location: `core/src/agent/v2/`. Each tool has its own file. Console
oracle: `console/src/api/contract-v2.ts`. Conformance test:
`core/src/agent/v2/contract-v2-conformance.test.ts`. Wired by REST
as `POST /api/v2/<tool>` and by MCP via per-tool `enable*` flags.

| # | Tool                | File                                              | Sensitivity wiring | What it does (one line) |
|---|---------------------|---------------------------------------------------|--------------------|--------------------------|
| 1 | `resolve_selector`  | `core/src/agent/v2/resolve-selector.ts`           | read               | Resolve a server selector (labels / names / ids) against observed state — returns matched server set. |
| 2 | `set_firewall`      | `core/src/agent/v2/set-firewall.ts`               | conditional        | Upsert a Hetzner Cloud firewall with rules; attach via selector. |
| 3 | `set_primary_ip`    | `core/src/agent/v2/set-primary-ip.ts`             | always             | Allocate / assign a Primary IP (IPv4/IPv6) — public-edge change, always gated. |
| 4 | `set_certificate`   | `core/src/agent/v2/set-certificate.ts`            | conditional        | Upsert a managed (ACME) or uploaded TLS certificate. |
| 5 | `set_load_balancer` | `core/src/agent/v2/set-load-balancer.ts`          | always             | Upsert a Hetzner Cloud load balancer with services / health checks / targets. |
| 6 | `set_ingress`       | `core/src/agent/v2/set-ingress.ts`                | always             | Composite: Cert + LB + Firewall + DNS, single transactional intent for a public HTTPS hostname. |
| 7 | `expose_service`    | `core/src/agent/v2/expose-service.ts`             | conditional        | Higher-level: expose a Docker service on the public edge (synthesises an Ingress + binds to the service's WG mesh endpoints). |

Supporting infrastructure (not tools, but read when authoring one):

- `core/src/agent/v2/envelope-v2.ts` — v2 envelope helpers.
- `core/src/agent/v2/working-store.ts` — v2 working-state accessors.
- `core/src/reconciler/v2-wrap.ts` — reconciler routing for v2
  entities.

**Adding an 8th v2 tool requires:**
1. Spec-filha (child spec) under `docs/specs/` referencing the v2
   contract.
2. Update to `console/src/api/contract-v2.ts`.
3. Update to `V2_TOOLS` in `capability.ts`.
4. New file `core/src/agent/v2/<tool>.ts`.
5. New file `core/src/agent/v2/<tool>.test.ts`.
6. Update to `contract-v2-conformance.test.ts`.
7. Routing in `core/src/agent/rest.ts` and `core/src/agent/mcp.ts`.

---

## Reading order when authoring

For the most common case — new v2 write tool — read in this order:

1. `core/src/agent/v2/set-firewall.ts` (compact, conditional).
2. `core/src/agent/v2/set-ingress.ts` (composite, multi-provider).
3. `core/src/agent/envelope.ts` and
   `core/src/agent/v2/envelope-v2.ts`.
4. `core/src/agent/v2/contract-v2-conformance.test.ts` — the test
   shape you will extend.
5. `console/src/api/contract-v2.ts` — the oracle. Schemas here ARE
   the contract; the core conforms.

For a v1 extension (rare): start from `core/src/agent/tools.ts` and
read the file header in full. The header is the contract.
