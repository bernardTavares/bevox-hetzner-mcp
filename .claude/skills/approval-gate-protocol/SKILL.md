---
name: approval-gate-protocol
description: |
  The Approval Gate lifecycle for destructive and cost-bearing operations in
  bevox-hetzner-mcp. Use when planning, implementing, reviewing, or debugging
  any code that creates, resolves, or expires approvals — i.e. anything under
  `core/src/agent/approval-gate*` and any reconciler code that calls into the
  gate. Defines the canonical state machine, TTL semantics, webhook + poll
  resolution paths, and the actor-capture invariant required by
  `CONTRIBUTING.md` §"Ground rules" #5 and the v1 spec
  (`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`).
---

# Skill: approval-gate-protocol

## When to use

Invoke this skill whenever the work touches the Approval Gate. Concretely:

- Implementing or modifying `core/src/agent/approval-gate.ts` (or its tests).
- Adding a new "sensitive" operation that should require approval before
  `apply()` mutates real infrastructure.
- Wiring the webhook resolution path (`resolveApproval`) into a new
  transport (REST endpoint, MCP tool, console UI).
- Wiring the poll fallback (`sweepExpired`) into a new scheduler.
- Reviewing a PR that adds a destructive or cost-bearing operation to the
  reconciler.

## Core lifecycle

A pending approval has exactly four possible states:

```
                       (webhook: decision = "approved")
        +---------------------------------------------+
        |                                             v
   [pending] ---(webhook: decision = "rejected")---> [rejected]
        |                                              \
        |                                               > terminal as
        |                                              /   "cancelled"
        +----(poll: sweepExpired() past TTL)--------> [expired]
                                                       (terminal as
                                                        "cancelled")
```

The **terminal storage state** for a `pending` that did not become
`approved` is `cancelled` — covering both an explicit reject and a TTL
expiry. The contract-v2 envelope projects this terminal state back to the
operator as `"rejected"`; core never widens that contract. See
`core/src/agent/approval-gate.ts` (the file header comments are canonical)
and `references/lifecycle.md` in this skill folder for the full diagram.

## Resolution paths

Two — and only two — paths transition a pending out of `pending`:

1. **Webhook (preferred): `resolveApproval(id, decision, actor)`.** Called
   when the human / agent reviewer decides explicitly. Captures the
   resolving `actor` on the `StateEvent`. Idempotent — resolving an already-
   terminal approval is a no-op (no second event, no state churn).
2. **Poll fallback: `sweepExpired()`.** Called by a scheduler. Expires every
   pending whose `expires_at` is past `now()`. The actor recorded on the
   resulting event is `"system"`.

Both paths emit a `StateEvent` capturing the actor; per CONTRIBUTING #5, no
mutation is anonymous.

**Separation of duties (spec `2026-11-03-approval-separation-of-duties`).**
The webhook path refuses (`ReconcileError("fatal")` → REST 403) when the
resolver is the same actor that requested the approval — for approve AND
reject. Checked after the terminal short-circuit (idempotency unchanged) and
before any write (no UPDATE, no event; the record stays `pending`). Tests that
exercise resolution must use a reviewer actor distinct from the requester.

## TTL semantics

- **Default TTL: 24 hours** (`DEFAULT_TTL_MS = 24 * 60 * 60 * 1000` in
  `core/src/agent/approval-gate.ts`).
- **Configurable** via `createApprovalGate({ ttlMs })`. Must be a positive,
  finite number; the factory throws on misconfiguration so a non-positive TTL
  cannot silently expire approvals instantly.
- **Clock is injected** (`now()` is a dependency). Tests use a deterministic
  fake clock; production wires real `Date.now`.

## Non-stalling property

A pending approval does NOT stall the reconcile cycle. The sensitive item
stays in `pending`; non-sensitive items in the same plan are applied
normally. Each subsequent cycle re-evaluates: once the approval flips to
`approved`, the next cycle picks the item up and applies it. There is no
"approval blocks the world" semantics.

## Actor capture (CONTRIBUTING #5)

Every transition is paired with a `StateEvent` carrying an actor:

| Transition | Actor source |
|---|---|
| `null → pending` (create) | The agent that submitted the plan triggering the gate. |
| `pending → approved` (webhook) | The reviewer passed to `resolveApproval`. |
| `pending → rejected` (webhook) | The reviewer passed to `resolveApproval`. |
| `pending → cancelled` via expiry (poll) | `"system"`. |

No path may insert a row without also recording the event. The DB INSERT and
the event write are atomic so a terminal/pending row without an audit event
cannot exist.

## Uniqueness invariant

At most one OPEN (`pending`) approval per `(scope, op, entity)` triple. This
is enforced at the database level by a partial unique index
(`status = 'pending'`). The factory uses `ON CONFLICT … DO NOTHING` to make
creation idempotent: re-submitting a plan with the same sensitive item
reuses the existing pending rather than spawning duplicates.

## Fail-safe interaction

The Approval Gate does **not** convert a withheld item into a destroy /
rollback. Per `.claude/rules/fail-safe.md`, a withheld item is left as
desired state in `pending`; the underlying resource is not touched. There is
no "approval timed out → destroy what was created" path.

## Code locations

Verified to exist on inspection of the working tree:

- `core/src/agent/approval-gate.ts` — factory, lifecycle, TTL, sweep,
  resolution. Canonical doc-comment at the top of the file.
- `core/src/agent/approval-gate.test.ts` — full lifecycle + idempotency
  tests.
- `core/src/store/db.test.ts` — partial unique index assertions.
- Spec: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` ("Approval Gate"
  section).

## Reference

For the full ASCII state machine, TTL defaults table, and the canonical
sequence diagrams for webhook vs poll resolution, see
[`references/lifecycle.md`](references/lifecycle.md).
