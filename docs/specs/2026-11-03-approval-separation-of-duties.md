# Spec — Approval Gate: separation of duties (no self-approval)

- **Date:** 2026-11-03
- **Status:** accepted
- **Touches:** `core/src/agent/approval-gate.ts` (`resolveApproval`). It amends the v1 Approval Gate section of `2026-05-17-bevox-hetzner-mcp-design.md` as an additive invariant. No contract shape changes.

## Problem

`POST /api/approvals/:id/{approve,reject}` (and the bridge's `approve` / `reject` tools) only checks authentication. Any valid credential can resolve any pending approval, **including one whose requester is the same actor**. An agent holding `provision_server` can therefore request a server and approve it itself. That defeats the gate's purpose: destructive and billable operations need a second party.

## Decision

A pending approval **cannot be resolved by the actor that requested it.**

- In `resolveApproval(id, decision, resolver, reason?)`, after the unknown-id check and after the idempotent terminal short-circuit, if `resolver === existing.actor` (the requester), throw `ReconcileError("fatal", "resolveApproval: an approval cannot be resolved by the actor that requested it (separation of duties)", { entity: id })`.
- This applies to **both approve and reject.** A requester that wants to abandon its own request lets it expire (TTL) or withdraws the desired state. It does not resolve its own approval.
- **`fatal` maps to HTTP 403** on REST (authz semantics), the same as a missing capability.
- **No state change on refusal:** no UPDATE, no `StateEvent`, the approval stays `pending`.

## Unchanged

- **Idempotency.** Resolving an already-terminal approval stays a safe no-op for any caller, the requester included. The guard runs only on `pending` rows, so no flapping or re-emission.
- **Expiry.** The poll path `sweepExpired()` (actor `"system"`) is unaffected.
- **Contract.** Approval projection shapes, the TTL and the uniqueness invariant are unchanged.

## Operational consequence

Operators need **at least two distinct actors**: the agent that requests (for example `agent:claude`) and a human or reviewer actor that approves (for example `human:you`). Tokens map to actors through `AGENT_CREDENTIALS`. Two tokens that share one actor name count as the same party.

## Tests

- Self-approve on a pending approval → `ReconcileError` (fatal), still `pending`, no `approved` event.
- Self-reject on a pending approval → refused the same way.
- A different actor can still approve or reject (existing tests).
- A requester resolving an already-terminal approval → idempotent no-op (unchanged).
- REST: the requester's token calling `/approve` on its own approval → 403.
