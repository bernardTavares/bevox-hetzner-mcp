# Approval Gate — Lifecycle Reference

Canonical source: `core/src/agent/approval-gate.ts` (header comment block)
and `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` ("Approval Gate").
This file restates the contract for quick reference inside the
`approval-gate-protocol` skill.

## State machine (ASCII)

```
                  ┌───────────────────────────────────────────┐
                  │                                           │
                  │  create (sensitive item withheld by plan) │
                  │                                           │
                  ▼                                           │
              ┌─────────┐                                     │
              │ pending │◀────────────────────────────────────┘
              └────┬────┘            (re-plan reuses the same
                   │                  pending — uniqueness on
                   │                  (scope, op, entity))
                   │
   ┌───────────────┼───────────────────────────┐
   │               │                           │
   │ webhook       │ webhook                   │ poll
   │ approve       │ reject                    │ sweepExpired()
   │               │                           │ (now > expires_at)
   ▼               ▼                           ▼
┌──────────┐  ┌───────────┐                ┌───────────┐
│ approved │  │ rejected  │                │ expired   │
└──────────┘  │ (stored:  │                │ (stored:  │
              │ cancelled)│                │ cancelled)│
              └───────────┘                └───────────┘

                  ▲                              ▲
                  │ contract-v2 projection:      │
                  │   "cancelled" → "rejected"   │
                  │   to the agent surface       │
                  └──────────────────────────────┘
```

Notes:

- The on-disk terminal label for both `rejected` and `expired` is
  `"cancelled"`. The contract-v2 envelope projects it as `"rejected"` on the
  external surface; do not widen the contract.
- `pending → approved` and `pending → cancelled` are the only terminal
  transitions. There is no `approved → pending` or `cancelled → pending`.
- Resolving an already-terminal approval (double webhook delivery, webhook
  arriving after expiry sweep) is a no-op and emits no extra event.

## TTL defaults

| Setting | Value | Source |
|---|---|---|
| `DEFAULT_TTL_MS` | `24 * 60 * 60 * 1000` (24h) | `core/src/agent/approval-gate.ts` |
| Override | `createApprovalGate({ ttlMs })` | factory option |
| Validation | must be positive + finite | factory throws otherwise |
| Clock | injected `now()` | enables deterministic tests |

## Webhook resolution sequence

```
 Agent / Reviewer            REST/MCP                Approval Gate            StateEvent store
        │                       │                          │                          │
        │ POST /approvals/:id   │                          │                          │
        ├──────────────────────▶│                          │                          │
        │                       │ resolveApproval(id,      │                          │
        │                       │   "approved", actor)     │                          │
        │                       ├─────────────────────────▶│                          │
        │                       │                          │ UPDATE … WHERE status='pending'
        │                       │                          │ (idempotent — 0 rows if already terminal)
        │                       │                          ├─────────────────────────▶│
        │                       │                          │                          │ INSERT event
        │                       │                          │                          │ { actor, decision, id }
        │                       │                          │◀─────────────────────────┤
        │                       │◀─────────────────────────│                          │
        │◀──────────────────────│ 200 OK                   │                          │
```

## Poll resolution sequence (TTL expiry)

```
 Scheduler              Approval Gate            StateEvent store
     │                       │                          │
     │ tick (e.g. cron)      │                          │
     ├──────────────────────▶│                          │
     │  sweepExpired()       │                          │
     │                       │ SELECT pending WHERE     │
     │                       │   expires_at < now()     │
     │                       │ for each row: UPDATE     │
     │                       │   status='cancelled',    │
     │                       │   reason='expired'       │
     │                       ├─────────────────────────▶│
     │                       │                          │ INSERT event
     │                       │                          │ { actor: "system",
     │                       │                          │   reason: "expired", id }
     │                       │◀─────────────────────────│
     │ count of expired      │                          │
     │◀──────────────────────│                          │
```

## Code locations (verified)

| Concern | File |
|---|---|
| Factory + lifecycle | `core/src/agent/approval-gate.ts` |
| Lifecycle tests | `core/src/agent/approval-gate.test.ts` |
| Uniqueness (partial index) | `core/src/store/db.test.ts` |
| Spec | `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` (Approval Gate) |
| External contract projection | `core/src/agent/v2/envelope-v2.ts` (rejected/cancelled mapping) |

## Quick invariants checklist

- [ ] Exactly one OPEN `pending` per `(scope, op, entity)`.
- [ ] Every state transition writes a `StateEvent` with a non-null actor.
- [ ] Creation INSERT and "pending_approval" event are atomic (same tx).
- [ ] `ttlMs` is validated positive + finite at factory construction.
- [ ] Sweep uses the injected clock — never `Date.now()` directly inside the
      gate logic.
- [ ] Resolving a terminal row is a no-op (no second event).
- [ ] Withheld sensitive items do NOT stall the reconcile cycle.
- [ ] A withheld / expired item is NEVER converted into a destroy.
