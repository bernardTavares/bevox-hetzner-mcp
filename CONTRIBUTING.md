# Contributing

Thanks for considering a contribution. This project is an agent-native control
plane for Hetzner Cloud; the design and invariants are non-trivial and the
test suite enforces them rigorously. Please read this guide before opening a
PR.

## Ground rules

1. **Specs come first.** Behavioral changes start as a spec under
   `docs/specs/`. The v1 spec is `2026-05-17-bevox-hetzner-mcp-design.md`; v2
   contract is `2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`. Do
   not change v1 invariants without a new spec revision.
2. **Idempotency by design.** Every provider apply must converge — re-running
   the reconciler is the recovery mechanism. Property tests enforce this; do
   not weaken them.
3. **Fail-safe, never fail-deleting.** No failure path may remove a resource
   the operator did not explicitly ask to remove. Drift is reported, never
   silently corrected.
4. **Secrets resolved at apply only.** `plan` / `dry_run` / logs MUST NEVER
   contain a resolved secret value — only the `secret:<ref>` reference. The
   test suite includes leak-detection sentinels (`S3CR3T-*`) that fail the
   build if a secret leaks anywhere.
5. **Every `StateEvent` records the actor.** No mutation is anonymous.

## Development setup

### Prerequisites

- Node.js 20+
- PostgreSQL 16 (locally or via Docker)
- Docker (for the integration test container; optional otherwise)

### First-time setup

```bash
git clone https://github.com/bernardTavares/bevox-hetzner-mcp.git
cd bevox-hetzner-mcp

# Start a disposable Postgres for integration tests
docker run -d --name bevox-core-test-pg \
  -e POSTGRES_USER=core -e POSTGRES_PASSWORD=core -e POSTGRES_DB=bevox_core_test \
  -p 5546:5432 postgres:16

# Configure the core test env (gitignored)
cat > core/.env <<'EOF'
DATABASE_URL=postgres://core:core@localhost:5546/bevox_core_test
DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test
HCLOUD_TOKEN=stub-not-used-in-tests
HCLOUD_DNS_TOKEN=stub-not-used-in-tests
RESTIC_REPO=stub
RESTIC_PASSWORD=stub
SSH_HOST=stub
SSH_USER=stub
SSH_PRIVATE_KEY=stub
AGENT_CREDENTIALS={"stub-token":{"actor":"agent:stub","capabilities":["health"]}}
EOF

# Install + verify baseline
npm --prefix core install
npm --prefix core test     # expected: 1,407 passing, 3 skipped (@live)
```

### Layout

```
core/                  Agent-native control plane (MCP server + reconciler)
  src/
    domain/            Zod entities + error taxonomy (v1 + v2)
    store/             Postgres observed/working stores, migrations
    providers/         Hetzner / Docker / WG / restic adapters
      v2/              Bloco A (Firewall, LB, Cert, PrimaryIP, Ingress)
    reconciler/        Observe → Plan → Gate → Apply → Record
    agent/             MCP + REST tool surface
      v2/              v2 write tools (set_firewall, set_ingress, expose_service, ...)
  test/fakes/          HTTP fake servers (Hetzner, Docker) — CI never hits real API
  test/e2e/            End-to-end scenarios with fakes
  test/live/           Opt-in real-Hetzner smokes (require operator tokens)

console/               Operational frontend (v1 React SPA) — contract oracle today

deploy/                Production deploy artifacts (systemd units, Docker Compose
                       for Postgres, cloudflared tunnel config, runbook). See
                       deploy/README.md.

docs/
  specs/               Approved design docs (v1, v2 contract, Bloco A spec-filha)
  superpowers/plans/   Implementation plans (subagent-driven execution)
```

## Workflow

1. **Open an issue first** for any non-trivial change. Discuss the design.
2. **Write the spec / plan** for substantive features (`docs/specs/` then
   `docs/superpowers/plans/`).
3. **TDD per task.** Red → minimal green → commit. The repository's test
   suite is the contract; preserve and extend it.
4. **One commit per logical task.** Atomic commits make review and bisection
   sane.
5. **Open a PR** against `main` (`feat/core` was the original integration
   branch and is now merged). Reference the issue / spec / plan in the body.
   Fill in the test plan.
6. **Run the test suite locally** (see README); there is no CI yet:
   - `npm --prefix core test` — full suite green.
   - `npm --prefix core run typecheck` — clean.

## Commit message format

We use Conventional Commits style with a mandatory trailer:

```
feat(core): short summary in imperative mood (task ref if applicable)

Optional longer body explaining the WHY. Wrap at ~72 chars.

Co-Authored-By: <name> <email>
```

Common types: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`.

If a Claude / GPT / Copilot session helped, add the assistant's `Co-Authored-By`
trailer. Honest attribution is required.

## Code style

- TypeScript strict (`NodeNext`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- ESM throughout; `.js` extension on imports of `.ts` sources (per NodeNext).
- Zod for all wire schemas. Cross-package contracts go through the console
  `contract.ts` / `contract-v2.ts` oracle.
- One responsibility per file. If a file grows past ~600 lines or starts
  bundling unrelated concerns, split it.
- Tests live next to source as `<name>.test.ts`. End-to-end and opt-in live
  tests live under `test/e2e/` and `test/live/` respectively.

## Tests never touch real infra

Hetzner Cloud, Docker Engine, SSH hosts, restic, ACME — all of these go
through interface seams. CI runs only against fakes (`core/test/fakes/`).
The `@live` suite is opt-in, manual, pre-release; it requires operator-supplied
tokens (`HETZNER_LIVE_TOKEN`, `HETZNER_LIVE_ZONE`, etc.) and is excluded from
`npm test` via the vitest `unit` project's glob.

## Reporting security issues

See [SECURITY.md](./SECURITY.md). **Do not** open a public issue for a
security report.

## License

By contributing, you agree your contribution will be licensed under the
project's [FSL-1.1-MIT License](./LICENSE.md).
