# Migration runner v1 (`run_migrations` tool) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Spec:** [`docs/specs/2026-05-28-migration-runner-v1.md`](../../specs/2026-05-28-migration-runner-v1.md)
(Status: Aceita 2026-05-28, commit `f1a9efe`)
**Spec-mãe (v2 contract FROZEN):** [`docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`](../../specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
**Spec-mãe (v1 FROZEN):** [`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`](../../specs/2026-05-17-bevox-hetzner-mcp-design.md)
**Wiring pattern reference:** [`docs/specs/2026-05-27-wire-v2-set-firewall.md`](../../specs/2026-05-27-wire-v2-set-firewall.md)
**Branch:** to be cut `feat/run-migrations-v2` from `main`.
**Baseline:** suite ~1071 verde (após PR #26 — STRICT_MANIFEST_APPROVAL knob).

**Goal:** ao final, o daemon expõe um 8º v2 tool `run_migrations` que aplica
batches de migrations SQL forward-only idempotentes contra um Postgres
gerenciado por um service Docker do próprio daemon, via `docker exec psql`
sobre o transport SSH já existente. Tool é **always sensitive** (sempre passa
pelo Approval Gate). Idempotência por `schema_migrations(filename, applied_at)`.
Per-migration transaction. Stop-on-first-error. ALL_TOOLS (12) FROZEN
byte-identical; V2_TOOLS passa de 7 para 8. Contract-conformance oracle v1
byte-stable.

**Architecture:** novo módulo `core/src/agent/v2/run-migrations.ts` (mesma
forma de organização que `set-firewall.ts`: schema-input parsing + runner +
`RunMigrationsDeps` interface + REST handler-ready entrypoint + MCP tool
factory). Schemas Zod em arquivo separado `core/src/domain/migrations-v2.ts`.
Runner consome 3 seams: (a) `dockerExec` (argv vector + container_id →
`{exitCode, stdout, stderr}`) construído sobre o `runSsh` existente em
`core/src/providers/ssh-exec.ts`; (b) `servicesProvider` (resolve
`target_service` → `container_ids[0]` lendo observed state via
`observed-store`); (c) `appendEvent` via `pg.Pool` para StateEvent por
migration. REST `POST /api/v2/migrations` e MCP `run_migrations` ambos chamam
`runMigrations(input, ctx, deps)` (single source). Wiring em `entrypoint-wiring.ts`
constrói `RunMigrationsDeps` com `dockerExec` sobre o transport SSH real.

**Tech Stack:** herda v1 + v2 (Node 20+, TS 5.x ESM/NodeNext strict, Zod,
Vitest + fakes). ZERO dependência npm nova. `docker exec` via SSH usa o
`ssh-transports.ts → runSsh` já existente (Task 7.2). Postgres real só em
integration test (`pg-harness.ts` port 5546 — pattern já legitimado pelo
projeto, idêntico ao `realSpawnWrapper` test em `2026-05-28-secret-resolver-real-v1.md`).

---

## How this plan is executed

Tarefas numeradas `1.1 .. 9.1` em ordem TDD-canonical: foundation (schemas) →
catálogo (capability/policy/contract) → config knob → fake extensions
(docker exec endpoint + ssh-exec argv recorder) → runner core (1 cenário
por commit) → gate routing → REST/MCP wires → integration test contra
pg-harness real → property test → boot wiring → docs/CHANGELOG. Cada tarefa
é um commit isolado red→green; a ordem é gated (sem schemas não há runner;
sem runner não há REST/MCP; sem REST/MCP não há boot wiring).

### Working agreement (all tasks)

- TDD, always: red → green → commit. Reference
  @superpowers:test-driven-development e `.claude/rules/tdd-required.md`.
- DRY / YAGNI / mudança mínima. Reference
  @superpowers:minimal-change-engineer.
- Frequent commits: one task = one commit. Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- @superpowers:verification-before-completion antes de qualquer "done".
- Tests NUNCA tocam Postgres / SSH / Docker reais EXCETO:
  (a) o integration test `run-migrations.integration.test.ts` usa o
      pg-harness real (port 5546) — pattern já legitimado no projeto
      (`reconcile.test.ts`, `idempotency.property.test.ts`, etc., todos
      usam pg-harness real);
  (b) o `@live` test fica em `core/test/live/run-migrations.live.test.ts` e
      é excluído de CI via vitest project glob.
- Sentinel `S3CR3T-6.2-migration-leak-XYZ` aparece SÓ em test files
  (`run-migrations.test.ts`, `run-migrations.integration.test.ts`). Matches
  a regex existente em `.gitleaks.toml` (`S3CR3T-[0-9.]+-[a-z-]+-[A-Za-z0-9]+`).
  NÃO editar `.gitleaks.toml`.
- StateEvent actor MANDATORY: cada emit em runner usa `actorOf(ctx.credential)`,
  scope `"service"`, entity `migrations:<target_service>:<database>`. Mesmo
  pattern que `set-firewall.ts:316-327`.
- ALL_TOOLS (12) byte-identical FROZEN. Test
  `capability.test.ts:"ALL_TOOLS is exactly the 12 spec tools"` permanece
  byte-identical — verificar após cada task. V2_TOOLS length passa 7 → 8.
- Steps usam `- [ ]` checkboxes. Marque ao concluir.

---

## Non-negotiable principles (carryover v1 + v2)

- **Fail-safe, nunca fail-deleting.** Per-migration `BEGIN; <sql>; INSERT
  schema_migrations; COMMIT`. Failure → `ROLLBACK` e STOP batch — nunca
  destrói o que não foi pedido (CONTRIBUTING §"Ground rules" #3).
- **Idempotência por design.** `SELECT 1 FROM schema_migrations WHERE
  filename=$1` ANTES de `BEGIN`; hit → noop. Re-run do mesmo payload é all-noop
  (#2).
- **StateEvent actor.** Cada migration emit registra o agente (#5). Synthetic
  entity `migrations:<target_service>:<database>`.
- **Secrets-resolution scope unchanged.** `RunMigrationsInput` NÃO carrega
  password. DB password vive no container env (resolvido at deploy by
  SecretResolver). `psql -U $POSTGRES_USER` interno ao container (Unix socket).
  Daemon nunca vê o password (#4).
- **No SQL bytes em logs / event payload / response error.** SQL passa só como
  argv `-c "<sql>"` na invocação `docker exec`. StateEvent.payload carrega só
  `filename` + `duration_ms` + `error_code`. Postgres error text DESCARTADO
  antes de qualquer throw — só a categoria enum (`syntax`/`constraint`/
  `timeout`/`container_exited`/`permission`/`unknown`).
- **ESM/NodeNext + strict TS.** `.js` extension on relative imports;
  `import type` para type-only; `noUncheckedIndexedAccess` (rules em
  `.claude/rules/esm-nodenext.md`).
- **One responsibility per file.** O runner + `RunMigrationsDeps` interface +
  REST handler + MCP tool factory cabem em
  `core/src/agent/v2/run-migrations.ts` (~400-500 linhas estimadas, abaixo do
  soft limit 600). Schemas Zod em `core/src/domain/migrations-v2.ts`. Mesmo
  pattern de `set-firewall.ts`.

---

## Testing strategy

| Layer | How | What it covers |
|---|---|---|
| Unit — input schema | `core/src/domain/migrations-v2.test.ts` (NEW) | `RunMigrationsInput`: filename regex enforces `.sql` + safe chars, sql size cap 1MB, batch cap 100, min 1 migration, target_service/database non-empty. `MigrationReport` + `MigrationReportEntry` shape. |
| Unit — runner core | `core/src/agent/v2/run-migrations.test.ts` (NEW) | Runner com `docker-http.ts` fake exec endpoint + scripted `dockerExec` results — happy path 3 migrations applied, partial apply stop-on-first, all-noop on re-run, SQLSTATE → `error_code` mapping, sentinel never in error path, timeout SIGTERM/SIGKILL, container_exited, schema_migrations CREATE IF NOT EXISTS, argv form `-c "<sql>"` invariant, transaction integrity. |
| Unit — gate routing | `core/src/agent/approval-gate.test.ts` (EXTEND) | `run_migrations` é always-sensitive; primeiro call retorna `pending_approval`; approved retry retorna `applied`. |
| Unit — capability | `core/src/agent/capability.test.ts` (EXTEND) | `V2_TOOLS` length 8; `run_migrations` ∈ v2 set; `ALL_TOOLS` ainda length 12 byte-identical; `hasV2Capability` rejeita token sem `run_migrations` cap. |
| Unit — REST wire | `core/src/agent/v2/run-migrations.rest.test.ts` (NEW) | Optional seam omitted ⇒ route 404; supplied ⇒ POST 200; auth 403 on missing cap; envelope shape `applied + status:"applied"` MESMO quando per-migration error (HTTP 200 — per spec §2.3). |
| Unit — MCP wire | `core/src/agent/v2/run-migrations.mcp.test.ts` (NEW) | Tool absent em `tools/list` quando seam omitted; present + callable quando wired; same single-source semantics que REST. |
| Integration — pg-harness | `core/src/agent/v2/run-migrations.integration.test.ts` (NEW) | Real Postgres on port 5546 (`pg-harness.ts`). Apply 3-migration batch, assert `schema_migrations` rowcount + content. Re-run mesmo batch, assert all noop. Batch com deliberate conflict, assert ROLLBACK + batch stops + schema_migrations consistent. |
| Contract conformance | `core/src/agent/contract-conformance.test.ts` (EXTEND) | V2 conformance: `V2_TOOLS` count assertion 7 → 8. `ALL_TOOLS` ainda 12 (FROZEN). Oracle byte-stable para v1. |
| Property — idempotency | `core/src/reconciler/idempotency.property.test.ts` (EXTEND) | Generated batches: apply N vezes ⇒ `schema_migrations` byte-identical após cycle 2..N (zero StateEvent mutating em re-run). |
| Live `@live` | `core/test/live/run-migrations.live.test.ts` (NEW) | Manual pre-release. Real PG container + real `docker exec psql` + real SSH. Excluído de CI via vitest project glob. |

**Fake inventory & extensions**:
- `core/test/fakes/pg-harness.ts` — JÁ EXISTE (port 5546). Reuse para
  integration test. Padrão `resetSchema` + `runMigrations` (do core
  `db.ts` — NÃO confundir com a tool nova `run_migrations`).
- `core/test/fakes/docker-http.ts` — EXTEND com `POST /containers/{id}/exec`
  + `POST /exec/{id}/start` endpoints (mínimo necessário para o runner).
  Hoje só cobre create/start/stop/list/inspect.
- `core/test/fakes/ssh-exec-recorder.ts` (NEW) — fake `SshRunner` (shape
  já definida em `core/src/providers/ssh-transports.ts:SshRunner`) que
  registra argv + opts por call e devolve `SshResult` scriptado. Note: a
  spec (§5) menciona `core/test/fakes/ssh-exec.ts` como existente "from
  Task 7.2" — NÃO existe (apenas `core/src/providers/ssh-exec.ts` da
  prod). Criar o recorder fake é o caminho honesto.

---

## FROZEN CONTRACT — additions to v2 (additive only)

| New surface | Vocabulary | Approval | Capability grant |
|---|---|---|---|
| MCP tool `run_migrations` | added to `V2_TOOLS` (8th entry) | **always** (hardcoded; does NOT respect STRICT_MANIFEST_APPROVAL) | `"run_migrations"` em `AGENT_CREDENTIALS[token].capabilities` |
| REST `POST /api/v2/migrations` | optional seam (route absent if `deps.runMigrations` omitted) | same gate as MCP path (single source) | same as MCP |
| Synthetic entity | `migrations:<target_service>:<database>` | StateEvent per migration | actor = `actorOf(ctx.credential)` |
| Zod schemas | `core/src/domain/migrations-v2.ts`: `RunMigrationsInput`, `MigrationReport`, `MigrationReportEntry` | — | — |
| Config knob | `MIGRATION_TIMEOUT_MS: intKnob(60_000, 1000, 600_000)` | — | — |

**ALL_TOOLS (12) FROZEN byte-identical.** `TOOL_POLICY` map (the v1 12-tool
table) **UNCHANGED** — `run_migrations` policy é separada (v2 always-sensitive
hardcoded inside the tool's own code path, mirroring `set-firewall.ts` que NÃO
estende `TOOL_POLICY`).

**Divergência da spec §1.3**: a spec sugere `TOOL_POLICY.run_migrations =
{scope: "service", isSensitive: "always"}`. Mas o `TOOL_POLICY` atual em
`core/src/agent/tools.ts:134` é `Readonly<Record<ToolName, ToolPolicy>>` —
`ToolName` é o type derivado de `ALL_TOOLS` (12 FROZEN). Estender essa map
quebraria o type sem mudar `ALL_TOOLS`. **Decisão**: seguir o mesmo padrão de
v2 Bloco A (`set-firewall.ts`, `set-load-balancer.ts`, etc.) — sensitivity é
hardcoded inside the v2 tool's own dispatch, NÃO via `TOOL_POLICY`. Documentar
no commit body de Task 2.2 que isso preserva a invariante de byte-identical
`TOOL_POLICY`.

---

## File structure (one responsibility per file)

```
core/
├── src/
│   ├── domain/
│   │   ├── migrations-v2.ts                       NEW       (RunMigrationsInput + MigrationReport + MigrationReportEntry Zod schemas)
│   │   └── migrations-v2.test.ts                  NEW       (schema validation)
│   ├── agent/
│   │   ├── capability.ts                          MODIFIED  ("run_migrations" appended to V2_TOOLS)
│   │   ├── capability.test.ts                     MODIFIED  (V2_TOOLS length 8 + run_migrations membership; ALL_TOOLS UNCHANGED test preserved)
│   │   ├── approval-gate.test.ts                  MODIFIED  (run_migrations always-sensitive coverage)
│   │   ├── contract-conformance.test.ts           MODIFIED  (v2 length bump 7 → 8 if asserted there; ALL_TOOLS oracle preserved)
│   │   ├── tools.ts                               UNCHANGED (TOOL_POLICY FROZEN — sensitivity hardcoded inside the v2 tool, mesma pattern de set-firewall.ts)
│   │   ├── rest.ts                                MODIFIED  (optional dep RunMigrationsDeps + POST /api/v2/migrations route)
│   │   ├── mcp.ts                                 MODIFIED  (optional dep + run_migrations tool registered when wired)
│   │   └── v2/
│   │       ├── run-migrations.ts                  NEW       (Runner + RunMigrationsDeps + REST entrypoint + MCP tool factory — same single-file org as set-firewall.ts)
│   │       ├── run-migrations.test.ts             NEW       (runner unit tests with fakes — ~10-12 scenarios)
│   │       ├── run-migrations.rest.test.ts        NEW       (REST wire tests — single source assertion + auth)
│   │       ├── run-migrations.mcp.test.ts         NEW       (MCP wire tests — tools/list absence + invocation)
│   │       └── run-migrations.integration.test.ts NEW       (pg-harness real PG via the fake `dockerExec` that proxies to harness pool)
│   ├── config.ts                                  MODIFIED  (MIGRATION_TIMEOUT_MS knob — extend intKnob signature with optional `max`)
│   ├── config.test.ts                             MODIFIED  (knob bounds + default test)
│   ├── entrypoint-wiring.ts                       MODIFIED  (buildBootDeps constructs runMigrationsDeps wiring dockerExec over the SSH transport)
│   ├── entrypoint-wiring.test.ts                  MODIFIED  (run_migrations wiring smoke test)
│   └── reconciler/
│       └── idempotency.property.test.ts           MODIFIED  (migration batch case — apply N times → no extra rows in schema_migrations)
├── test/
│   ├── fakes/
│   │   ├── docker-http.ts                         MODIFIED  (POST /containers/{id}/exec + POST /exec/{id}/start endpoints)
│   │   ├── docker-http.test.ts                    MODIFIED  (self-tests cobrindo o novo exec endpoint)
│   │   └── ssh-exec-recorder.ts                   NEW       (SshRunner fake — argv recorder + scripted SshResult)
│   └── live/
│       └── run-migrations.live.test.ts            NEW       (@live — manual pre-release smoke)
└── .env.example                                   MODIFIED  (MIGRATION_TIMEOUT_MS doc + run_migrations capability note)

CHANGELOG.md                                       MODIFIED  ([Unreleased] entry — v2 additive, 8º tool)
```

**EXPLICITAMENTE NÃO TOCADO** (per spec §6 + extracted invariantes):
- `core/src/agent/capability.ts:ALL_TOOLS` — 12 FROZEN UNCHANGED.
- `core/src/agent/tools.ts:TOOL_POLICY` — type bound a `ToolName` (v1 12);
  v2 sensitivity hardcoded inside `run-migrations.ts` (mesma pattern de
  `set-firewall.ts`). Decisão registrada acima.
- `core/src/reconciler/secret-apply.test.ts` — golden byte-identical.
- `core/src/store/secrets.test.ts` — stub tests byte-identical.
- `core/src/store/secrets.ts` — secret resolver UNCHANGED.
- `core/src/providers/docker.ts` — Docker provider UNCHANGED (runner
  consome `dockerExec` seam construído em `entrypoint-wiring.ts`; nenhuma
  primitiva nova no provider).
- `core/src/server.ts` — DI surface preservada (já aceita
  `setFirewall?: SetFirewallDeps` etc.; adicionar `runMigrations?` segue o
  mesmo padrão optional field e NÃO conta como mudança comportamental do
  core).

---

# Task 1 — Foundation: Zod schemas (BLOCKING GATE)

**Goal/deliverable:** `RunMigrationsInput`, `MigrationReport`,
`MigrationReportEntry` definidos em `core/src/domain/migrations-v2.ts` com
testes de validação. Sem consumer ainda.

**Exit criteria:** `npm --prefix core test core/src/domain/migrations-v2.test.ts`
verde; `npm --prefix core run typecheck` clean.

### Task 1.1 — `RunMigrationsInput` schema + bounds tests

- Files: `core/src/domain/migrations-v2.ts` (NEW),
  `core/src/domain/migrations-v2.test.ts` (NEW).
- [ ] Familiarise: read `core/src/domain/entities-v2.ts` (Bloco A schema
      organization), e spec §1.2 (linhas 75-115) — schema literal.
- [ ] Failing test:
  ```ts
  import { describe, it, expect } from "vitest";
  import { RunMigrationsInput } from "./migrations-v2.js";

  describe("RunMigrationsInput", () => {
    it("rejects empty target_service", () => {
      expect(() => RunMigrationsInput.parse({
        target_service: "", database: "db",
        migrations: [{ filename: "001_x.sql", sql: "SELECT 1" }],
      })).toThrow(/target_service/);
    });
    it("rejects filename without .sql or with unsafe chars", () => {
      expect(() => RunMigrationsInput.parse({
        target_service: "pg", database: "db",
        migrations: [{ filename: "../etc/passwd", sql: "x" }],
      })).toThrow();
      expect(() => RunMigrationsInput.parse({
        target_service: "pg", database: "db",
        migrations: [{ filename: "001 x.sql", sql: "x" }],  // space
      })).toThrow();
    });
    it("rejects sql > 1 MB", () => {
      expect(() => RunMigrationsInput.parse({
        target_service: "pg", database: "db",
        migrations: [{ filename: "x.sql", sql: "a".repeat(1024*1024 + 1) }],
      })).toThrow();
    });
    it("rejects batch > 100 migrations", () => {
      const m = Array(101).fill({ filename: "x.sql", sql: "x" });
      expect(() => RunMigrationsInput.parse({
        target_service: "pg", database: "db", migrations: m,
      })).toThrow();
    });
    it("accepts a 1-migration batch with safe filename + sql at 1 MB", () => {
      expect(() => RunMigrationsInput.parse({
        target_service: "pg", database: "db",
        migrations: [{ filename: "001_init.sql", sql: "a".repeat(1024*1024) }],
      })).not.toThrow();
    });
  });
  ```
- [ ] Run `npm --prefix core test core/src/domain/migrations-v2.test.ts` →
      expect FAIL (`RunMigrationsInput` undefined / module not found).
- [ ] Minimal impl em `migrations-v2.ts`:
  - Export `RunMigrationsInput` (Zod object) literal per spec §1.2.
  - Filename regex: `/^[a-zA-Z0-9_.-]+\.sql$/` com `.regex()` message
    "filename must be <safe>.sql".
  - `sql`: `z.string().min(1).max(1024 * 1024)`.
  - `migrations`: `z.array(...).min(1).max(100)`.
  - `target_service`, `database`: `z.string().min(1)`.
  - Export `type RunMigrationsInput = z.infer<typeof RunMigrationsInput>`.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): RunMigrationsInput schema (1.1)`

### Task 1.2 — `MigrationReport` + `MigrationReportEntry` schemas

- Files: `core/src/domain/migrations-v2.ts`,
  `core/src/domain/migrations-v2.test.ts`.
- [ ] Failing test:
  ```ts
  describe("MigrationReportEntry", () => {
    it("accepts ok/noop/error result enums", () => {
      for (const r of ["ok", "noop", "error"] as const) {
        expect(() => MigrationReportEntry.parse({ filename: "x.sql", result: r })).not.toThrow();
      }
    });
    it("rejects unknown result", () => {
      expect(() => MigrationReportEntry.parse({ filename: "x.sql", result: "skipped" })).toThrow();
    });
    it("accepts the 6 error_code enum values", () => {
      for (const c of ["syntax","constraint","timeout","container_exited","permission","unknown"] as const) {
        expect(() => MigrationReportEntry.parse({
          filename: "x.sql", result: "error", error_code: c,
        })).not.toThrow();
      }
    });
    it("rejects sql/error_message fields (NEVER part of the report)", () => {
      // Zod strict if .strict() — see impl note
      expect(() => MigrationReportEntry.parse({
        filename: "x.sql", result: "ok", sql: "SELECT 1",
      } as any)).toThrow();
    });
  });

  describe("MigrationReport", () => {
    it("wraps applied[]", () => {
      const r = MigrationReport.parse({ applied: [
        { filename: "1.sql", result: "ok", duration_ms: 5 },
        { filename: "2.sql", result: "noop" },
      ]});
      expect(r.applied).toHaveLength(2);
    });
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: `MigrationReportEntry` é `z.object({...}).strict()`
      (strict() para impor "no extra fields" — bloqueia leak via sql/
      error_message). Exports + `type` aliases.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): MigrationReport + MigrationReportEntry schemas (1.2)`

**Done (Task 1) =** Schemas exportados de `core/src/domain/migrations-v2.ts`.
Sem consumer ainda. Suite green +N tests.

---

# Task 2 — Capability + contract-conformance v2 bump

**Goal/deliverable:** `V2_TOOLS` passa de 7 para 8 com `"run_migrations"` no
final do array. `capability.test.ts` afirma length 8 e membership. v2
contract-conformance (se asserta length) atualizado.

**Exit criteria:** `npm --prefix core test core/src/agent/capability.test.ts`
+ `core/src/agent/v2/contract-v2-conformance.test.ts` (se existe assertion
de length) verde. `ALL_TOOLS is exactly the 12 spec tools` PRESERVADO.

### Task 2.1 — Extend `V2_TOOLS` with `run_migrations`

- Files: `core/src/agent/capability.ts`, `core/src/agent/capability.test.ts`.
- [ ] Familiarise: read `core/src/agent/capability.ts:82-94` (V2_TOOLS
      atual). NOTE: o V2_TOOLS atual em prod (linhas 82-90) tem 7 entries:
      `"resolve_selector", "set_firewall", "set_primary_ip",
      "set_certificate", "set_load_balancer", "set_ingress", "expose_service"`.
- [ ] Failing test em `capability.test.ts` (após o describe "tool
      vocabulary"):
  ```ts
  describe("V2_TOOLS — v2 additive vocabulary", () => {
    it("V2_TOOLS length is 8 and includes run_migrations", () => {
      expect(cap.V2_TOOLS).toHaveLength(8);
      expect([...cap.V2_TOOLS]).toContain("run_migrations");
    });
    it("ALL_TOOLS is still exactly the 12 spec tools (FROZEN)", () => {
      // Sentinel duplicate of the existing test to make regression visible.
      expect(cap.ALL_TOOLS).toHaveLength(12);
    });
  });
  ```
- [ ] Run → expect FAIL (`V2_TOOLS` has length 7).
- [ ] Minimal impl em `capability.ts`: append `"run_migrations"` ao tuple
      `V2_TOOLS` (linha 89, antes do `] as const`). Mesma indentação dos
      siblings.
- [ ] Run → expect PASS. Run full v2 contract test:
      `npm --prefix core test core/src/agent/v2/contract-v2-conformance.test.ts`
      — se há assertion de `V2_TOOLS.length === 7`, esta task ALSO atualiza
      essa assertion (mesmo commit, pois é apenas um number bump em mesma
      invariante).
- [ ] Verify `npm --prefix core test core/src/agent/capability.test.ts` →
      PASS incluindo o teste preservado de ALL_TOOLS sendo 12.
- [ ] Commit: `feat(core): V2_TOOLS adds run_migrations (8th v2 tool) (2.1)`

### Task 2.2 — Contract-conformance oracle byte-stable for v1

- Files: `core/src/agent/contract-conformance.test.ts` (REVIEW),
  `core/src/agent/v2/contract-v2-conformance.test.ts` (EXTEND if needed).
- [ ] Familiarise: read
      `core/src/agent/contract-conformance.test.ts:60` (importa
      `ALL_TOOLS`) — confirmar que NÃO há assertion de
      `V2_TOOLS.length === 7` aqui (a v2 oracle vive em
      `v2/contract-v2-conformance.test.ts`).
- [ ] Failing test: este task é um GUARD, não uma feature change. O test
      "ALL_TOOLS is exactly the 12 spec tools" em `capability.test.ts`
      (linha 38) tem que continuar verde EXACTLY. Adicionar duplicate
      sentinel test em `contract-conformance.test.ts` (no fim do describe):
  ```ts
  describe("v1 FROZEN — additive v2 must not pollute v1 surface", () => {
    it("ALL_TOOLS length stays 12 byte-for-byte after v2 additions", () => {
      expect(ALL_TOOLS).toHaveLength(12);
    });
  });
  ```
- [ ] Run → expect PASS (already true post-2.1 if `ALL_TOOLS` untouched).
- [ ] Commit: `test(core): v1 ALL_TOOLS=12 FROZEN sentinel post-v2-tool (2.2)`

**Done (Task 2) =** V2_TOOLS length 8 contendo `run_migrations`. ALL_TOOLS
12 byte-identical. Conformance oracle v1 PRESERVED.

---

# Task 3 — Config knob `MIGRATION_TIMEOUT_MS`

**Goal/deliverable:** novo intKnob `MIGRATION_TIMEOUT_MS` (default 60_000,
bounds [1000, 600_000]) em `ConfigSchema`. Requires `intKnob` signature
extension to accept optional `max` parameter (mesma extensão proposta no
plano de secret-resolver Task 5.1 — coordenar se aquele plano já mergeou).

**Exit criteria:** `npm --prefix core test core/src/config.test.ts` verde
com 2-3 casos novos.

### Task 3.1 — `intKnob` accepts optional max bound

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Familiarise: read `core/src/config.ts:66-72` (current `intKnob(def,
      min)`).
- [ ] **CHECK FIRST**: confirmar que o plan
      `2026-05-28-secret-resolver-real-v1.md` Task 5.1 (que estende
      `intKnob` com max) NÃO foi mergeado ainda. Se foi (intKnob já tem
      `max?` param), pular Task 3.1 e ir direto para 3.2. Se não, esta task
      faz a extensão. Documentar no commit body qual situação.
- [ ] Failing test:
  ```ts
  it("intKnob enforces max bound when provided", () => {
    const schema = z.object({ X: intKnob(5000, 1000, 60000) });
    expect(() => schema.parse({ X: "70000" })).toThrow(/X/);
    expect(schema.parse({ X: "5000" })).toEqual({ X: 5000 });
    expect(schema.parse({})).toEqual({ X: 5000 });
  });
  ```
- [ ] Run → expect FAIL (max not enforced).
- [ ] Minimal impl em `config.ts`: signature `intKnob(def, min, max?)`.
      Quando `max` provided: `.max(max)` no chain.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): intKnob optional max bound (3.1)`

### Task 3.2 — Add `MIGRATION_TIMEOUT_MS` to ConfigSchema

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Failing test:
  ```ts
  it("ConfigSchema: MIGRATION_TIMEOUT_MS default 60000, bounded [1000, 600000]", () => {
    expect(loadConfig({ ...baselineEnv }).MIGRATION_TIMEOUT_MS).toBe(60_000);
    expect(loadConfig({ ...baselineEnv, MIGRATION_TIMEOUT_MS: "30000" })
      .MIGRATION_TIMEOUT_MS).toBe(30_000);
    expect(() => loadConfig({ ...baselineEnv, MIGRATION_TIMEOUT_MS: "500" })).toThrow();
    expect(() => loadConfig({ ...baselineEnv, MIGRATION_TIMEOUT_MS: "700000" })).toThrow();
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: append a `ConfigSchema`:
      `MIGRATION_TIMEOUT_MS: intKnob(60_000, 1000, 600_000),`
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): MIGRATION_TIMEOUT_MS config knob (3.2)`

**Done (Task 3) =** Config tem novo knob com bounds. Não consumed yet.

---

# Task 4 — Fake extensions (Docker exec endpoint + SSH-exec recorder)

**Goal/deliverable:** `docker-http.ts` fake ganha endpoints
`POST /containers/{id}/exec` + `POST /exec/{id}/start`; novo
`ssh-exec-recorder.ts` fake captura argv para assertions. Self-tests verdes.

**Exit criteria:** `npm --prefix core test core/test/fakes/docker-http.test.ts`
+ `core/test/fakes/ssh-exec-recorder.test.ts` (new) verde. Sem consumer.

### Task 4.1 — Extend `docker-http.ts` with exec endpoints

- Files: `core/test/fakes/docker-http.ts`,
  `core/test/fakes/docker-http.test.ts`.
- [ ] Familiarise: read `core/test/fakes/docker-http.ts` (~250 linhas;
      switch sobre `method + path` em `transport`). Read Docker Engine API
      reference for `POST /containers/{id}/exec` (cria exec context) +
      `POST /exec/{id}/start` (executa + stream stdout/stderr). Para o
      runner, modelo "blocking": fake retorna `{exitCode, stdout, stderr}`
      concatenados num único response (Engine real streamia; o fake
      simplifica a um JSON shape determinístico — pattern já estabelecido
      em `docker-http.ts` para outros endpoints).
- [ ] Failing test em `docker-http.test.ts`:
  ```ts
  it("POST /containers/{id}/exec creates an exec context with an Id", async () => {
    const fake = createDockerHttpFake();
    fake.createContainer({ Name: "pg", Image: "postgres:16" });
    const { status, json } = await fake.transport.request("POST",
      "/containers/c1/exec", { Cmd: ["psql","-U","u","-d","db","-c","SELECT 1"], AttachStdout: true });
    expect(status).toBe(201);
    expect(json.Id).toMatch(/^exec[0-9]+$/);
  });

  it("POST /exec/{id}/start returns exitCode + stdout + stderr (scripted)", async () => {
    const fake = createDockerHttpFake();
    fake.createContainer({ Name: "pg", Image: "postgres:16" });
    fake.setExecResult({ exitCode: 0, stdout: "OK\n", stderr: "" });
    const { json: exec } = await fake.transport.request("POST",
      "/containers/c1/exec", { Cmd: ["psql","-c","SELECT 1"] });
    const { status, json } = await fake.transport.request("POST",
      `/exec/${exec.Id}/start`, {});
    expect(status).toBe(200);
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toBe("OK\n");
  });

  it("setExecResult({exitCode:1, stderr:'ERROR:  syntax error at or near \"SLECT\"'}) → exit 1", async () => {
    const fake = createDockerHttpFake();
    fake.createContainer({ Name: "pg", Image: "postgres:16" });
    fake.setExecResult({ exitCode: 1, stdout: "", stderr: 'ERROR:  syntax error at or near "SLECT"\nSQLSTATE: 42601\n' });
    const { json: exec } = await fake.transport.request("POST",
      "/containers/c1/exec", { Cmd: ["psql","-c","SLECT 1"] });
    const { json } = await fake.transport.request("POST",
      `/exec/${exec.Id}/start`, {});
    expect(json.exitCode).toBe(1);
    expect(json.stderr).toMatch(/SQLSTATE: 42601/);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl em `docker-http.ts`:
  - Add `exec` Map<id, ExecContext> ao closure state.
  - `POST /containers/:cid/exec`: if cid não existe → 404; else create
    exec context with `Id: "exec" + n`, store `Cmd` array. Return 201.
  - `POST /exec/:eid/start`: lookup; if missing → 404; return scripted
    result via `setExecResult({exitCode, stdout, stderr})` setter (default
    `{exitCode: 0, stdout: "", stderr: ""}`).
  - Add `setExecResult(result)` + `setExecResultByMatcher(predicate,
    result)` (latter optional for differential scripting between
    migrations).
  - Add `execCallLog: ExecCall[]` recording `{containerId, cmd, execId,
    started: boolean}` for assertion.
  - `reset()`: clears exec map + call log + scripted result.
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): docker-http fake exec/start endpoints (4.1)`

### Task 4.2 — `ssh-exec-recorder.ts` fake — SshRunner argv recorder

- Files: `core/test/fakes/ssh-exec-recorder.ts` (NEW),
  `core/test/fakes/ssh-exec-recorder.test.ts` (NEW).
- [ ] Familiarise: read `core/src/providers/ssh-transports.ts:76-80`
      (`SshRunner` shape) e `core/src/providers/ssh-exec.ts:97-110`
      (`SpawnLike` is for spawn, but `SshRunner` is the higher-level seam
      `(conn, remoteArgv, opts) => Promise<SshResult>`). The recorder fake
      implements `SshRunner`, NOT `SpawnLike` — uma camada acima.
- [ ] Failing test em `ssh-exec-recorder.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { createSshExecRecorder } from "./ssh-exec-recorder.js";

  describe("ssh-exec-recorder fake", () => {
    it("records argv per call and returns scripted SshResult", async () => {
      const rec = createSshExecRecorder();
      rec.setResult({ code: 0, stdout: "ok\n", stderr: "" });
      const res = await rec.run(
        { host: "h", user: "u", port: 22, privateKey: "k", hostKeyPolicy: "accept-new" },
        ["docker", "exec", "c1", "psql", "-U", "u", "-d", "db", "-c", "SELECT 1"],
      );
      expect(res).toEqual({ code: 0, stdout: "ok\n", stderr: "" });
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]!.remoteArgv).toEqual([
        "docker","exec","c1","psql","-U","u","-d","db","-c","SELECT 1",
      ]);
    });

    it("setResultByMatcher dispatches scripted result per argv predicate", async () => {
      const rec = createSshExecRecorder();
      rec.setResultByMatcher(
        (argv) => argv.includes("CREATE TABLE IF NOT EXISTS schema_migrations"),
        { code: 0, stdout: "", stderr: "" },
      );
      rec.setResultByMatcher(
        (argv) => argv.some((a) => a.includes("SLECT")),  // typo
        { code: 1, stdout: "", stderr: 'ERROR:  syntax error\nSQLSTATE: 42601' },
      );
      // exercise both paths…
    });
  });
  ```
- [ ] Run → expect FAIL (module not found).
- [ ] Minimal impl em `ssh-exec-recorder.ts`:
  - `createSshExecRecorder()` retorna `{ run: SshRunner, calls,
    setResult, setResultByMatcher, reset }`.
  - `calls` é `Array<{conn, remoteArgv, opts}>`.
  - Default result `{code: 0, stdout: "", stderr: ""}` quando nada
    configurado.
  - Matcher chain: first matching predicate wins; else default result.
  - `reset()` limpa calls + matchers + default.
  - Type-import `SshRunner`, `SshResult`, `SshConnection` from
    `../../src/providers/ssh-transports.js` e `../../src/providers/ssh-exec.js`.
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): ssh-exec-recorder SshRunner fake (4.2)`

**Done (Task 4) =** Fake infrastructure ready. Sem consumer yet.

---

# Task 5 — `MigrationRunner` core — one TDD scenario per commit

**Goal/deliverable:** runner completo em `core/src/agent/v2/run-migrations.ts`
com 10+ cenários cobertos em `run-migrations.test.ts`. Sem REST/MCP wire
yet.

**Exit criteria:**
`npm --prefix core test core/src/agent/v2/run-migrations.test.ts` verde com
todos os cenários; `npm --prefix core run typecheck` clean.

### Task 5.1 — Skeleton: `runMigrations(input, ctx, deps)` + capability deny

- Files: `core/src/agent/v2/run-migrations.ts` (NEW),
  `core/src/agent/v2/run-migrations.test.ts` (NEW).
- [ ] Familiarise: re-read `core/src/agent/v2/set-firewall.ts:170-200` (the
      assertion + parse + ctx pattern) e `core/src/agent/v2/envelope-v2.ts`
      (`WriteEnvelopeV2` + `buildV2WriteEnvelope`).
- [ ] Failing test:
  ```ts
  import { describe, it, expect } from "vitest";
  import { runMigrations } from "./run-migrations.js";
  import { __mintVerifiedCredentialForTest } from "../capability.js";

  describe("runMigrations — capability gate", () => {
    it("credential without run_migrations cap → 403-class error envelope", async () => {
      const cred = __mintVerifiedCredentialForTest("agent:test", ["resolve_selector"]);
      const env = await runMigrations(
        { target_service: "pg", database: "db",
          migrations: [{ filename: "x.sql", sql: "SELECT 1" }] },
        { credential: cred, scope: "service" },
        {} as any,  // deps unused — short-circuit before any I/O
      );
      expect(env.status).toBe("error");
      expect(env.error?.code).toBe("fatal");
      expect(env.error?.message).toMatch(/run_migrations/);
    });
  });
  ```
- [ ] Run → expect FAIL (`runMigrations` undefined).
- [ ] Minimal impl em `run-migrations.ts`:
  - Imports: `RunMigrationsInput` + types from `../../domain/migrations-v2.js`;
    `assertV2Capability`, `actorOf`, `VerifiedCredential` from
    `../capability.js`/`../auth.js`; `buildV2WriteEnvelope`,
    `WriteEnvelopeV2` from `./envelope-v2.js`; `ReconcileError` from
    `../../domain/errors.js`.
  - Export types: `RunMigrationsCtx`, `RunMigrationsDeps`, plus the
    `runMigrations(input, ctx, deps) => Promise<WriteEnvelopeV2>` function.
  - Body: try `assertV2Capability(cred, "run_migrations")` → catch →
    `toErrorEnvelope(err)`. Mesma helper `toErrorEnvelope` que
    `set-firewall.ts:338-351`.
  - Tudo após o gate é stub (return `applied()` envelope vazio) por enquanto.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations skeleton + capability gate (5.1)`

### Task 5.2 — Input parse via Zod (validation 400 path)

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Failing test:
  ```ts
  it("invalid input (empty target_service) → error envelope precondition", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["run_migrations"]);
    const env = await runMigrations(
      { target_service: "", database: "db",
        migrations: [{ filename: "x.sql", sql: "x" }] } as any,
      { credential: cred, scope: "service" },
      {} as any,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(env.error?.message).not.toMatch(/SELECT|x\.sql|database name|x/);  // value-free
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: `RunMigrationsInput.parse(asRecord(input))` em try;
      catch → `toErrorEnvelope(ReconcileError("precondition", "invalid
      run_migrations input", {entity: "migrations"}))`. Value-free message.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations input parse + precondition envelope (5.2)`

### Task 5.3 — Precondition: target_service must resolve to a container

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: read `core/src/domain/entities.ts:81` (Service shape —
      `container_ids: z.array(z.string()).optional()`). **Divergência da
      spec §1.1 / §4**: a spec menciona `Service.container_id` (singular)
      via `observedStore.getServices()`. O field real é `container_ids`
      (plural, array opcional). Tomar `container_ids[0]` deterministicamente
      (alinha com spec §10 "Multi-replica Postgres routing — picks replica
      0 deterministically").
- [ ] Failing test:
  ```ts
  it("target_service not found in observed services → precondition envelope", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["run_migrations"]);
    const deps = makeDeps({
      servicesProvider: async () => [],  // no services
    });
    const env = await runMigrations(
      { target_service: "pg", database: "db",
        migrations: [{ filename: "x.sql", sql: "SELECT 1" }] },
      { credential: cred, scope: "service" }, deps);
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(env.error?.message).toMatch(/target service not running/);
  });

  it("target_service present but container_ids absent/empty → precondition", async () => {
    const deps = makeDeps({
      servicesProvider: async () => [{ name: "pg", image: "postgres:16", replicas: 1, container_ids: [] }],
    });
    // …expect precondition envelope
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Define `RunMigrationsDeps` interface with
    `servicesProvider: () => Promise<readonly Service[]>` (mesma forma de
    `SetFirewallDeps.serversProvider`).
  - After parse + capability: `const services = await deps.servicesProvider();
    const svc = services.find(s => s.name === input.target_service);
    if (!svc || !svc.container_ids || svc.container_ids.length === 0)
    throw ReconcileError("precondition", "target service not running",
    {entity: \`migrations:${input.target_service}:${input.database}\`})`.
  - `containerId = svc.container_ids[0]` (deterministic replica-0 routing —
    docs §10 invariant).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations target_service resolution precondition (5.3)`

### Task 5.4 — Always-sensitive Approval Gate routing

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: re-read `core/src/agent/v2/set-firewall.ts:255-295` (the
      `gate.evaluate([item], gateCtx)` + `picked.approvalId` pattern).
- [ ] Failing test:
  ```ts
  it("first call → pending_approval envelope; gate is consulted with synthetic PlanItem", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["run_migrations"]);
    const denyOnceGate: ReconcileGate = {
      async evaluate(items, ctx) {
        return {
          approved: [],
          denied: items,
          pendingApprovals: items.map((it, i) => ({
            op: it.op, entity: it.entity, approvalId: `apr_${i}`,
          })),
        };
      },
    };
    const deps = makeDeps({ approvalGate: denyOnceGate });
    const env = await runMigrations(validInput, validCtx, deps);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBe("apr_0");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Add `approvalGate: ReconcileGate` to `RunMigrationsDeps`.
  - Synthetic `PlanItem`:
    ```ts
    const entity = `migrations:${input.target_service}:${input.database}`;
    const item: PlanItem = {
      op: "create",
      entity,
      change: `run ${input.migrations.length} migration(s) against ${entity}`,
      impact: "applies DDL/DML inside the target Postgres — approval required",
    };
    ```
  - Build `GateContext { scope: "agent:" + actor + ":service", actor }`.
  - `decision = await deps.approvalGate.evaluate([item], gctx)`. If
    `decision.denied.length > 0`, pick the matching approval id and return
    `buildV2WriteEnvelope({status: "pending_approval", approval_id})`.
  - **Always sensitive**: o `makeGate(() => true)` é construído no boot
    wiring (Task 9.1) e injetado via `approvalGate`. Aqui o runner apenas
    consome a gate — não decide policy. Documentar no JSDoc do
    `RunMigrationsDeps.approvalGate`: "Caller wires this with `makeGate(()
    => true)` — `run_migrations` é ALWAYS sensitive."
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations always-sensitive gate routing (5.4)`

### Task 5.5 — Apply loop: schema_migrations init + happy path 1 migration

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: re-read spec §1.1 (data flow) e §4 (`docker exec` argv
      form). Confirm argv vector: `["docker", "exec", containerId, "psql",
      "-U", "$POSTGRES_USER", "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
      sql]`. NOTE: `$POSTGRES_USER` literal não interpolado (docker exec
      injeta no shell do container; ZERO shell aqui).
- [ ] Failing test:
  ```ts
  it("happy: 1 migration applied → schema_migrations init runs FIRST, then INSERT", async () => {
    const passThrough: ReconcileGate = {
      async evaluate(items, ctx) {
        return { approved: items, denied: [], pendingApprovals: [] };
      },
    };
    const calls: string[][] = [];
    const dockerExec = async (containerId: string, argv: readonly string[]) => {
      calls.push([containerId, ...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps = makeDeps({ approvalGate: passThrough, dockerExec });
    const env = await runMigrations(
      { target_service: "pg", database: "db",
        migrations: [{ filename: "001_init.sql", sql: "CREATE TABLE x()" }] },
      validCtx, deps);
    expect(env.status).toBe("applied");
    // Expect ≥ 2 docker exec calls: schema_migrations init + the migration apply
    // (the impl may collapse the SELECT + BEGIN+sql+INSERT+COMMIT into fewer
    //  invocations; assert at least both the init AND the INSERT happened).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.join(" ")).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/);
    expect(calls.some(c => c.join(" ").includes("INSERT INTO schema_migrations"))).toBe(true);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Add `dockerExec: (containerId: string, argv: readonly string[]) =>
    Promise<{exitCode: number; stdout: string; stderr: string}>` to deps.
  - After gate approves: first invocation is
    `["psql","-U","$POSTGRES_USER","-d",database,"-v","ON_ERROR_STOP=1",
    "-c","CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT
    PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"]`.
    If exitCode !== 0 → emit `error` envelope + StateEvent fatal-ish;
    abort. (Cobre o caso degenerado de target sem psql.)
  - For each migration: SELECT-exists check via separate exec
    (`-c "SELECT 1 FROM schema_migrations WHERE filename='<file>'"`).
    Parse stdout: `"1\n"` (or similar) → applied; empty → not applied.
    **Cuidado L7**: filename é Zod-validated regex; concat aqui é seguro,
    mas documentar.
  - If not applied: single exec wrapping
    `BEGIN; <sql>; INSERT INTO schema_migrations(filename) VALUES
    ('<file>'); COMMIT;`. ON_ERROR_STOP=1 garante psql aborta na primeira
    falha; commit não executa se rollback fired.
  - Per migration: emit StateEvent via `appendEvent(deps.pool, {actor,
    scope: "service", op: "create", entity, result: "ok" | "noop" |
    "error", after: {filename, duration_ms, ...(error_code ? {error_code} :
    {})}})`. **Sem SQL bytes em payload** (M1 invariante).
  - Return `applied()` envelope com `applied: MigrationReport` (per spec
    §1.6 step 9). NOTE: o WriteEnvelopeV2 atual de `set-firewall.ts` não
    carrega payload extra além de `cost_estimate`/`policy_violations`;
    examinar `envelope-v2.ts` para confirmar como anexar o
    `MigrationReport`. Spec §1.6 mostra "applied: {applied:
    [{filename,result,...}, ...]}" inside the envelope — pode requerer
    extensão minimal de `WriteEnvelopeV2` ou um campo `details` opcional.
    **Decisão da task**: se `WriteEnvelopeV2` não tem campo de payload,
    adicionar campo opcional `report?: MigrationReport` no envelope-v2.ts
    (additive — não quebra envelopes existentes). Documentar no commit
    body.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations happy path 1 migration + init schema_migrations (5.5)`

### Task 5.6 — Idempotency: re-run same batch → all noop

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Failing test:
  ```ts
  it("re-run same batch (filename already in schema_migrations) → result:'noop' per file, zero apply exec", async () => {
    // Script dockerExec: SELECT 1 FROM schema_migrations returns "1\n" for the file.
    const calls: string[][] = [];
    const dockerExec = async (cid: string, argv: readonly string[]) => {
      calls.push([...argv]);
      const sql = argv[argv.indexOf("-c") + 1] ?? "";
      if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) return { exitCode: 0, stdout: "", stderr: "" };
      if (sql.startsWith("SELECT 1 FROM schema_migrations")) return { exitCode: 0, stdout: "1\n", stderr: "" };
      throw new Error("unexpected exec — should not apply if SELECT returned 1");
    };
    const deps = makeDeps({ approvalGate: passThrough, dockerExec });
    const env = await runMigrations(validInput, validCtx, deps);
    expect(env.status).toBe("applied");
    expect(env.report?.applied?.[0]?.result).toBe("noop");
    expect(calls.filter(c => c.some(a => a.includes("BEGIN")))).toHaveLength(0);
  });
  ```
- [ ] Run → expect FAIL (Task 5.5 has no noop branch yet).
- [ ] Minimal impl: in the per-migration loop, after the SELECT check, if
      stdout includes a `1` row count → `report.applied.push({filename,
      result: "noop"})` + emit StateEvent `result: "noop"` + `continue` (no
      BEGIN/INSERT/COMMIT exec).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations noop branch via schema_migrations lookup (5.6)`

### Task 5.7 — Stop-on-first-error + SQLSTATE → error_code mapping

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: spec §2.3 — `SQLSTATE 42*` → `syntax`, `23*` →
      `constraint`, `42501` → `permission`, else → `unknown`. Parser:
      stderr from psql tipicamente contém `SQLSTATE: <code>` em uma linha.
      Regex `/SQLSTATE: (\d{5})/` para extração — depois DESCARTAR stderr
      bytes (M2 invariante).
- [ ] Failing test (3 sub-cases em UM commit — todos exercitam a mesma
      mapping function):
  ```ts
  it.each([
    ["42601", "syntax"],         // syntax_error
    ["42501", "permission"],     // insufficient_privilege
    ["23505", "constraint"],     // unique_violation
    ["08006", "unknown"],        // connection_failure → fallback
  ])("SQLSTATE %s maps to error_code %s", async (sqlstate, expectedCode) => {
    const dockerExec = scriptedExec({
      "CREATE TABLE IF NOT EXISTS schema_migrations": { exitCode: 0, stdout: "", stderr: "" },
      "SELECT 1 FROM schema_migrations": { exitCode: 0, stdout: "", stderr: "" },
      "BEGIN": { exitCode: 1, stdout: "",
                 stderr: `ERROR: ...\nSQLSTATE: ${sqlstate}\n` },
    });
    const env = await runMigrations(twoMigrationsInput, validCtx,
      makeDeps({ approvalGate: passThrough, dockerExec }));
    expect(env.report?.applied?.[0]?.result).toBe("error");
    expect(env.report?.applied?.[0]?.error_code).toBe(expectedCode);
    // Stop-on-first: migration 2 never attempted (no entry, OR an entry
    // not present beyond the failed one — assert applied has length 1).
    expect(env.report?.applied).toHaveLength(1);
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Pure helper `function classifySqlstate(stderr: string):
    MigrationErrorCode` — extracts `/SQLSTATE: (\d{5})/`, then prefix
    match: `42501` → permission, `42*` → syntax, `23*` → constraint, else
    → unknown.
  - Apply branch: when exec `exitCode !== 0` after the SELECT-not-found
    check, classify via the helper. Push `{filename, result: "error",
    error_code}` to report. Emit StateEvent `result: "error"` (sem stderr
    em payload). `break` the loop (stop-on-first).
  - HTTP status fica 200 e envelope status `applied` (per spec §2.3) —
    NÃO mapear para error envelope. O caller observa per-migration
    `result: "error"` no `report.applied`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations SQLSTATE→error_code + stop-on-first (5.7)`

### Task 5.8 — `container_exited` handling

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Failing test:
  ```ts
  it("docker exec on stopped container → error_code:'container_exited', batch stops", async () => {
    // Docker Engine returns exitCode=126 (or specific message) when target container is not running.
    // Modelar via dockerExec retornando shape distinto (e.g. throw with sentinel).
    const dockerExec = async (cid: string, argv: readonly string[]) => {
      throw new ReconcileError("transient", "docker exec failed: container is not running",
        { entity: "service:" + cid });
    };
    const env = await runMigrations(validInput, validCtx,
      makeDeps({ approvalGate: passThrough, dockerExec }));
    expect(env.report?.applied?.[0]?.error_code).toBe("container_exited");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: wrap `dockerExec` call em try/catch. If thrown
      ReconcileError message matches `/not running|container.* exited/` →
      `error_code: "container_exited"`. Else (network/SSH) →
      `error_code: "unknown"`. Both stop the batch. Sem leak da error
      message original em StateEvent payload.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations container_exited handling (5.8)`

### Task 5.9 — Per-migration timeout: SIGTERM 200ms grace SIGKILL → `timeout`

- Files: `core/src/agent/v2/run-migrations.ts`,
  `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Failing test:
  ```ts
  it("dockerExec hangs past MIGRATION_TIMEOUT_MS → error_code:'timeout', batch stops", async () => {
    const dockerExec = async () => new Promise<never>(() => {});  // never resolves
    const deps = makeDeps({
      approvalGate: passThrough, dockerExec,
      timeoutMs: 50,  // short for the test
    });
    const env = await runMigrations(validInput, validCtx, deps);
    expect(env.report?.applied?.[0]?.error_code).toBe("timeout");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Add `timeoutMs: number` to `RunMigrationsDeps` (caller supplies from
    `config.MIGRATION_TIMEOUT_MS`).
  - Wrap each `dockerExec` invocation em `Promise.race` com `AbortController` +
    `setTimeout(deps.timeoutMs)`. On timer fire: abort controller (caller's
    `dockerExec` honra `signal` via `opts.signal`); clear timer in finally.
  - Throw / map ReconcileError `transient timeout` → `error_code: "timeout"`.
  - **SIGTERM/SIGKILL semantics**: o SSH transport layer
    (`ssh-exec.ts:runSsh`) já implementa SIGTERM → grace → SIGKILL no
    timeout do `connectTimeoutMs` / kill-after-watchdog. Aqui o runner só
    propaga o AbortSignal — implementação completa do kill ladder vive em
    `ssh-exec.ts`. Documentar no JSDoc do `dockerExec` deps: "deve honrar
    `opts.signal` e propagar abort para o SSH child."
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): runMigrations per-migration timeout abort (5.9)`

### Task 5.10 — Sentinel leak prevention (M2 invariante)

- Files: `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: spec §3 M2 — "no Postgres error text em
      response/log/event". Spec §3 introduz sentinel
      `S3CR3T-6.2-migration-leak-XYZ`. Confirmar que matches regex em
      `.gitleaks.toml` (`S3CR3T-[0-9.]+-[a-z-]+-[A-Za-z0-9]+`) — yes (segmento
      `6.2`, segmento `migration-leak`, segmento `XYZ`).
- [ ] Failing test:
  ```ts
  it("L5: PG stderr containing S3CR3T-6.2-migration-leak-XYZ never leaks into report/envelope/event", async () => {
    const dockerExec = scriptedExec({
      "CREATE TABLE IF NOT EXISTS schema_migrations": { exitCode: 0, stdout: "", stderr: "" },
      "SELECT 1 FROM schema_migrations": { exitCode: 0, stdout: "", stderr: "" },
      "BEGIN": { exitCode: 1, stdout: "",
                 stderr: 'ERROR:  password "S3CR3T-6.2-migration-leak-XYZ" must be quoted\nSQLSTATE: 42601\n' },
    });
    const env = await runMigrations(validInput, validCtx,
      makeDeps({ approvalGate: passThrough, dockerExec, appendEvent: spyAppendEvent }));
    expect(JSON.stringify(env)).not.toMatch(/S3CR3T/);
    expect(JSON.stringify(spyAppendEvent.calls)).not.toMatch(/S3CR3T/);
  });
  ```
- [ ] Run → expect (provavelmente já PASS após Task 5.7 dada a discipline
      de só usar `error_code` enum). Se algum lugar leaka, fix in this
      task; senão, este é test reinforço.
- [ ] Commit: `test(core): runMigrations L5 sentinel never leaks (5.10)`

### Task 5.11 — Argv form: `-c "<sql>"` (no temp file, no stdin)

- Files: `core/src/agent/v2/run-migrations.test.ts`.
- [ ] Familiarise: spec §4 — "SQL passes as argv (no temp file, no stdin
      streaming)". Assertion direta sobre `dockerExec` callLog.
- [ ] Failing test:
  ```ts
  it("argv form: SQL is passed via '-c' argv pair, not via stdin or temp file", async () => {
    const calls: string[][] = [];
    const dockerExec = async (cid: string, argv: readonly string[]) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "1\n", stderr: "" };  // pretend already applied so we exit fast
    };
    await runMigrations({ target_service: "pg", database: "bevox",
      migrations: [{ filename: "001_x.sql", sql: "CREATE TABLE foo();" }] },
      validCtx, makeDeps({ approvalGate: passThrough, dockerExec }));
    // Find the SELECT exec; its argv should be ["psql", "-U", ..., "-d", "bevox",
    //  "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1 FROM schema_migrations WHERE filename='001_x.sql'"]
    const selectCall = calls.find(c => c.some(a => a.startsWith("SELECT 1")));
    expect(selectCall).toBeDefined();
    const dashCIdx = selectCall!.indexOf("-c");
    expect(dashCIdx).toBeGreaterThan(-1);
    expect(selectCall![dashCIdx + 1]).toMatch(/^SELECT 1 FROM schema_migrations/);
    // Assert no `<` or `-f` or file path in argv (no stdin, no temp file).
    expect(selectCall!.some(a => a === "-f" || a.startsWith("/tmp/") || a === "<")).toBe(false);
  });
  ```
- [ ] Run → expect PASS (Task 5.5 impl should already follow this form).
      If fails, fix the impl to use `-c "<sql>"` only.
- [ ] Commit: `test(core): runMigrations argv form -c only (5.11)`

### Task 5.12 — StateEvent per migration (M1: no sql bytes in payload)

- Files: `core/src/agent/v2/run-migrations.test.ts`,
  `core/src/agent/v2/run-migrations.ts` (if impl drift caused leak).
- [ ] Failing test:
  ```ts
  it("each migration emits one StateEvent with actor + scope:'service' + entity 'migrations:<svc>:<db>'", async () => {
    const events: any[] = [];
    const appendEvent = async (pool: any, evt: any) => { events.push(evt); };
    await runMigrations(
      { target_service: "pg", database: "bevox",
        migrations: [
          { filename: "001.sql", sql: "CREATE TABLE x()" },
          { filename: "002.sql", sql: "CREATE TABLE y()" },
        ] },
      { credential: validCred, scope: "service" },
      makeDeps({ approvalGate: passThrough, dockerExec: happyExec, appendEvent }));
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.actor).toBe("agent:test");
      expect(e.scope).toBe("service");
      expect(e.entity).toBe("migrations:pg:bevox");
      expect(e.op).toBe("create");
      expect(["ok","noop","error"]).toContain(e.result);
      expect(JSON.stringify(e)).not.toContain("CREATE TABLE x");  // M1: no sql bytes
      expect(JSON.stringify(e)).not.toContain("CREATE TABLE y");
    }
  });
  ```
- [ ] Run → expect PASS (Task 5.5 impl should already be doing this).
- [ ] Commit: `test(core): runMigrations StateEvent shape per migration M1 (5.12)`

**Done (Task 5) =** Runner core completo. ~12 cenários verdes em
`run-migrations.test.ts`. Sem REST/MCP wiring.

---

# Task 6 — Approval gate routing (always-sensitive coverage)

**Goal/deliverable:** `approval-gate.test.ts` extended com cenário
`run_migrations` always-sensitive — confirma que makeGate(() => true)
withholds o item synthetic `migrations:*` na primeira chamada.

**Exit criteria:** novo it/case verde em `approval-gate.test.ts`. Suite
total preserva todos os outros casos.

### Task 6.1 — `run_migrations` is always-sensitive (gate withholds first call)

- Files: `core/src/agent/approval-gate.test.ts`.
- [ ] Familiarise: read `approval-gate.test.ts` describe blocks atuais;
      identify o helper que constrói `createApprovalGate(...)` com pg
      harness — reusar.
- [ ] Failing test (new describe block):
  ```ts
  describe("always-sensitive — run_migrations synthetic item", () => {
    it("withholds the migrations:<svc>:<db> item on first call; approved retry passes", async () => {
      const gate = createApprovalGate({ pool, clock, idFactory });
      const item: PlanItem = {
        op: "create",
        entity: "migrations:postgres:bevox_harness",
        change: "run 3 migration(s) against migrations:postgres:bevox_harness",
        impact: "applies DDL/DML — approval required",
      };
      const gctx: GateContext = { scope: "agent:test:service", actor: "agent:test" };
      const sensitiveAlways = (_it: PlanItem) => true;
      // First call: withhold
      const dec1 = await gate.evaluate([item], gctx, sensitiveAlways);  // signature varies — adapt to actual API
      expect(dec1.denied).toHaveLength(1);
      expect(dec1.pendingApprovals[0]?.approvalId).toMatch(/^apr_/);
      // Approve
      await gate.resolveApproval(dec1.pendingApprovals[0]!.approvalId, "approved");
      // Retry → approved
      const dec2 = await gate.evaluate([item], gctx, sensitiveAlways);
      expect(dec2.approved).toHaveLength(1);
    });
  });
  ```
  **NOTE**: a signature exata de `gate.evaluate` (com vs sem
  isSensitive arg) varia conforme o tipo `ReconcileGate`. Adapt the test
  to whatever the existing `approval-gate.ts` exports — pattern same as
  v1 catalog ops (always-sensitive) já cobertos.
- [ ] Run → expect PASS (o gate é genérico — qualquer
      `isSensitive(item) → true` triggers the same withhold path; este
      test é guard contra regressões futuras).
- [ ] Commit: `test(core): approval gate always-sensitive run_migrations item (6.1)`

**Done (Task 6) =** Gate behavior em entity synthetic `migrations:*` é
explicitly tested.

---

# Task 7 — REST wire + MCP wire

**Goal/deliverable:** `rest.ts` ganha optional `runMigrations?:
RunMigrationsDeps` field + `POST /api/v2/migrations` route (single-source
forward para `runMigrations()`). `mcp.ts` ganha optional dep + tool
registration when wired. Mesma forma de `set-firewall` wiring.

**Exit criteria:** `run-migrations.rest.test.ts` + `run-migrations.mcp.test.ts`
verdes; `npm --prefix core test core/src/agent/rest.test.ts` ainda verde
(byte-stable).

### Task 7.1 — REST: optional seam + route

- Files: `core/src/agent/rest.ts`,
  `core/src/agent/v2/run-migrations.rest.test.ts` (NEW).
- [ ] Familiarise: read `core/src/agent/rest.ts:766-796` (set_firewall
      route as canonical pattern).
- [ ] Failing test em `run-migrations.rest.test.ts`:
  ```ts
  it("seam absent → POST /api/v2/migrations is 404", async () => {
    const server = createRestServer({ /* no runMigrations dep */ });
    const res = await callIn(server, "POST", "/api/v2/migrations", { /* body */ });
    expect(res.status).toBe(404);
  });

  it("seam present → 200 envelope status:'applied' even when per-migration error", async () => {
    // wire a runMigrations deps whose dockerExec returns scripted PG error
    // assert HTTP 200 and envelope.report.applied[0].result === "error"  (per spec §2.3)
  });

  it("missing run_migrations cap on token → 403", async () => {
    // …
  });
  ```
- [ ] Run → expect FAIL (route does not exist).
- [ ] Minimal impl em `rest.ts`:
  - Add `readonly runMigrations?: RunMigrationsDeps;` to `RestDeps`
    (mesma posição que `setFirewall?` ~ linha 207).
  - Capture `const runMigrationsDeps = deps.runMigrations;` na função
    factory (mesma posição que `setFirewallDeps`).
  - New route block (após `set_ingress` ou no fim do v2 cluster):
    ```ts
    if (path === "/api/v2/migrations" && method === "POST" && runMigrationsDeps !== undefined) {
      const cred = authenticateRequest(req, credentials);
      const body = await readJsonBody(req);
      const env = await runMigrations(body as RunMigrationsInput,
        { credential: cred, scope: "service" }, runMigrationsDeps);
      // HTTP 200 even when per-migration error (per spec §2.3).
      const status = env.status === "error"
        ? (STATUS_BY_CLASS[(env.error?.code as keyof typeof STATUS_BY_CLASS) ?? "fatal"] ?? 500)
        : 200;
      sendJson(res, status, env);
      return;
    }
    ```
- [ ] Run → expect PASS. Confirm `rest.test.ts` still green
      (route is conditional, absent by default).
- [ ] Commit: `feat(core): REST POST /api/v2/migrations route (7.1)`

### Task 7.2 — MCP: optional dep + tool registration

- Files: `core/src/agent/mcp.ts`,
  `core/src/agent/v2/run-migrations.mcp.test.ts` (NEW).
- [ ] Familiarise: read `core/src/agent/mcp.ts:79-131` (set_firewall opt
      pattern) + `mcp.ts:600-640` (tool dispatch).
- [ ] Failing test em `run-migrations.mcp.test.ts`:
  ```ts
  it("seam absent → 'run_migrations' NOT in tools/list response", async () => {
    const server = createMcpServer({ v2Tools: new Set(), /* no runMigrations */ });
    const tools = await listTools(server);
    expect(tools.map(t => t.name)).not.toContain("run_migrations");
  });

  it("seam present + v2Tools includes 'run_migrations' → tool callable", async () => {
    const server = createMcpServer({
      v2Tools: new Set(["run_migrations"]),
      runMigrations: validDeps,
    });
    const tools = await listTools(server);
    expect(tools.map(t => t.name)).toContain("run_migrations");
    const result = await callTool(server, "run_migrations", validInput);
    expect(result.status).toBe("applied");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl em `mcp.ts`:
  - Add `readonly runMigrations?: RunMigrationsDeps;` to `McpDeps`
    (mesma posição que `setFirewall?`).
  - Add const `V2_RUN_MIGRATIONS = "run_migrations";` (mesma posição que
    `V2_SET_FIREWALL`).
  - Add conditional tool registration:
    `if (v2Tools.has("run_migrations") && deps.runMigrations) { ... }`.
  - In the dispatch switch, route `case V2_RUN_MIGRATIONS:` →
    `await runMigrations(parsedInput, ctx, deps.runMigrations)`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): MCP run_migrations v2 tool registration (7.2)`

**Done (Task 7) =** Both REST and MCP transport wires the single-source
`runMigrations()` function. Both opt-in via deps.

---

# Task 8 — Integration test against pg-harness

**Goal/deliverable:** `run-migrations.integration.test.ts` exerce o runner
contra um Postgres real (pg-harness port 5546). `dockerExec` é um adapter
in-memory que proxia `psql -c <sql>` invocations para a pool do harness.

**Exit criteria:** integration test verde quando o `DATABASE_URL_TEST`
container está rodando (mesmo padrão que outros tests no projeto que tocam
pg-harness real).

### Task 8.1 — pg-harness integration: 3-migration batch + re-run + conflict

- Files: `core/src/agent/v2/run-migrations.integration.test.ts` (NEW).
- [ ] Familiarise: read `core/src/agent/approval-gate.test.ts` para o
      pattern `beforeAll(resetSchema) + afterAll(closeTestPool)` + use of
      `getTestPool()`.
- [ ] Failing test:
  ```ts
  describe("run-migrations integration — real Postgres via pg-harness", () => {
    let pool: pg.Pool;
    beforeAll(async () => {
      pool = getTestPool();
      await resetSchema(pool);  // core's own migrations (state_events, approvals, etc.)
    });
    afterAll(() => closeTestPool());

    it("applies 3 migrations against real PG; schema_migrations rowcount=3", async () => {
      // dockerExec adapter: parse the argv, find "-c"+<sql>, run via pool.query.
      const dockerExec = makePgHarnessDockerExec(pool);
      const env = await runMigrations({
        target_service: "pg", database: "postgres",  // pg-harness default db
        migrations: [
          { filename: "001_t1.sql", sql: "CREATE TABLE t1 (id INT PRIMARY KEY);" },
          { filename: "002_t2.sql", sql: "CREATE TABLE t2 (id INT PRIMARY KEY);" },
          { filename: "003_t3.sql", sql: "CREATE TABLE t3 (id INT PRIMARY KEY);" },
        ]
      }, validCtx, makePgHarnessDeps(pool, dockerExec));
      expect(env.status).toBe("applied");
      const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text FROM schema_migrations");
      expect(rows[0]?.count).toBe("3");
    });

    it("re-runs same batch → all noop, schema_migrations still 3 rows", async () => { /* … */ });

    it("3rd migration has constraint violation → ROLLBACK; schema_migrations stays at 2 rows", async () => {
      // migration 3 is "INSERT duplicate PK" or "create existing table"
      // assert report.applied[2].result === "error", error_code === "constraint"
      // assert schema_migrations does NOT contain migration 3
    });
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  - Helper `makePgHarnessDockerExec(pool: pg.Pool): DockerExecFn` que
    parsa o argv para encontrar `["-c", sql]`, executa `pool.query(sql)`,
    e mapeia o resultado para `{exitCode, stdout, stderr}`. Errors do PG
    são mapeados para `exitCode: 1, stderr: "ERROR: ...\nSQLSTATE: " +
    err.code` (mesma forma que psql escreve).
  - Helper `makePgHarnessDeps(pool, dockerExec)` constrói o full
    `RunMigrationsDeps` (pool real, passThrough gate, fake
    servicesProvider retornando `[{name:"pg", container_ids:["fake"]}]`,
    timeoutMs alto).
  - Cleanup hook `afterEach(async () => pool.query("DROP TABLE IF EXISTS
    schema_migrations, t1, t2, t3"))` para isolation entre cases.
- [ ] Run → expect PASS (com pg-harness rodando).
- [ ] **Document explicitly in the file header**: "This test uses the
      pg-harness on port 5546 — same pattern legitimised by
      `approval-gate.test.ts`, `idempotency.property.test.ts`. It is NOT a
      `@live` test (lives in `core/src/...`, not `core/test/live/...`).
      Disposable PG is the test fake."
- [ ] Commit: `test(core): runMigrations integration against pg-harness (8.1)`

**Done (Task 8) =** Integration coverage prova o end-to-end transactional +
idempotency invariantes contra Postgres real.

---

# Task 9 — Property test extension (idempotency under N apply cycles)

**Goal/deliverable:** caso novo em `idempotency.property.test.ts` exercita
runner com batches gerados; após cycle 1, cycles 2..N são strict no-op em
`schema_migrations`.

**Exit criteria:** novo property verde com seeded fast-check;
schema_migrations.rowcount byte-identical entre cycle 2 e cycle N.

### Task 9.1 — Property: N-apply migration batch → cycle 2..N strict no-op

- Files: `core/src/reconciler/idempotency.property.test.ts`.
- [ ] Familiarise: read `idempotency.property.test.ts` actual structure;
      identify the harness pattern (resetSchema per sample, deterministic
      arbitrary, pg pool injection).
- [ ] Failing test (novo property block — adicionar ao fim do file):
  ```ts
  describe("Property — migration batches converge in 1 cycle", () => {
    it("N applies of the same batch → schema_migrations byte-identical from cycle 2", async () => {
      await fc.assert(fc.asyncProperty(arbMigrationBatch(), async (batch) => {
        const pool = getTestPool();
        await resetSchema(pool);
        const dockerExec = makePgHarnessDockerExec(pool);
        const deps = makePgHarnessDeps(pool, dockerExec);
        await runMigrations(batch, validCtx, deps);
        const snap1 = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
        for (let i = 0; i < 4; i++) {
          await runMigrations(batch, validCtx, deps);
          const snapN = await pool.query("SELECT filename FROM schema_migrations ORDER BY filename");
          expect(snapN.rows).toEqual(snap1.rows);
        }
      }), { numRuns: 5 });  // small numRuns since each is full reset
    });
  });
  ```
- [ ] Run → expect FAIL or PASS depending on the runner's correctness so
      far. If FAIL: it's likely a SELECT-vs-INSERT race in the noop branch
      — fix in this commit.
- [ ] Minimal impl: define `arbMigrationBatch` arbitrary using fast-check
      (batch 1..5 migrations, deterministic safe SQL like `CREATE TABLE
      IF NOT EXISTS t<i>()`).
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): property — migration batch idempotency N cycles (9.1)`

**Done (Task 9) =** Idempotency property covered end-to-end.

---

# Task 10 — Boot wiring + entrypoint-wiring smoke

**Goal/deliverable:** `entrypoint-wiring.ts:buildBootDeps` constrói
`runMigrationsDeps` real:
- `servicesProvider`: closure over `observed-store.getState(pool, "service")`
- `dockerExec`: closure over the existing `createSshTransports().docker`
  raw exec primitive (or a slim adapter over `runSsh`)
- `approvalGate`: a gate built with `makeGate(() => true)` (always-sensitive)
- `pool`, `appendEvent`, `timeoutMs: config.MIGRATION_TIMEOUT_MS`.

Smoke test in `entrypoint-wiring.test.ts` verifies the deps appear.

**Exit criteria:** `buildBootDeps` returns `{ runMigrations: {...} }` when
`MIGRATION_TIMEOUT_MS` é parsável; suite verde full.

### Task 10.1 — Wire `runMigrationsDeps` in `buildBootDeps`

- Files: `core/src/entrypoint-wiring.ts`,
  `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: read `entrypoint-wiring.ts:244-263` (the
      `setFirewallPieces` block — same pattern of "static pieces here, full
      deps assembled in server.ts").
- [ ] Failing test em `entrypoint-wiring.test.ts`:
  ```ts
  it("buildBootDeps wires runMigrations pieces (timeoutMs + dockerExec adapter)", async () => {
    const cfg = makeConfig({ MIGRATION_TIMEOUT_MS: "30000" });
    const deps = buildBootDeps(cfg, transports);
    expect(deps.runMigrationsPieces).toBeDefined();
    expect(deps.runMigrationsPieces?.timeoutMs).toBe(30_000);
    expect(typeof deps.runMigrationsPieces?.dockerExec).toBe("function");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl em `entrypoint-wiring.ts`:
  - After `setFirewallPieces`:
    ```ts
    const runMigrationsPieces = {
      timeoutMs: config.MIGRATION_TIMEOUT_MS,
      dockerExec: createDockerExecOverSsh(transports.docker(config), config),
    };
    ```
    where `createDockerExecOverSsh` is a slim adapter (~20 lines) that
    builds an exec context via the Docker transport's HTTP wire +
    consumes the result. **Decision**: implement it inline in
    `entrypoint-wiring.ts` or factor into
    `core/src/providers/docker-exec-adapter.ts` (new file, ~30 LOC).
    Prefer separate file for one-responsibility hygiene.
  - Add `runMigrationsPieces` to the returned object.
  - server.ts then assembles the full `RunMigrationsDeps` by combining
    `runMigrationsPieces` + the catalog's existing `approvalGate` +
    `servicesProvider` (closure over `observed-store.getState(pool,
    "service")`) + `pool` + `appendEvent`. NOTE: this mirrors how
    `setFirewall` deps are assembled in server.ts (NOT in entrypoint-wiring).
- [ ] Run → expect PASS.
- [ ] **MUDANÇA EM `server.ts`**: adicionar campo opcional
      `runMigrations?: RunMigrationsDeps` ao `BootDeps` interface (same
      additive pattern as `setFirewall?: SetFirewallDeps`); em
      `createServer`, when `runMigrations` is present, thread through to
      both REST handler factory and MCP handler factory. **Esta é a única
      mudança em `server.ts` deste plano** — citar spec §6 no commit body
      explicando o necessário-mas-mínimo desvio (mesmo argumento do
      secret-resolver plan Task 5.3).
- [ ] Commit: `feat(core): buildBootDeps wires runMigrations pieces (10.1)`

**Done (Task 10) =** Daemon boots com `run_migrations` tool wired end-to-end.
Production pode chamar o tool. Suite full verde.

---

# Task 11 — Docs (`.env.example` + CHANGELOG + optional @live scaffold)

**Goal/deliverable:** `.env.example` documenta `MIGRATION_TIMEOUT_MS` +
nota sobre cap `run_migrations`. `CHANGELOG.md` `[Unreleased]` entry
explica v2 additive. Optional scaffold `core/test/live/run-migrations.live.test.ts`
(skipped in CI).

**Exit criteria:** docs revisáveis; no production code in `core/src/`
changing.

### Task 11.1 — `.env.example` + CHANGELOG

- Files: `core/.env.example`, `CHANGELOG.md`.
- [ ] Familiarise: read `core/.env.example` current; read prior CHANGELOG
      entries for tone.
- [ ] Doc edits (sem failing test — review-only verification):
  - `core/.env.example`: append comment block:
    ```
    # MIGRATION_TIMEOUT_MS — per-migration timeout for run_migrations (v2 tool).
    #   Default: 60000 (60s). Range: [1000, 600000] (1s to 10min).
    #   Bound is per-migration; a batch of 10 migrations can take up to 10×.
    #   Operator splits a long migration into smaller ones if needed.
    # MIGRATION_TIMEOUT_MS=60000
    #
    # The run_migrations capability — agents that need to apply migrations must
    # include "run_migrations" in their capabilities array in AGENT_CREDENTIALS.
    # Always-sensitive: every call requires Approval Gate approval.
    ```
  - `CHANGELOG.md` `[Unreleased]` / Added:
    ```
    - `run_migrations` v2 tool (additive — 8th v2 tool) — forward-only
      idempotent SQL migrations against a daemon-managed Postgres service.
      Always-sensitive (passes Approval Gate). Per-migration transaction;
      stops on first error. Synthetic entity `migrations:<svc>:<db>`.
      `MIGRATION_TIMEOUT_MS` config knob (default 60s, range [1s, 10min]).
      ALL_TOOLS (12) FROZEN byte-identical; V2_TOOLS now 8.
      Spec: docs/specs/2026-05-28-migration-runner-v1.md.
    ```
- [ ] Confirm: no mention of resolved secret values; no SQL bytes.
- [ ] Commit: `docs: run_migrations env.example + CHANGELOG (11.1)`

### Task 11.2 — `@live` test scaffold (skipped in CI)

- Files: `core/test/live/run-migrations.live.test.ts` (NEW).
- [ ] Familiarise: confirm `core/vitest.config.ts` excludes
      `**/*.live.test.ts` from the `unit` project. Find an existing
      `*.live.test.ts` file (if any) for the boilerplate.
- [ ] Implementation (placeholder for operator's pre-release smoke):
  - File documents the manual procedure: real PG container running on a
    Hetzner VM accessible via SSH, agent credential with
    `run_migrations` cap, env vars `HETZNER_LIVE_TOKEN`,
    `BEVOX_DAEMON_BASE_URL`, etc.
  - One `describe.skip` block with the actual test code (so a developer
    flips `.skip` to `.only` to run it locally pre-release).
  - Assertions: payload `{filename:"_smoke_<timestamp>.sql", sql:"CREATE
    TABLE IF NOT EXISTS _bevox_smoke (run_at TIMESTAMPTZ DEFAULT NOW());
    INSERT INTO _bevox_smoke DEFAULT VALUES;"}` → `result === "ok"`. PG
    row count 1.
- [ ] **NO test assertion will run in CI** (file excluded by vitest
      glob). Verification: `npm --prefix core test` should NOT mention
      this file.
- [ ] Commit: `test(core): @live smoke scaffold for run_migrations (11.2)`

**Done (Task 11) =** Docs e @live placeholder entregues. Plan complete.

---

## Fora de escopo / depende de credenciais reais

Spec §10 lista non-goals YAGNI v1. Itens principais:

- Rollback / DOWN migrations — forward-only v1; operator escreve nova UP
  para "undo".
- Multi-DB per call — uma DB por call; multi-DB = múltiplos calls.
- Multi-replica Postgres routing — picks replica 0 deterministically.
- Auto-detect target — operator passa `target_service` explicitly.
- Connection-string-based connect (non-docker DBs) — tool é exclusively
  para daemon-managed Docker services.
- Non-Postgres engines — MySQL/SQLite/etc. NOT supported.
- Streaming/long-running migrations (>10min).
- File-source migrations (volume/URL/git ref).
- `list_migrations` read tool — operator queries `schema_migrations`
  manually via `docker exec psql`.
- Smart retries on transient errors.
- @live smoke test contra daemon real — manual, post-merge, pré-tag
  (Task 11.2 scaffold).

## Divergências da spec (decisões registradas)

1. **`TOOL_POLICY` NÃO é estendido** (spec §1.3 sugeria). O type
   `Readonly<Record<ToolName, ToolPolicy>>` é bound a `ToolName` (= the
   v1 12). v2 tools (incluindo `run_migrations`) hardcodam sensitivity no
   próprio módulo (`makeGate(() => true)` injetado via deps), mesma
   pattern de `set-firewall.ts` et al. Preserva `TOOL_POLICY`
   byte-identical.
2. **`Service.container_ids` (plural array), não `container_id`** (spec
   §1.1/§4 menciona singular). O field real em
   `core/src/domain/entities.ts:81` é `container_ids: z.array(z.string()).optional()`.
   Runner pega `container_ids[0]` (replica-0 routing per spec §10).
3. **Naming collision noted**: existing `core/src/store/db.ts` exports
   `runMigrations(pool)` — internal core schema migration runner (sets up
   `state_events`, `approvals`, etc.). The new tool function is
   ALSO named `runMigrations(input, ctx, deps)` em
   `core/src/agent/v2/run-migrations.ts`. Different namespaces (different
   files, different exports). No actual conflict, but reviewer should be
   aware: imports must be path-explicit (e.g. `import { runMigrations as
   runDbMigrations } from "../../store/db.js"` IF a single file ever needs
   both — unlikely in this plan).
4. **Spec §5 cites `core/test/fakes/ssh-exec.ts` "from Task 7.2"**.
   That file does NOT exist (only `core/src/providers/ssh-exec.ts` in
   prod). Plan creates the SshRunner-shaped recorder fake as
   `core/test/fakes/ssh-exec-recorder.ts` (Task 4.2) — name is explicit
   about its purpose, no overlap with prod path.
5. **Integration test legitimate use of pg-harness real PG**: per
   project convention (`approval-gate.test.ts`,
   `idempotency.property.test.ts`, etc. all hit pg-harness on port
   5546), this is not a "real infra" violation. Flagged in Task 8.1
   header comment.
6. **`server.ts` minimal touch (~2 lines)**: same situation as Task 5.3 of
   the secret-resolver plan — `BootDeps` interface gains an additive
   optional field `runMigrations?: RunMigrationsDeps`. This is
   strictly additive (no existing path changes), aligned with the
   `setFirewall?: SetFirewallDeps` precedent already in `server.ts`.
   Documented as a necessary-but-minimal divergence from the spec's "DI
   surface unchanged" claim.
7. **`WriteEnvelopeV2` may need optional `report` field** (Task 5.5
   decision). The current v2 envelope from `envelope-v2.ts` does not have a
   slot for a per-migration report. Adding an optional `report?:
   MigrationReport` is additive and does not break existing v2 envelopes.
   Alternative: nest under a generic `details?: unknown` if envelope-v2
   already has one — Task 5.5 decides during impl based on the actual
   envelope shape.

## Done = (per task, summary)

- **Task 1:** Zod schemas for `RunMigrationsInput` + `MigrationReport*`
  validated; no consumer.
- **Task 2:** V2_TOOLS length 8 + `run_migrations` membership;
  ALL_TOOLS=12 FROZEN preserved; v2 contract-conformance bump.
- **Task 3:** `MIGRATION_TIMEOUT_MS` config knob; `intKnob` extended with
  optional max.
- **Task 4:** `docker-http.ts` exec/start endpoints + `ssh-exec-recorder.ts`
  fake with argv capture.
- **Task 5:** `MigrationRunner` core — capability gate, input parse,
  target_service precondition, always-sensitive approval routing,
  schema_migrations init, happy path, noop branch, SQLSTATE→error_code,
  stop-on-first-error, container_exited, timeout, sentinel leak
  prevention, argv form, StateEvent per migration. ~12 scenarios.
- **Task 6:** Approval Gate always-sensitive coverage for migrations
  entity.
- **Task 7:** REST + MCP wires (optional seam, single-source delegation
  to `runMigrations()`).
- **Task 8:** Integration test against pg-harness real PG (3-mig batch,
  re-run noop, conflict ROLLBACK).
- **Task 9:** Idempotency property — N apply cycles → schema_migrations
  byte-identical.
- **Task 10:** `buildBootDeps` wires `runMigrationsPieces`; `server.ts`
  threads `BootDeps.runMigrations?` through to REST+MCP factories.
- **Task 11:** `.env.example` + CHANGELOG + `@live` scaffold (skipped in CI).

**Total: 11 tasks (sub-tasks 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 5.1–5.12,
6.1, 7.1, 7.2, 8.1, 9.1, 10.1, 11.1, 11.2) = 28 commits.**

**Suite expected:** baseline ~1071 → ~1091/2 skipped (1 `@live`). Golden
(`secret-apply.test.ts`) + stub (`secrets.test.ts`) byte-identical.
ALL_TOOLS=12 FROZEN preserved.
