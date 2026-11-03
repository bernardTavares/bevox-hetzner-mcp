---
name: state-event-actor
glob: "core/src/{reconciler,store,agent}/**/*.ts"
priority: 1
---

# state-event-actor

Every state mutation persists a `StateEvent` with an `actor` field. No
mutation is anonymous.

## Actor format

The `actor` field is a colon-prefixed identifier identifying the responsible
party:

- `agent:openclaw` — OpenClaw runtime agent.
- `agent:vox` — Vox runtime agent.
- `agent:claude-code` — Claude Code session.
- `agent:<other>` — any other automated agent (must be declared).
- `agent:human:<name>` — a human operator acting through the console or REST
  API.

A `StateEvent` written without an actor, or with an empty / `unknown` /
`system` actor, is a contract violation.

## ApplyContext carries the actor

The reconciler's `ApplyContext` (the unforgeable token threaded from the
agent layer down to the provider's `apply`) MUST carry the resolved actor.
Providers MUST NOT synthesize an actor locally — they take what
`ApplyContext` gives them and propagate it into the emitted `StateEvent`.

## Scope of this rule

The rule applies to all files under:

- `core/src/reconciler/` — Observe → Plan → Gate → Apply → Record.
- `core/src/store/` — observed and working state stores, including the
  `state_events` table writer.
- `core/src/agent/` — MCP server and REST API entry points where the actor
  is resolved from capability-scoped credentials.

## Reference

CONTRIBUTING §"Ground rules" #5: "Every `StateEvent` records the actor. No
mutation is anonymous."

The capability-scoped credential model is specified in `2026-05-17 v1 design`
(Agent Interface section) and reaffirmed in `2026-05-20 v2 contract`.

## Enforcement

`/audit-invariants` greps the diff for `StateEvent` writes and rejects any
write site that does not provide an actor sourced from `ApplyContext`. Tests
under `core/src/store/` include sentinels that fail the build if a
`StateEvent` row lands with a null or `unknown` actor.
