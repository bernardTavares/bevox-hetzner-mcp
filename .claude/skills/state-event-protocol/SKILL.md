---
name: state-event-protocol
description: |
  How to record a StateEvent correctly in bevox-hetzner-mcp. Every
  mutation that converges desired→observed MUST emit one StateEvent.
  Anonymous mutations are forbidden (ground rule I5). Use this skill
  whenever you write a new tool, provider apply path, drift handler,
  reconciler branch, or anything that calls `appendEvent`.
when_to_use: |
  - Implementing a new tool under `core/src/agent/**` that mutates state.
  - Implementing or modifying a `Provider<T>.apply()` body.
  - Adding a new reconciler branch that converges desired vs observed.
  - Adding a drift handler (reporting only — NEVER deletion).
  - Reviewing a PR for ground rule I5 compliance.
  - Debugging "where does this StateEvent come from?" — the inverse
    lookup pattern is in §6 below.
references:
  - references/event-shape.md
---

# Skill: state-event-protocol

## TL;DR

```ts
import { appendEvent } from "../../store/state-events.js";

await appendEvent(db, {
  actor: ctx.agentId,          // REQUIRED, non-empty (e.g. "agent:openclaw")
  scope: ctx.capabilityScope,  // REQUIRED, non-empty (e.g. "set_firewall")
  op: "apply",                 // "create" | "update" | "delete" | "drift" | "noop" | "apply" | "plan"
  entity: "firewall:web-fw",   // "<kind>:<name>" — stable identifier
  before: observed ?? null,    // snapshot before; null on creates
  after:  desired  ?? null,    // snapshot after; null on deletes
  result: "ok",                // "ok" | "error" | "skipped"
  // ts: optional — defaults to now() on the Postgres side
});
```

`db` is any pg `Queryable` — a `pg.Pool` (default) or a
`pg.PoolClient` (transaction-scoped — see §4).

## 1. Why this matters

Ground rule I5 in `CONTRIBUTING.md`: **"Every StateEvent records the
actor. No mutation is anonymous."** The audit trail is the only thing
that answers "who did this, with what scope, when, and what changed".
A mutation without a StateEvent is a bug — even if it succeeds.

The `appendEvent` writer enforces this at runtime:

- `actor` empty/whitespace → `ReconcileError("precondition")`.
- `scope` empty/whitespace → `ReconcileError("precondition")`.
- `result` empty/whitespace → `ReconcileError("precondition")`.

These checks are intentionally strict. Do **not** weaken them. Do
**not** pass `"unknown"`, `"todo"`, or empty strings to satisfy them.

## 2. Required fields — what each one MUST contain

| Field    | Required | Format                                                                                     |
|----------|----------|--------------------------------------------------------------------------------------------|
| `actor`  | yes      | Stable agent or human id. Examples: `agent:openclaw`, `agent:vox`, `agent:human:bernard`, `system` (periodic reconciler), `system:drift` (drift detector). |
| `scope`  | yes      | The capability under which the mutation runs. For tool-originated mutations this is the capability scope from `CapabilityToken` (v2 Bloco C). For system mutations this is the reconciler subsystem name (e.g. `reconcile`, `drift`, `cleanup`). |
| `op`     | yes      | One of: `create`, `update`, `delete`, `drift`, `noop`, `apply`, `plan`. Exact verb depends on context (see §3 verb table). |
| `entity` | yes      | `<kind>:<name>` form. `kind` is the lowercase entity type (`server`, `service`, `firewall`, `certificate`, `ingress`, ...). `name` is the manifest name. Examples: `server:bevox-app-1`, `firewall:web-fw`, `ingress:bevox-web-app`. |
| `result` | yes      | `ok` (success), `error` (mutation failed), `skipped` (intentional no-op, e.g. already-converged). |
| `before` | optional | Snapshot of the observed state before the mutation. `null` for `create`. Pass the entity shape from `domain/entities*.ts`. |
| `after`  | optional | Snapshot after the mutation. `null` for `delete`. For `drift` events use the observed extra state; `after` then describes "what's there that the manifest did not ask for". |
| `ts`     | optional | RFC3339 timestamp. Omit to let Postgres default to `now()`. Only set explicitly in tests or backfills. |

### v2 spec-mãe additive fields (forward-compat)

| Field                  | Status today                                                                | Activated by    |
|------------------------|-----------------------------------------------------------------------------|-----------------|
| `capability_token_id`  | Nullable column added by `002_v2_bloco_a.sql`; written `null` everywhere    | Bloco C         |
| `policy_eval_result`   | Nullable jsonb added by `002_v2_bloco_a.sql`; written `null` everywhere     | Bloco C         |

