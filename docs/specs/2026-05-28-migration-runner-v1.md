# bevox-hetzner-mcp — Migration runner v1 (`run_migrations` tool)

- **Data:** 2026-05-28
- **Status:** Aceita (2026-05-28)
- **Autor:** Bernard (brainstorm desta sessão Claude Code)
- **Tipo:** Spec-filha v2 (additive to V2_TOOLS — 8th v2 tool). NÃO altera v1 FROZEN.
- **Spec-mãe (v2 contract FROZEN):** [2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md). Esta spec realiza um additive — V2_TOOLS passa de 7 → 8.
- **Motivação concreta:** [bevox-harness — go-live spec §6.2](../../../code/bevox-harness/docs/superpowers/specs/2026-05-28-go-live-via-hetzner-mcp.md) — daemon não tem tool de migration; workaround é SSH manual. Esta spec fecha o caveat.
- **Invariantes v1 preservadas:** ALL_TOOLS (12) FROZEN byte-identical; fail-safe nunca fail-deleting (CONTRIBUTING §"Ground rules" #3); idempotência por design (#2); StateEvent actor mandatory (#5); secrets-resolution scope inalterado (#4).

## 0. Escopo

Adiciona UM novo tool ao catálogo v2 (`run_migrations`) que aplica migrations SQL **forward-only idempotentes** contra um Postgres rodando dentro de um container Docker gerenciado pelo daemon. Tool é **always sensitive** (passa pelo Approval Gate sempre).

Surface:
- MCP tool name: `run_migrations` (8º v2 tool, additive ao `V2_TOOLS`).
- REST: `POST /api/v2/migrations` (optional wiring seam, same pattern como `set_firewall`).
- Capability name: `run_migrations` (para `AGENT_CREDENTIALS`).
- Synthetic entity: `migrations:<target_service>:<database>`.

Out-of-scope (§10): rollback / DOWN migrations, multi-DB per call, multi-replica PG routing, auto-detect target, connect via connection string (non-docker DB), non-Postgres engines, streaming long-running, file-source migrations (URL/git/volume), `list_migrations` read tool, retry on transient errors, multi-tenant isolation.

## 1. Design

### 1.1 Arquitetura

```
┌── Operator (Claude Code in bevox-harness) ──────────────────────────┐
│  reads migrations/*.sql from disk                                    │
│  extracts -- UP block from each file (harness pattern)               │
│  builds payload: { target_service, database, migrations:[{filename, sql}, ...] }
│  MCP call → bevox-hetzner.run_migrations(payload)                    │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ MCP tools/call (stdio bridge ↦ daemon REST)
                       ▼
┌── bevox-hetzner-mcp daemon ─────────────────────────────────────────┐
│  POST /api/v2/migrations   (new REST route — optional seam)         │
│  MCP tool   run_migrations  (new — 8th v2 tool)                     │
│                                                                       │
│  ├─ authenticate(token) → VerifiedCredential                        │
│  ├─ hasV2Capability(cred, "run_migrations")? else 403               │
│  ├─ approvalGate.gate("run_migrations", scope, payload)             │
│  │  └─ status:"pending_approval" → return; operator approves        │
│  │                                                                   │
│  ├─ resolve target: services[name=target_service] → container_id    │
│  │   via observedStore.getServices() (Docker provider snapshot)     │
│  │   PRE-GATE check (fail-fast precondition).                       │
│  │                                                                   │
│  └─ MigrationRunner.run(deps, ctx):                                 │
│      ├─ for each migration in payload (in array order):             │
│      │   ├─ via docker exec <id> psql:                              │
│      │   │   CREATE TABLE IF NOT EXISTS schema_migrations(          │
│      │   │     filename TEXT PRIMARY KEY,                           │
│      │   │     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());      │
│      │   │   SELECT 1 FROM schema_migrations WHERE filename=$1;     │
│      │   │   ├─ if applied → emit StateEvent {result:"noop"}        │
│      │   │   └─ else → BEGIN; <sql>; INSERT schema_migrations;      │
│      │   │            COMMIT;  emit StateEvent {result:"ok"}        │
│      │   │   on failure → ROLLBACK; STOP batch;                     │
│      │   │     emit StateEvent {result:"error", error_code}         │
│      │   │                                                           │
│      └─ return WriteEnvelope { status:"applied", report:[...] }     │
└──────────────────────────────────────────────────────────────────────┘
```

Key invariants:
- **Forward-only.** No DOWN. Re-applying = noop tracked per filename.
- **Per-migration transaction.** First failure stops batch (no zombie partial state).
- **Idempotent.** 2nd run with same payload → all noop (matches v1 ground rule #2).
- **Fail-safe.** Failed migration leaves `schema_migrations` consistent (transactioned). NEVER drops/destroys anything not requested.

### 1.2 Public surface — schemas

```ts
// core/src/domain/migrations-v2.ts (NEW)
import { z } from "zod";

export const RunMigrationsInput = z.object({
  /** Service name in desired state (the container running Postgres). */
  target_service: z.string().min(1),
  /** Postgres database name (passed to `psql -d`). */
  database: z.string().min(1),
  /** Ordered batch — applied in array order; stops at first failure. */
  migrations: z.array(
    z.object({
      filename: z.string().regex(/^[a-zA-Z0-9_.-]+\.sql$/, "filename must be <safe>.sql"),
      sql: z.string().min(1).max(1024 * 1024),  // 1 MB cap per migration
    }),
  ).min(1).max(100),  // batch cap
});

export type RunMigrationsInput = z.infer<typeof RunMigrationsInput>;

/** Per-filename outcome. SQL bytes NEVER reflected here. */
export const MigrationReportEntry = z.object({
  filename: z.string(),
  result: z.enum(["ok", "noop", "error"]),
  duration_ms: z.number().int().min(0).optional(),
  /** Value-free category enum. NEVER the raw Postgres error text. */
  error_code: z.enum([
    "syntax",
    "constraint",
    "timeout",
    "container_exited",
    "permission",
    "unknown",
  ]).optional(),
});

export const MigrationReport = z.object({
  applied: z.array(MigrationReportEntry),
});

export type MigrationReport = z.infer<typeof MigrationReport>;
```

`RunMigrationsInput` carries ZERO secrets. The DB password lives in the container's own env (set at deploy time by the SecretResolver) and is consumed via `psql -U $POSTGRES_USER` from inside the container. The daemon never sees nor transmits a password for this path.

### 1.3 Capability + TOOL_POLICY

`core/src/agent/capability.ts:V2_TOOLS` gains an 8th entry:

```ts
export const V2_TOOLS = [
  "resolve_selector",
  "set_firewall",
  "set_primary_ip",
  "set_certificate",
  "set_load_balancer",
  "set_ingress",
  "expose_service",
  "run_migrations",   // NEW (8th)
] as const;
```

Per-tool policy in `core/src/agent/tools.ts:TOOL_POLICY`:

```ts
TOOL_POLICY.run_migrations = {
  scope: "service",
  isSensitive: "always",   // hard-coded sensitive — does NOT respect STRICT_MANIFEST_APPROVAL knob
};
```

**Capability grant**: agents that need to call this tool list `"run_migrations"` in their `capabilities` array within `AGENT_CREDENTIALS`. Today the `agent:bevox-harness` token already has 19 caps; this becomes the 20th.

### 1.4 REST + MCP wiring (optional seam)

Mirrors the v2 Bloco A pattern from `2026-05-27-wire-v2-set-firewall.md`:

**REST** in `core/src/agent/rest.ts`: gain an OPTIONAL deps field:

```ts
readonly runMigrations?: RunMigrationsDeps;
```

When omitted at boot, `POST /api/v2/migrations` route stays absent (404). When supplied, the route is wired and authenticates via the standard `CredentialStore` seam.

**MCP** in `core/src/agent/mcp.ts`: same OPTIONAL deps pattern. `run_migrations` tool appears in `tools/list` only when wired.

`entrypoint-wiring.ts:buildBootDeps` constructs `runMigrationsDeps` (live pg client factory + Docker exec transport) and threads it through `createServer`. This is the production wiring path.

### 1.5 StateEvent shape (per ground rule I5)

Each migration application emits one StateEvent:

```ts
{
  actor: "<from VerifiedCredential>",   // e.g. "agent:bevox-harness"
  scope: "service",
  entity: "migrations:postgres:bevox_harness",   // <target_service>:<database>
  op: "create",                                   // schema_migrations row insert
  result: "ok" | "noop" | "error",
  payload: {
    filename: "001_memory_and_classifications.sql",
    // NO `sql` field — never log the SQL bytes (could contain literals like inserted data)
    // NO `error_message` if error — error_code only
    duration_ms: 47,
  }
}
```

11 migrations in one batch → 11 StateEvents. SQL bytes NEVER in event payload.

Failure mode: first failing migration emits its `result:"error"` event with `error_code`, then the batch STOPS. Subsequent migrations are NOT attempted (no zombie state). The `WriteEnvelope.applied` array reflects only the migrations actually attempted (i.e. up to and including the failing one).

### 1.6 Data flow (one migration end-to-end)

1. Operator (Claude Code in bevox-harness) reads `migrations/001_*.sql` from disk, extracts UP block via regex `/-- UP[\s\S]*?(?=-- DOWN|$)/`, builds payload entry.
2. Operator calls MCP `bevox-hetzner.run_migrations({target_service:"postgres", database:"bevox_harness", migrations:[{filename:"001_...sql", sql:"<up block>"}, ...]})`.
3. Bridge forwards to `POST /api/v2/migrations` with the bearer token of `agent:bevox-harness`.
4. Daemon authenticates → finds `run_migrations` in caps → passes auth.
5. Daemon pre-gate precondition: looks up `services[name=postgres]` in observed state. If absent OR no `container_id` → 400 `{code:"precondition", message:"target service not running"}`.
6. Daemon calls `approvalGate.gate("run_migrations", "service:postgres", payload)`. First call → `{status:"pending_approval", approval_id}` returned; operator approves via `POST /api/approvals/<id>/approve`.
7. On retry post-approval (or in tests with auto-approve), `MigrationRunner.run(deps, applyCtx)` executes the batch via `docker exec <id> psql ...` per the §1.1 diagram.
8. Each migration emits a StateEvent (§1.5).
9. Response envelope: `{status:"applied", scope:"service", entity:"migrations:postgres:bevox_harness", actor:"agent:bevox-harness", applied:{applied:[{filename,result,duration_ms?,error_code?}, ...]}}`.

## 2. Error handling — taxonomy

### 2.1 Pre-gate (validation + precondition)

| Cenário | Code | Status |
|---|---|---|
| `target_service` empty or not in observed services | validation | 400 |
| `database` empty | validation | 400 |
| `migrations` array empty or > 100 | validation | 400 |
| Any `migrations[i].filename` fails regex `/^[a-zA-Z0-9_.-]+\.sql$/` | validation | 400 |
| Any `migrations[i].sql` > 1 MB | validation | 400 |
| `target_service` desired but observed `container_id` absent | precondition | 400 |
| Missing `run_migrations` cap on credential | unauthorized | 403 |

All pre-gate messages are value-free; never echo input data.

### 2.2 Gate

Standard approval-gate flow (existing in `core/src/agent/approval-gate.ts`). First call returns `200 {status:"pending_approval", approval_id, ttl}`. After human approval, retry returns the apply-path result.

### 2.3 Apply (during `docker exec psql`)

| Cenário | Maps to `error_code` | Batch behavior |
|---|---|---|
| `docker exec` returns non-zero but container alive | Maps from SQLSTATE: `syntax` (42*), `constraint` (23*), `permission` (42501), else `unknown` | ROLLBACK current migration; STOP batch |
| `docker exec` returns non-zero, container exited | `container_exited` | STOP batch (no rollback possible — container gone) |
| `psql` hangs beyond `MIGRATION_TIMEOUT_MS` (per-migration, default 60s, range [1000, 600000]) | `timeout` | SIGTERM → 200ms → SIGKILL the exec; STOP batch |
| Network/SSH transport fails | `unknown` | STOP batch |

`WriteEnvelope.status` stays `"applied"` (HTTP 200) even when some migrations error — the envelope's `applied[].result` array reports per-filename outcomes. The HTTP status is 200 because the BATCH itself completed (didn't crash); per-migration error is data, not an HTTP-level failure.

### 2.4 Fatal (defensive)

| Cenário | Code | Status |
|---|---|---|
| ApplyContext absent in code path past the gate (bug) | fatal | 500 |
| Daemon process disconnects from Docker mid-batch | fatal | 500 |

## 3. Leak prevention — invariantes

| # | Invariante | Garantido por | Teste |
|---|---|---|---|
| M1 | No `sql` bytes em StateEvent.payload | StateEvent emit code references ONLY filename, never the sql input | unit test on emit site |
| M2 | No Postgres error text em response/log/event | `error_code` is a hardcoded enum mapped from SQLSTATE; raw error.message DISCARDED before throw | sentinel test with crafted PG error |
| M3 | No psql stdout/stderr em response | `docker exec psql` output captured to Buffer for exit-code branching, then DROPPED | impl review |
| M4 | No DB password em any path | Password lives in container env (resolved at deploy by SecretResolver); psql connects from inside the container via Unix socket (`-U user` only, no `-h`, no `-W` prompt) | impl review |
| M5 | No SQL injection via `filename` | `filename` regex `/^[a-zA-Z0-9_.-]+\.sql$/` (Zod validation) — only stored/queried, never executed as identifier | schema validation test |
| M6 | No partial schema_migrations on failure | Per-migration: `BEGIN; <sql>; INSERT schema_migrations; COMMIT` atomically | integration test on pg-harness |
| M7 | Idempotency: 2nd identical batch ⇒ 0 mutations | `SELECT 1 FROM schema_migrations WHERE filename=$1` BEFORE BEGIN; skip on hit | golden test: apply 2x, assert 2nd batch all `result:"noop"` |
| M8 | Fail-safe: batch stops at first error, no zombie state | After ROLLBACK on failure, batch loop breaks; subsequent migrations not even attempted | failure test |

**Sentinel**: introduce `S3CR3T-6.2-migration-leak-XYZ` for tests that craft psql error/stdout content. Matches existing gitleaks regex `S3CR3T-[0-9.]+-[a-z-]+-[A-Za-z0-9]+`; no `.gitleaks.toml` edit needed.

## 4. Transport — `docker exec psql` via SSH

The daemon's Docker provider already uses `core/src/providers/ssh-transports.ts` (`createSshTransports`) for all Docker traffic. Migration runner reuses it. ZERO new transport.

Per-migration invocation (built as argv, executed via the existing SSH transport):

```
docker exec <container_id> \
  psql -U "$POSTGRES_USER" -d <database> \
       -v ON_ERROR_STOP=1 \
       -c "<sql>"
```

- `-v ON_ERROR_STOP=1` — psql aborts at first error (matches `BEGIN/COMMIT` semantics).
- `-c "<sql>"` — SQL passes as argv (no temp file, no stdin streaming). The 1 MB per-migration cap from `RunMigrationsInput` keeps argv length manageable on Linux (`ARG_MAX` ≥ 128 KB on typical kernels; 1 MB is conservatively cap but documented as the upper bound — operator can split a migration if needed).
- `$POSTGRES_USER` — env var inside the container (set by the operator at service deploy time; resolved by SecretResolver if `secret:<ref>`).

**Schema_migrations table init**: every batch begins with a `CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. Idempotent by SQL semantics. Same `docker exec psql` invocation.

**Container resolution**: `target_service` → observed `Service.container_id` via `observedStore.getServices()` filtered by `name === target_service`. If the service has multiple replicas, the runner picks **replica 0 deterministically** (multi-replica PG is out of scope §10).

**Per-migration timeout**: a new config knob `MIGRATION_TIMEOUT_MS` (default 60000ms, range [1000, 600000]). Applied via `AbortController` around the SSH exec. Timeout → SIGTERM 200ms grace → SIGKILL → `error_code:"timeout"`.

## 5. Testing strategy

| Layer | File | Coverage |
|---|---|---|
| Unit — input schema | `core/src/domain/migrations-v2.test.ts` (NEW) | `RunMigrationsInput`: filename regex enforces `.sql` + safe chars, sql size cap 1MB, batch cap 100, min 1 migration, target_service/database non-empty |
| Unit — runner core | `core/src/agent/v2/run-migrations.test.ts` (NEW) | `MigrationRunner` against `pg` fake + `docker-exec` fake — happy path (3 migrations applied, schema_migrations rowcount 3), partial apply (mig 2 errors, mig 3 not attempted), all-noop on re-run, SQLSTATE → `error_code` mapping, sentinel `S3CR3T-6.2-migration-leak-XYZ` in raw PG error NEVER reaches envelope/event |
| Unit — gate routing | `core/src/agent/approval-gate.test.ts` (EXTEND) | `run_migrations` is always-sensitive; first call returns `pending_approval`; approved retry returns `applied` |
| Unit — capability | `core/src/agent/capability.test.ts` (EXTEND) | `V2_TOOLS` length 8; `run_migrations` in v2 set; `ALL_TOOLS` still length 12; hasCapability rejects token without `run_migrations` cap |
| Unit — REST wire | `core/src/agent/v2/run-migrations.rest.test.ts` (NEW) | Optional seam omitted ⇒ route 404; supplied ⇒ POST works; auth 403 on missing cap; envelope shape matches v1 contract |
| Unit — MCP wire | `core/src/agent/v2/run-migrations.mcp.test.ts` (NEW) | Tool absent in `tools/list` when seam omitted; present + callable when wired |
| Integration — pg-harness | `core/src/agent/v2/run-migrations.integration.test.ts` (NEW) | Real Postgres on port 5546 (existing harness). Apply 3-migration batch, assert `schema_migrations` rowcount + applied content. Re-run same batch, assert all noop. 4th batch with deliberate conflict, assert ROLLBACK + batch stops |
| Contract conformance | `core/src/agent/contract-conformance.test.ts` (EXTEND) | `V2_TOOLS` count assertion bumps from 7 → 8. `ALL_TOOLS` still 12 (FROZEN). Conformance oracle byte-stable for v1 |
| Property — idempotency | `core/src/reconciler/idempotency.property.test.ts` (EXTEND) | Generated batches: apply N times ⇒ `schema_migrations` byte-identical after cycle 2..N |
| Golden preserve | `core/src/reconciler/secret-apply.test.ts` + `core/src/store/secrets.test.ts` | UNCHANGED byte-identical (migration runner work doesn't touch secret resolution) |
| Live `@live` | `core/test/live/run-migrations.live.test.ts` (NEW) | Manual pre-release: real Postgres container + real `docker exec psql` + real SSH. Excluded from CI |

**Fake inventory** (`core/test/fakes/`):
- `pg-harness.ts` — already exists (port 5546 disposable PG). Reuse for integration test.
- `docker-http.ts` — already exists for Docker Engine API stubbing. EXTEND with `POST /containers/{id}/exec` endpoint if not already covered.
- `ssh-exec.ts` — already exists from Task 7.2. EXTEND to record argv for assertions on `docker exec` invocations.

## 6. Files changed (impl checklist)

- `core/src/agent/capability.ts` — adiciona `"run_migrations"` ao `V2_TOOLS`. `ALL_TOOLS` UNCHANGED.
- `core/src/agent/tools.ts` — adiciona `TOOL_POLICY.run_migrations = {scope:"service", isSensitive:"always"}`.
- `core/src/domain/migrations-v2.ts` (NEW) — `RunMigrationsInput`, `MigrationReport`, `MigrationReportEntry` Zod schemas.
- `core/src/domain/migrations-v2.test.ts` (NEW) — schema validation tests.
- `core/src/agent/v2/run-migrations.ts` (NEW) — `MigrationRunner` + `RunMigrationsDeps` + REST handler + MCP tool factory.
- `core/src/agent/v2/run-migrations.test.ts` (NEW) — runner unit tests with fakes.
- `core/src/agent/v2/run-migrations.rest.test.ts` (NEW) — REST wire tests.
- `core/src/agent/v2/run-migrations.mcp.test.ts` (NEW) — MCP wire tests.
- `core/src/agent/v2/run-migrations.integration.test.ts` (NEW) — pg-harness integration test.
- `core/src/agent/rest.ts` — `RunMigrationsDeps?` optional dep; new route handler `POST /api/v2/migrations`.
- `core/src/agent/mcp.ts` — `run_migrations` tool registered in v2 catalog when seam supplied.
- `core/src/agent/approval-gate.test.ts` — extend with `run_migrations` always-sensitive test.
- `core/src/agent/capability.test.ts` — extend with v2 length assertion + cap match.
- `core/src/agent/contract-conformance.test.ts` — extend with v2 length bump.
- `core/src/entrypoint-wiring.ts` — `buildBootDeps` constructs `runMigrationsDeps` (live pg fake/real seam) and threads via `createServer`.
- `core/src/entrypoint-wiring.test.ts` — extend with `run_migrations` wiring smoke test.
- `core/src/config.ts` — adiciona `MIGRATION_TIMEOUT_MS: intKnob(60000, 1000, 600000)`.
- `core/src/config.test.ts` — extend with timeout knob test.
- `core/test/fakes/docker-http.ts` — extend with `exec` endpoint if needed.
- `core/test/fakes/ssh-exec.ts` — extend to record argv.
- `core/.env.example` — document `MIGRATION_TIMEOUT_MS` knob + note about `run_migrations` capability.
- `core/test/live/run-migrations.live.test.ts` (NEW) — `@live` smoke test.
- `core/src/reconciler/idempotency.property.test.ts` — extend with migration batch case.
- `CHANGELOG.md` — entry minor version explaining the v2 additive.

Arquivos **EXPLICITAMENTE NÃO TOCADOS**:
- `core/src/agent/capability.ts:ALL_TOOLS` — the 12 FROZEN tools UNCHANGED.
- `core/src/reconciler/secret-apply.test.ts` — golden byte-identical.
- `core/src/store/secrets.test.ts` — stub tests byte-identical.
- `core/src/store/secrets.ts` — secret resolver UNCHANGED (this work doesn't touch it).
- `core/src/providers/docker.ts` — Docker provider UNCHANGED (the migration runner uses the existing SSH transport; no new exec primitive added).
- `core/src/server.ts` — DI surface unchanged (`runMigrations?` field added via existing `BootDeps` optional pattern from `set_firewall` etc.).

## 7. Migration path (operator workflow)

Pre-conditions:
- Daemon `bevox-daemon.service` running with v2 wiring (already).
- Token in `AGENT_CREDENTIALS` includes `"run_migrations"` capability (add via §5.4 procedure of `deploy/runbook-secrets-go-live.md` analog — edit JSON, restart daemon).
- Target service (postgres) already deployed via `deploy_service` and observed `running`.

Per-batch operator workflow:

1. Operator (Claude Code in bevox-harness) reads each `migrations/*.sql` file.
2. For each, extract the `-- UP` block via regex (same as harness `migrate.mjs`).
3. Build the `RunMigrationsInput` payload.
4. Call `bevox-hetzner.run_migrations(payload)` via MCP bridge.
5. First call returns `pending_approval`. Operator approves via `POST /api/approvals/<id>/approve` (one approval covers the whole batch).
6. Retry the tool call. Response carries `applied: [{filename, result, duration_ms?}, ...]`.
7. Verify all entries have `result === "ok"` (first run) or `result === "noop"` (re-run).
8. If any `result === "error"`, batch stopped at that index. Operator inspects the daemon logs / `events` tool for context (the StateEvent for the failing migration has the `error_code`).

## 8. Risks & mitigations

| Risco | Mitigação |
|---|---|
| Long migration runs past timeout | `MIGRATION_TIMEOUT_MS` configurable (default 60s, max 600s). Operator splits a long migration into multiple smaller ones if needed. |
| psql client absent from target image | Pre-gate check is OPTIONAL — could `docker exec psql --version` first. v1 skips this; first migration's failure with `error_code:"unknown"` surfaces the missing client. Operator's responsibility to use a postgres-tagged image. |
| Operator sends mismatched `target_service` (e.g., points to a redis container) | `docker exec redis psql ...` fails with `error_code:"unknown"` on first migration. Batch stops. No data corruption. |
| Multi-replica postgres (HA) | Runner picks replica 0 deterministically. Documented behavior; out of scope to handle properly. |
| SQL injection via `target_service` or `database` (operator-controlled fields) | `target_service` is used to look up a container_id (never as SQL); `database` is passed as argv `-d` (psql validates). No injection surface. |
| Race: two operators call `run_migrations` concurrently against the same DB | Per-migration `BEGIN/COMMIT` + `schema_migrations PRIMARY KEY` constraint — one COMMIT wins, other gets unique violation → `error_code:"constraint"`. Fail-safe. No corruption. |
| Operator forgets to extract `-- UP` block, sends entire file including `-- DOWN` | psql executes everything before `-- DOWN` (comments don't interrupt). If DOWN block contains conflicting DDL (e.g., `DROP TABLE` matching the UP `CREATE TABLE`), the migration fails. Documented in §7 as operator's responsibility. |
| `schema_migrations` table corrupted manually | Operator restores from backup or manually inserts rows. Out of scope. |

## 9. Acceptance criteria

- [ ] `npm --prefix core run typecheck` clean.
- [ ] `npm --prefix core test` full suite green. Baseline after PR #26 merges: ~1071 tests; this adds ~20 → expected ~1091 / 2 skipped (`@live`).
- [ ] `ALL_TOOLS` (12) byte-identical to spec-mãe v1.
- [ ] `V2_TOOLS` length is now 8 (was 7).
- [ ] `contract-conformance.test.ts` updated v2 assertion; v1 conformance byte-stable.
- [ ] `core/.env.example` documents `MIGRATION_TIMEOUT_MS` + note about `run_migrations` cap.
- [ ] `CHANGELOG.md` `[Unreleased]` entry explaining the v2 additive.
- [ ] No new sentinel `S3CR3T-*` outside allowlisted test files. New test sentinel `S3CR3T-6.2-migration-leak-XYZ` matches existing gitleaks regex.
- [ ] Manual smoke against live daemon (post-merge, pre-tag): one trivial `CREATE TABLE` migration against a real postgres container; assert `schema_migrations` row appears + StateEvent recorded + no SQL bytes in `journalctl`.
- [ ] Harness go-live spec §6.2 status updated to "RESOLVED" once shipped.

## 10. Non-goals (YAGNI v1)

| Não-objetivo | Por quê não agora |
|---|---|
| Rollback / DOWN migrations | Forward-only v1. Operator writes a new UP to "undo". Rollback machinery would need approval, state-tracking ("undo migration N"), and reversibility guarantees that DDL doesn't always offer. Open as separate spec when prioritized. |
| Multi-DB per call | One database per call. Multi-DB = multiple calls. Tool surface stays minimal. |
| Multi-replica Postgres routing | Picks replica 0 deterministically. HA Postgres is its own design (leader election, replication state). |
| Auto-detect target from observed state | Operator passes `target_service` explicitly. No "find the PG container" heuristic — reduces surprise. |
| Connection-string-based connect (non-docker DBs) | Tool is exclusively for daemon-managed Docker services. External DBs (managed cloud, RDS) are out of scope — operator can `kubectl exec` / `psql` directly. |
| `psql` substitute for non-Postgres engines | MySQL/SQLite/etc. NOT supported. Tool name reflects Postgres lock-in. Future engine support = new tool name (`run_mysql_migrations` etc.). |
| Streaming/long-running migrations (>10min) | `MIGRATION_TIMEOUT_MS` caps at 600000ms (10 min). Long migrations must be split or run outside the tool. |
| File-source migrations (volume mount / URL fetch / git ref) | All SQL bytes come in the tool payload. Daemon never reads files for migration content. Operator handles file I/O on their side. |
| Migration history UI / `list_migrations` tool | Operator queries `schema_migrations` directly via `docker exec psql` if curious. YAGNI v1. |
| Smart re-tries on transient errors | First failure stops the batch. Operator restarts. No automatic retry. |
| Multi-tenant migration isolation | Bevox single-tenant (CLAUDE.md "Não-objetivos"). |

## 11. Decisões registradas (Q&A do brainstorm)

| Decisão | Escolha | Recusadas | Razão |
|---|---|---|---|
| Tool surface | `run_migrations` high-level | `docker_exec` primitive, init field no manifest, embed-in-entrypoint | Maps natural ao use case; idempotência embutida; manifest-init é big change |
| Catálogo | v2 additive (8º) | ALL_TOOLS extend (rejeitado, FROZEN), novo v3 tier | ALL_TOOLS FROZEN; v2 já tem pattern aditivo; conformance oracle aceita |
| Connection | `docker exec psql` via SSH | Connection string in payload, secret-ref resolver wraps cstring | Reusa transport; sem nova network surface; password fica no container |
| UP/DOWN | Forward-only v1, operator pre-extrai UP | Daemon parsea `-- UP/-- DOWN`, `rollback_migrations` plural tool | Alinha fail-safe v1; rollback = nova UP |
| Approval | Always sensitive | Default-via-knob, auto-detect "new vs noop" | Migration é DDL; sempre passa pelo gate; 1 approval por batch é UX aceitável |
| Failure mode | Stop on first error; batch truncated | Best-effort continue, all-or-nothing transactional batch | Stop is fail-safe (no zombie state); per-migration transaction means consistent state |
| Idempotency tracking | `schema_migrations(filename, applied_at)` per-DB | Per-batch hash, in-memory daemon cache | Pattern do harness `migrate.mjs`; portable; survives daemon restart |

## 12. Referências

- v1 spec FROZEN: [`2026-05-17-bevox-hetzner-mcp-design.md`](./2026-05-17-bevox-hetzner-mcp-design.md) (ground rules + ALL_TOOLS).
- v2 contract FROZEN: [`2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md) (V2_TOOLS additive pattern).
- v2 wiring pattern: [`2026-05-27-wire-v2-set-firewall.md`](./2026-05-27-wire-v2-set-firewall.md) (optional REST/MCP seam).
- Secret resolver: [`2026-05-28-secret-resolver-real-v1.md`](./2026-05-28-secret-resolver-real-v1.md) (the SecretResolver path that gives the container its DB password — this spec rides on top).
- Motivação concreta: bevox-harness go-live spec §6.2 (`bevox-harness/docs/superpowers/specs/2026-05-28-go-live-via-hetzner-mcp.md`).
- Operator pattern referenced: `bevox-harness/scripts/migrate.mjs` (the 54-line node script the daemon's `run_migrations` mirrors in semantics, but server-side).
- Ground rules: `CONTRIBUTING.md` §"Ground rules" (idempotency #2, fail-safe #3, secrets-at-apply #4, actor capture #5).
