# bevox-hetzner-mcp

An **agent-native control plane** for [Hetzner Cloud](https://www.hetzner.com/cloud/).
Lets AI agents (and humans) provision and operate servers, networks, volumes,
containers, certificates, load balancers, DNS, and backups through a
declarative desired-state model exposed as MCP tools and a REST API.

> **Status: alpha (first production deployment shipped).** v1 core
> (Fases 1–6) + v2 Bloco A (public edge) are complete with 897/898 tests
> green. A reference deployment runs behind Cloudflare Tunnel + Access on
> a single host — see [`deploy/README.md`](./deploy/README.md). Durable
> working state, the operational console UI, and Blocos B/C/D (HA/DR,
> identity/policy, observability/cost) are on the roadmap.

## Why this exists

PaaS-style tools (Coolify, Dokku, Kamal, Nomad) target human operators
through a UI. They do not expose the operations programmatically with the
fidelity an AI agent needs: declarative desired state, structured plans,
approval gating with audit, deterministic idempotency, fail-safe drift.

`bevox-hetzner-mcp` is a thin **control plane on top of proven primitives**
(Hetzner Cloud API, Docker, WireGuard, restic). It does not reinvent
orchestration. It reinvents the *interface for agents*.

## What it gives you

- **Declarative desired state.** Manifest YAML in git, working state in
  Postgres, observed state re-read from Hetzner every cycle.
- **Idempotent reconciler.** Observe → Plan → Gate → Apply → Record. Re-running
  is recovery. Drift is reported, never silently corrected.
- **Fail-safe.** No failure path deletes a resource the operator did not
  explicitly request to remove.
- **MCP server + REST API.** One shared 12-tool catalog (v1) + 7 additional
  v2 tools for the public edge.
- **Approval Gate.** Destructive and cost-bearing operations route through a
  pending-approval lifecycle (TTL, webhook, poll fallback).
- **Capability-scoped credentials.** Every `StateEvent` records the acting
  agent and the effective scope.
- **Secrets never leak.** Resolved only at apply, behind an unforgeable
  apply-context token, never in plans / logs / observed state.

## Quick start

```bash
git clone https://github.com/bernardTavares/bevox-hetzner-mcp.git
cd bevox-hetzner-mcp

# Start a disposable Postgres for tests
docker run -d --name bevox-core-test-pg \
  -e POSTGRES_USER=core -e POSTGRES_PASSWORD=core -e POSTGRES_DB=bevox_core_test \
  -p 5546:5432 postgres:16

# Configure core/.env (template in core/.env.example)
cp core/.env.example core/.env
# edit core/.env: set DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test
#                 and (optional) real Hetzner tokens for live operations.

# Install + run the suite
npm --prefix core install
npm --prefix core test   # 897/898 green, 1 @live skipped
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full developer setup.

## Architecture (one line per layer)

```
Agent (OpenClaw, Vox, Claude Code, custom)
  └─→ Agent Interface (MCP + REST, capability-scoped)
        └─→ Approval Gate (TTL, webhook, poll fallback)
              └─→ State Store (git YAML canonical + Postgres working/observed)
                    └─→ Reconciler (Observe → Plan → Gate → Apply → Record)
                          └─→ Providers (HetznerCloud, HetznerDNS, Docker-over-SSH,
                                          WireGuard, restic + v2: Firewall, LB,
                                          Certificate, PrimaryIP, Ingress)
```

Full design lives in
[`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`](./docs/specs/2026-05-17-bevox-hetzner-mcp-design.md)
(v1) and
[`docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`](./docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
(v2 contract).

## What's in scope (and what's not)

**In scope (v1 + v2 Bloco A, shipped):**

- Hetzner Cloud servers, networks, volumes, firewalls, load balancers,
  primary IPs, managed/uploaded certificates.
- Hetzner DNS upsert.
- Docker containers on a WireGuard private mesh.
- restic backups (snapshot + approval-gated restore).
- Public HTTPS ingress (`Ingress` composite: Cert + LB + Firewall + DNS).
- MCP server + REST API + capability scopes + approval lifecycle.

**Out of scope (v1) — planned for later blocos:**

- Multi-cloud (Hetzner only — by design).
- Multi-tenant, billing, end-user UX.
- Predictive autoscaling (reactive scaling via `scale_service` is in v1).
- Rich web UI for end users (an internal operational console exists).
- Automatic destructive rollback.
- PolicyEngine (Bloco C), durable cost estimation (Bloco D), HA/DR
  primitives (Bloco B).

## Project layout

```
core/      Agent-native control plane (TypeScript, Node 20+)
console/   Internal operational frontend (React + Vite) — contract oracle today
deploy/    Production deploy artifacts: systemd units, Docker Compose for
           Postgres, cloudflared tunnel config, runbook (see deploy/README.md)
docs/
  specs/                   Approved design docs
  superpowers/plans/       Implementation plans (subagent-driven execution)
```

## Stack

Node.js 20+, TypeScript 5 (ESM `NodeNext`, `strict`), `@modelcontextprotocol/sdk`,
PostgreSQL 16 (`pg`), Hetzner Cloud REST (in-house client, no SDK dep), Docker
Engine API over SSH, WireGuard, restic, Zod, Pino, Vitest.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Substantive changes start with a
spec under `docs/specs/`; the test suite is the contract — preserve and
extend it. TDD, atomic commits, fail-safe by default.

## Security

See [SECURITY.md](./SECURITY.md). Do not file security issues publicly.

## How this was built

Spec-first and AI-native. Every substantive change started as a design spec in
`docs/specs/` and an implementation plan in `docs/superpowers/plans/`. The plan
was then executed by Claude Code subagents under repo-local rules, hooks and
reviewer agents (see `.claude/` and `CLAUDE.md`), with the test suite as the
contract. The specs and plans were originally written in Portuguese; the code,
API and this README are in English.

## License

[Functional Source License 1.1, MIT Future License](./LICENSE.md) (FSL-1.1-MIT).
Copyright 2026 Bernard Tavares.

You can use, modify and redistribute it for any purpose except a competing
commercial product or service. Each version automatically becomes MIT-licensed
two years after its release.