When Bloco C lands, populate `capability_token_id` from the token used
to authorise the mutation. Until then, leave it `null`. See spec-mãe
§2.4 for the contract.

## 3. Verb table — what `op` to use

| Situation                                                              | `op`     | `result` typical |
|------------------------------------------------------------------------|----------|------------------|
| Provider apply: entity did not exist; created it                       | `create` | `ok`             |
| Provider apply: entity existed; converged a field                      | `update` | `ok`             |
| Provider apply: manifest asked for removal; deleted it                 | `delete` | `ok`             |
| Provider apply: desired == observed; nothing to do                     | `noop`   | `skipped`        |
| Provider apply: HTTP/transient error during convergence                | the verb that was attempted (`create`/`update`/`delete`) | `error` |
| Drift detector: extra observed entity not in manifest                  | `drift`  | `ok`             |
| Drift detector: drift on a field of an existing entity                 | `drift`  | `ok`             |
| Plan stage: computed a plan (informational — usually not persisted unless the spec demands it) | `plan` | `ok` |
| Reconciler: full apply pass over a desired-state snapshot              | `apply`  | `ok` / `error`   |

**Never** use `op: "delete"` for a drift event — drift NEVER deletes
(ground rule I3, fail-safe). Drift only reports.

## 4. Transactional enlistment

`appendEvent` accepts any pg `Queryable`. Pass a `PoolClient` opened
inside a `BEGIN` to commit the row AND its audit event atomically:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await observedStore.upsert(client, observed);
  await appendEvent(client, { actor, scope, op: "update", entity, ... });
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```

When the mutation cannot share a transaction with the audit (e.g. the
mutation is an outbound HTTP call to Hetzner that already happened),
emit the StateEvent immediately after the outbound returns, using the
pool directly. Failure to emit AFTER a successful outbound is a real
audit gap — log it loudly.

## 5. Secrets and payloads — what NOT to put in `before` / `after`

Ground rule I4: **secrets are resolved only at apply, and they leave no
trace in plan/log/observed.** That includes StateEvents.

- Never put a resolved secret value in `before` or `after`. Keep the
  reference form (`secret:<ref>`).
- The leak-detection sentinel suite (`S3CR3T-*`) scans every persisted
  row, including `state_events.before` and `.after`. A test failure
  there means a StateEvent leaked a secret.
- For `Certificate` (uploaded), persist only the `private_key_secret_ref`
  string and a fingerprint — never the PEM material.

## 6. Inverse lookup: "where does this StateEvent come from?"

When debugging a row in the audit trail:

1. Grep for the `entity` string in `core/src/agent/` and
   `core/src/providers/` — every emitter constructs the `entity` field
   directly (no helpers obscure it).
2. Grep for the `op` value together with the entity kind — narrows
   quickly to the responsible `apply()` branch.
3. The single writer is `core/src/store/state-events.ts`; any direct
   `INSERT INTO state_events` outside that file is a ground rule I5
   violation — report and fix.

## 7. Anti-patterns (will fail review)

- Calling `appendEvent` with `actor: "unknown"` or empty.
- Catching the precondition `ReconcileError` to suppress the requirement.
- Emitting `op: "delete"` from a drift handler.
- Putting a secret PEM, SSH key plaintext, or `Authorization` header
  value into `before` / `after`.
- Direct `INSERT INTO state_events` SQL anywhere outside
  `state-events.ts`.
- Emitting a StateEvent with `result: "ok"` after a partial failure.

## 8. Test obligations

A new mutation path must include at least:

- A unit test asserting `appendEvent` is called with the expected
  `actor`, `scope`, `op`, `entity`, `result`.
- A precondition test asserting that an empty `actor` (or omitted
  capability scope upstream) is rejected at the boundary.
- For new providers: the existing leak-sentinel suite must remain green
  (no extra StateEvent payloads start carrying secrets).

## References

- `core/src/store/state-events.ts` — the only writer; canonical contract.
- `core/src/domain/entities.ts` — `StateEventSchema` (Zod).
- `CONTRIBUTING.md` §"Ground rules" — I3, I4, I5 (the three rules this
  skill operationalises).
- `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` — §"Modelo de
  dados" (StateEvent canonical entity).
- `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
  §2.4 — additive `capability_token_id`, `policy_eval_result`.
- `references/event-shape.md` — concrete TypeScript shape + code
  locations to grep.
