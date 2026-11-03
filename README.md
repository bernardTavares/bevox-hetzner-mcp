# bevox-hetzner-mcp

**An agent-native control plane for [Hetzner Cloud](https://www.hetzner.com/cloud/).** AI agents (and humans) can provision and operate the following through MCP tools or a REST API:
- servers, networks and volumes;
- Docker services;
- firewalls, load balancers, certificates and DNS;
- backups.

Every change goes through a declarative desired-state model, a plan you can inspect, and an approval gate for anything destructive or billable.

```
Claude / any MCP agent ──► MCP bridge ──► REST API ──► Approval Gate ──► Reconciler ──► Hetzner Cloud · DNS · Docker · WireGuard · restic
                                                            │                  │
                                                            └──── Postgres: desired / observed state + audit trail
```

> **Status: alpha.** v1 and the v2 public-edge block are complete, with 1,407 tests passing (3 skipped). It ran as the infrastructure control plane for a small production cluster (one daemon on the operator's machine, behind Cloudflare Tunnel and Access). In practice some urgent production changes were still made by hand over SSH, so treat it as a working reference design, not a supported product.

**→ To install it, configure credentials and connect Claude, read [GETTING-STARTED.md](./GETTING-STARTED.md).**

---

## Why this exists

PaaS tools (Coolify, Dokku, Kamal, Nomad) are built for humans clicking through a UI or running a CLI. An AI agent needs something else:
- **declarative desired state** it can read and write;
- **structured plans** it can show you before anything happens;
- **approval gating** with an audit trail;
- **deterministic idempotency**, so retrying is always safe;
- **drift reported, never silently "fixed"**.

This project doesn't reinvent orchestration. It sits on proven primitives (the Hetzner Cloud API, Docker, WireGuard, restic) and reinvents the **interface for agents**.

## How it works

1. **Desired state:** a manifest of what you want (servers, services, DNS…) in Postgres, written by tools or by `apply_manifest`.
2. **Observe:** each cycle re-reads the real state from Hetzner and Docker.
3. **Plan:** a diff of the desired state against the observed state, with an impact estimate. `dry_run: true` stops here.
4. **Gate:** destructive or billable operations become `pending_approval` (with a TTL and a webhook or poll).
5. **Apply → Record:** the change is applied, and an append-only `StateEvent` records the acting agent, its capability scope and the approval.

Running the loop again is how you recover. No failure path deletes a resource you didn't explicitly ask to remove.

## Tools

| Group | Tools | Approval |
|---|---|---|
| Read | `get_state`, `diff`, `events`, `health`, `resolve_selector` | never |
| Low-risk writes | `set_dns`, `snapshot` | never (audited) |
| Workloads | `deploy_service`, `scale_service`, `apply_manifest` | only when the plan is destructive or billable |
| Infrastructure | `provision_server`, `restore`, `destroy` | always |
| Public edge (v2) | `set_firewall`, `set_ingress` | only when the change is destructive (e.g. a hostname or LB swap) |
| Edge, always gated (v2) | `set_certificate`, `set_load_balancer`, `set_primary_ip` | always |
| One-shot exposure (v2) | `expose_service`: certificate + LB + firewall + DNS | one bundled approval |
| Approvals | `list_approvals`, `approve`, `reject` | — |

Each agent gets its own bearer token with an explicit list of the tools it may call. [GETTING-STARTED.md §5](./GETTING-STARTED.md#5-agent-tokens-and-capabilities) has least-privilege recipes.

## What you need

| | |
|---|---|
| **Hetzner** | A Cloud API token (Read & Write). A DNS API token if you manage DNS. An SSH key uploaded to the project. |
| **Server** | Linux with Node.js 20.12+ and Postgres 16. `sops` and `age` for app secrets. |
| **Optional** | A restic repository (backups). Docker on a target host (managed services). Cloudflare Tunnel and Access (remote access). |
| **Client** | Claude Code, Claude Desktop or any MCP client, through the bundled stdio bridge (`core/bin/mcp-stdio-bridge.mjs`). |

A **Cloud-API-only mode** (`MANAGED_MESH=off`, `MANAGED_SERVICES=off`) skips SSH, Docker and WireGuard entirely, for when you run containers yourself (k3s, for example).

## Safety model

- **Fail-safe, never fail-deleting.** No error path removes a resource. A partial apply is recorded and converged on the next cycle.
- **Drift is reported, not corrected.** Changes made outside the tool show up as `drift` events, and you decide what to do.
- **Secrets are resolved only at apply time.** Manifests reference `secret:<name>`. Values come from a sops/age-encrypted file and never appear in plans, logs, events or tool results. Leak-sentinel tests enforce this.
- **Capability-scoped tokens.** Every tool call is authorised against the token's capability list and audited with its actor.
- **Separation of duties.** The actor that requested an approval can never approve or reject it: the server refuses with 403, and the request stays pending. Destructive and billable changes always need a second party, such as a human reviewer token.

**Known limitations (read before production use):**
- **Existing infrastructure.** The daemon doesn't backfill state for resources it didn't create. With empty state, `apply_manifest` plans to create everything, so always `dry_run` first.
- **Single host.** One daemon, no HA. The audit trail lives in Postgres, so back it up.

## Scope

**Shipped:**
- Hetzner Cloud servers, networks, volumes, firewalls, load balancers, primary IPs and managed or uploaded certificates;
- Hetzner DNS;
- Docker services over SSH on a WireGuard mesh;
- restic backups (snapshot, plus a restore that needs approval);
- the composite HTTPS `Ingress`.

**Not in scope:** multi-cloud (Hetzner only, by design), multi-tenancy, billing, predictive autoscaling, and automatic destructive rollback. The roadmap blocks are HA/DR, a policy engine and cost/observability.

## Project layout

```
core/      The control plane: TypeScript, Node 20+, MCP server, REST API, reconciler, providers
  bin/     mcp-stdio-bridge.mjs, the zero-dependency bridge your MCP client launches
console/   Internal operator UI (React + Vite), also the contract oracle for the API
deploy/    Reference deploy: systemd units, Postgres compose, cloudflared, runbooks
docs/      Design specs, implementation plans, manifest cheatsheet
```

Stack: Node.js 20+, TypeScript 5 (strict, ESM), `@modelcontextprotocol/sdk`, PostgreSQL 16, an in-house Hetzner REST client (no SDK), the Docker Engine API over SSH, WireGuard, restic, sops/age, Zod, Pino, Vitest.

## Development

```bash
docker run -d --name hmcp-test-pg -e POSTGRES_USER=core -e POSTGRES_PASSWORD=core \
  -e POSTGRES_DB=bevox_core_test -p 5546:5432 postgres:16
cp core/.env.example core/.env     # set DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test
npm --prefix core install && npm --prefix console install   # core's typecheck also checks the console contract
npm --prefix core run typecheck
npm --prefix core test             # 1,407 passing, 3 skipped (@live tests need real Hetzner tokens)
```

Tests never touch real infrastructure: Hetzner, Docker, SSH and restic all run behind fakes. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow (spec first, TDD, idempotency property tests) and [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

## How this was built

Spec-first and AI-native. Every substantive change started as a design spec in `docs/specs/` and an implementation plan in `docs/superpowers/plans/`. Claude Code subagents then executed the plan under repo-local rules, hooks and reviewer agents (`.claude/`, `CLAUDE.md`), with the test suite as the contract.

The specs, plans and the manifest cheatsheet were written in Portuguese. The code, the API, this README and the getting-started guide are in English.

## License

[Functional Source License 1.1, MIT Future License](./LICENSE.md) (FSL-1.1-MIT). Copyright 2026 Bernard Tavares.

You may use, modify and redistribute it for any purpose except a competing commercial product or service. Each version becomes MIT-licensed two years after its release.
