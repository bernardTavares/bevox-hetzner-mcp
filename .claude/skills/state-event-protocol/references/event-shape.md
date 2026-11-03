# StateEvent — concrete shape and code locations

This reference complements `../SKILL.md`. Use it when you need the
exact field types or the file paths to grep for emitters and consumers.

## 1. Canonical TypeScript shape (today)

Defined in `core/src/domain/entities.ts` as `StateEventSchema` (Zod).
The persisted columns live in `state_events` (migration `001_initial.sql`
plus the additive v2 columns from `002_v2_bloco_a.sql`).

```ts
// Conceptual shape — see core/src/domain/entities.ts for the actual Zod schema.
import { z } from "zod";

export const StateEventSchema = z.object({
  // Append-time identifier (monotonic). Returned by appendEvent → { seq }.
  // Not provided on write; assigned by Postgres BIGSERIAL.
  // seq: z.number().int().positive(),     // (read-side only)

  // RFC3339 timestamp. Defaults to now() on the Postgres side.
  ts: z.string().datetime(),

  // Stable agent or human id. Required; non-empty.
  // Examples:
  //   "agent:openclaw"
  //   "agent:vox"
  //   "agent:human:bernard"
  //   "system"          — periodic reconciler
  //   "system:drift"    — drift detector
  actor: z.string().min(1),

  // Capability scope of the acting agent. Required; non-empty.
  //   For tool-originated mutations: the capability that authorised it
  //     (e.g. "set_firewall", "expose_service").
  //   For system mutations: the subsystem name
  //     (e.g. "reconcile", "drift", "cleanup").
  // NOTE: StateEventSchema marks scope as optional for cross-package
  // contract symmetry with the console oracle, but appendEvent rejects
  // empty values. Always pass a real scope.
  scope: z.string().min(1).optional(),

  // Operation verb. See SKILL.md §3 for the verb table.
  op: z.enum(["create", "update", "delete", "drift", "noop", "apply", "plan"]),

  // "<kind>:<name>" — stable resource identifier.
  // Examples: "server:bevox-app-1", "firewall:web-fw",
  //           "ingress:bevox-web-app", "dns:app.example.com".
  entity: z.string().min(1),

  // State snapshot before the mutation. null for creates.
  // MUST NOT contain resolved secret values. Keep "secret:<ref>" form.
  before: z.unknown().nullable().optional(),

  // State snapshot after the mutation. null for deletes.
  // Same secret rule as before.
  after: z.unknown().nullable().optional(),

  // Outcome. Required; non-empty.
  result: z.enum(["ok", "error", "skipped"]),

  // v2 spec-mãe §2.4 — additive columns (nullable today; populated by Bloco C).
  capability_token_id: z.string().nullable().optional(),
  policy_eval_result: z
    .object({
      violations: z.array(z.unknown()),
      evaluated_at: z.string().datetime(),
    })
    .nullable()
    .optional(),
});

export type StateEvent = z.infer<typeof StateEventSchema>;
```

The actual schema may differ slightly in casing or wrapping — always
treat `core/src/domain/entities.ts` as the source of truth and reconcile
this file to it when in doubt.

## 2. Append API

Defined in `core/src/store/state-events.ts`:

```ts
export type Queryable = Pick<pg.Pool, "query">;
// Both pg.Pool and pg.PoolClient satisfy this — pass a PoolClient to
// enlist the append in an outer BEGIN/COMMIT (see SKILL.md §4).

export interface AppendEventInput {
  actor: string;       // REQUIRED, non-empty
  scope: string;       // REQUIRED, non-empty
  op: string;          // see verb table in SKILL.md §3
  entity: string;      // "<kind>:<name>"
  result: string;      // "ok" | "error" | "skipped"
  ts?: string;         // RFC3339; defaults to now()
  before?: unknown;    // null for creates; no secrets
  after?: unknown;     // null for deletes;  no secrets
}

export async function appendEvent(
  db: Queryable,
  event: AppendEventInput
): Promise<{ seq: number }>;
```

Precondition guards (do NOT relax):

- `actor.trim() === ""` → `ReconcileError("precondition")`
- `scope.trim() === ""` → `ReconcileError("precondition")`
- `result.trim() === ""` → `ReconcileError("precondition")`

## 3. Query API

Same file. Default order is `seq DESC` (newest-first) to match the
`/api/events` console screen.

```ts
export interface QueryEventsFilter {
  actor?: string;        // exact match
  entity?: string;       // exact match
  result?: string;       // exact match
  limit?: number;        // default 200
  order?: "asc" | "desc"; // default "desc"
}

export async function queryEvents(
  pool: pg.Pool,
  filter?: QueryEventsFilter
): Promise<StateEvent[]>;
```

Each returned row is validated via `StateEventSchema.parse` on read.

## 4. Code locations — where to grep

### The single writer (ground rule I5 enforcement)

```bash
core/src/store/state-events.ts            # appendEvent + queryEvents
core/src/store/state-events.test.ts       # precondition + ordering tests
```

Any other `INSERT INTO state_events` SQL is a violation. Detect with:

```bash
rg -n "INSERT\\s+INTO\\s+state_events" core/src/ | rg -v "store/state-events.ts"
```

### Schema and migrations

```bash
core/src/domain/entities.ts                       # StateEventSchema (Zod)
core/src/store/migrations/001_initial.sql         # state_events table (v1)
core/src/store/migrations/002_v2_bloco_a.sql      # +capability_token_id, +policy_eval_result
```

Locate the v2 additive columns:

```bash
rg -n "capability_token_id|policy_eval_result" core/src/store/migrations/
```

### Emitters — where mutations record themselves

Every mutation path calls `appendEvent`. To enumerate emitters:

```bash
# All call sites
rg -n "appendEvent\\(" core/src/

# Reconciler and providers (the bulk of mutations)
rg -l "appendEvent" core/src/reconciler/ core/src/providers/

# v2 tool surface (Bloco A)
rg -l "appendEvent" core/src/agent/v2/
```

### Consumers — who reads the audit trail

```bash
rg -n "queryEvents\\(" core/src/
# Typical consumers: agent/rest.ts (/api/events), agent/mcp.ts
# (events tool), agent/health.ts.
```

### Leak-detection sentinels

```bash
# Sentinel-bearing tests guarantee no secret reaches state_events.
rg -n "S3CR3T-" core/test/ core/src/
```

If the sentinel suite is removed or skipped, ground rule I4 is at risk.

## 5. Common `entity` kinds in this repo

| Kind          | Example entity field              | Defining schema (in domain/) |
|---------------|-----------------------------------|------------------------------|
| `server`      | `server:bevox-app-1`              | `entities.ts`                |
| `network`     | `network:bevox-priv`              | `entities.ts`                |
| `volume`      | `volume:pg-data`                  | `entities.ts`                |
| `service`     | `service:bevox-harness`           | `entities.ts`                |
| `dns`         | `dns:app.example.com`               | `entities.ts`                |
| `backup`      | `backup:pg-data`                  | `entities.ts`                |
| `firewall`    | `firewall:web-fw`                 | `entities-v2.ts`             |
| `load_balancer` | `load_balancer:bevox-web-app`   | `entities-v2.ts`             |
| `certificate` | `certificate:bevox-web-app`       | `entities-v2.ts`             |
| `primary_ip`  | `primary_ip:bevox-app-1-v4`       | `entities-v2.ts`             |
| `ingress`     | `ingress:bevox-web-app`           | `entities-v2.ts`             |

Use the `kind` exactly as the entity is named in its schema file
(snake_case for multi-word kinds, mirroring the v2 collections).

## 6. Worked examples

### Example A — Provider create (Firewall)

```ts
await appendEvent(db, {
  actor: ctx.agentId,           // e.g. "agent:openclaw"
  scope: "set_firewall",
  op: "create",
  entity: `firewall:${fw.name}`,
  before: null,
  after: fw,                    // entity-shape; no secrets
  result: "ok",
});
```

### Example B — Drift report (extra rule observed)

```ts
await appendEvent(db, {
  actor: "system:drift",
  scope: "drift",
  op: "drift",
  entity: `firewall:${fw.name}`,
  before: desired,              // what manifest declared
  after: observed,              // what Hetzner actually has
  result: "ok",                 // drift *reporting* succeeded
});
// NOTE: no provider.delete() — fail-safe (ground rule I3).
```

### Example C — Apply error after partial outbound

```ts
try {
  await hetzner.firewalls.create(body);
  await appendEvent(db, {
    actor: ctx.agentId, scope: "set_firewall",
    op: "create", entity: `firewall:${fw.name}`,
    before: null, after: fw, result: "ok",
  });
} catch (err) {
  await appendEvent(db, {
    actor: ctx.agentId, scope: "set_firewall",
    op: "create", entity: `firewall:${fw.name}`,
    before: null, after: null, result: "error",
  });
  throw err;
}
```

### Example D — Transactional enlistment

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await observedStore.upsert(client, observed);
  await appendEvent(client, {
    actor: ctx.agentId, scope: "reconcile",
    op: "update", entity: `service:${svc.name}`,
    before: prevObserved, after: observed, result: "ok",
  });
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```
