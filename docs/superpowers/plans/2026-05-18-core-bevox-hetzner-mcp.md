# Core bevox-hetzner-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. Each task is a self-contained TDD unit (failing test → run → minimal impl → run → commit). Do not skip the red step. Do not batch commits.

**Goal:** Build the agent-native control plane core for bevox-hetzner-mcp: a declarative desired-state store + idempotent reconciler that converges Hetzner/Docker reality via proven primitives, exposed to OpenClaw/Vox agents and the operational console through an MCP server and a REST API that exactly matches the frozen console contract.

**Architecture:** Six single-responsibility layers — Domain/State Store (git YAML canonical + Postgres working/observed) → Providers (HetznerCloud, HetznerDNS, Docker-over-SSH, WireGuard, restic) → Reconciler (Observe→Plan→Gate→Apply→Record with advisory locks) → Agent Interface (MCP + REST + capability scope) → Approval Gate → Observability. State is declarative and reconciled idempotently; failures are fail-safe (never fail-deleting); drift is reported, never silently corrected.

**Tech Stack: RATIFICADO 2026-05-18 (Bernard):** Node.js 20+, TypeScript 5.x (ESM / `NodeNext`, `strict`), `@modelcontextprotocol/sdk`, PostgreSQL 16 via `pg`, official Hetzner Cloud SDK + hcloud DNS API, Docker Engine API via SSH, WireGuard, restic, Zod, Pino, Vitest + HTTP fakes. This stack is **ratified** — not subject to re-confirmation; deviations require a new spec revision.

---

## How this plan is executed

This is a **single master plan covering Fases 1–6**, but it is **executed phase by phase**. Each `Fase N` section is self-contained and **produces working, testable software on its own** — the spec mandates incremental build (`docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` §"Fases internas"). Do not start Fase N+1 until Fase N's "Done =" definition holds and CI is green. `Task 0` is a blocking gate before Fase 1.

New `core/` sub-package, sibling to `console/`. All paths below are relative to the repository root.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail (red) → minimal implementation → run, see it pass (green) → commit. Reference @superpowers:test-driven-development.
- **DRY / YAGNI / minimal change**: build only what the phase needs. No speculative abstraction. Reference @superpowers:verification-before-completion before any "done" claim.
- **Frequent commits**: one task = one commit. Commit message trailer is mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Tests never touch real infra**: Hetzner/Docker/SSH/restic calls go through a mockable provider interface only. A `@live` suite exists but is opt-in/manual and never runs in CI.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — non-negotiable integration boundary

The Agent Interface (Fase 4) REST endpoints and envelopes **MUST match `console/CONTRACT.md` and `console/src/api/contract.ts` verbatim**. The console is already built and consumes this API through an MSW fake derived from `contract.ts`. `contract.ts` is the **executable truth**; the core's REST responses must parse cleanly against those exact Zod schemas. Treat any divergence as a core bug, never a contract change.

### Tool → REST endpoint table (from `console/CONTRACT.md`)

| Agent Tool         | REST Endpoint                              | Method | Approval |
|--------------------|--------------------------------------------|--------|----------|
| `get_state`        | `/api/state`                               | GET    | no       |
| `diff`             | `/api/diff?source=working\|git`            | GET    | no       |
| `events`           | `/api/events?actor=&entity=&result=`       | GET    | no       |
| `health`           | `/api/health`                              | GET    | no       |
| `provision_server` | `/api/servers`                             | POST   | yes (cost) |
| `deploy_service`   | `/api/services`                            | POST   | dry_run→no / apply→conditional |
| `scale_service`    | `/api/services/:name/scale`                | POST   | conditional |
| `set_dns`          | `/api/dns`                                  | POST   | no       |
| `snapshot`         | `/api/backups/:target/snapshot`            | POST   | no       |
| `restore`          | `/api/backups/:target/restore`             | POST   | yes (destructive) |
| `destroy`          | `/api/destroy`                             | POST   | yes (destructive) |
| `apply_manifest`   | `/api/apply`                               | POST   | conditional |
| *(approvals)*      | `/api/approvals`                           | GET    | —        |
| *(approvals)*      | `/api/approvals/:id/approve`               | POST   | —        |
| *(approvals)*      | `/api/approvals/:id/reject`                | POST   | —        |

Every `POST /api/*` returns a `WriteEnvelope` `{ status: "planned" | "pending_approval" | "applied" | "error", plan?, approval_id?, error? }`. Reads are idempotent `GET`. `next` is advisory and NOT validated (Zod strips unknown keys; `SecretSchema` is `.strict()` and rejects any `value`-like field).

> **Console-only reads (non-tool).** Beyond the 12 agent tools, the REST layer also serves **console-only read endpoints** that are not MCP tools but ARE part of the frozen contract the console consumes: `GET /api/secrets` (Fase 4 — `SecretSchema[]`, `.strict()`, refs/usage only, **never a value**), `GET /api/backups` (Fase 5 — `BackupEntrySchema[]`), and `GET /api/approvals` plus the `POST /api/approvals/:id/approve|reject` lifecycle posts (Fase 4). They do not appear in the Tool→Endpoint table above and so are not covered by Task 4.5's table iteration; they must nonetheless be **explicitly wired and contract-conformance-tested** in their owning phase.

---

## Non-negotiable principles (from spec + CLAUDE.md)

1. **Idempotência por design** — recovery = run the reconciler again. Property test enforces: apply manifest N× converges; 2nd+ cycle = no-op.
2. **Fail-safe, NUNCA fail-deleting** — no failure removes an unrequested resource. Drift/orphans are reported, never auto-destroyed.
3. **Sem rollback automático destrutivo** — partial apply leaves a consistent, reportable state; undo only via explicit tool + approval.
4. **Drift reportado, nunca corrigido em silêncio** — divergence emits `drift`; correction requires an explicit tool.
5. **Todo `StateEvent` registra o agente ator** — append-only, ordered, with effective capability scope.
6. **Enforcement de escopo por capability na Agent Interface** — authorization checked at the interface *before* writing desired state, NOT in the reconciler. Effective scope recorded in the `StateEvent`.
7. **Secrets resolvidos no apply** — never in plan/dry_run (which shows only the `secret:name` reference). Resolved reconciler/DockerProvider-side at apply, injected as env. No secret value ever leaves the core.
8. **Working desired state lives in Postgres; git YAML is the human canonical source.** Reconciliation uses the working state. working×git divergence = manifest drift (same fail-safe policy). Promotion working→git is an explicit approval-gated tool.

---

## Testing strategy (MANDATORY — from spec §"Estratégia de testes")

| Layer | How | Covers |
|---|---|---|
| Providers | Fake HTTP server for Hetzner Cloud/DNS + Docker Engine; `@live` opt-in manual | manifest→API translation, pagination, rate-limit, error mapping |
| Reconciler | In-memory provider fakes | dependency DAG, idempotency, error classification, drift |
| Agent Interface | Integration: MCP/REST → plan, approval gating, StateEvent w/ actor | tool contract, dry_run, credential scope, structured errors, **contract conformance vs `contract.ts`** |
| End-to-end | Fakes scenario: full Bevox stack converges to healthy; fault injection | full agent-native flow |
| Idempotency (property) | Apply manifest N× → converges, 2nd+ cycle = no-op | central guarantee |

CI runs unit + integration with fakes on **every commit**. `@live` runs on demand pre-release only. Never test the Hetzner API or Docker Engine themselves — only translation and convergence logic.

---

## File structure (one responsibility per file)

```
core/
  package.json                       scripts, deps (ratified stack)
  tsconfig.json                      ESM NodeNext, strict
  vitest.config.ts                   unit+integration projects; @live tag excluded
  .env.example                       documented config keys (no secrets)
  src/
    config.ts                        env parsing (Zod), typed config
    server.ts                        bootstrap: REST + MCP + reconciler daemon
    domain/
      entities.ts                    Zod entities — structurally == console/src/api/contract.ts
      desired-state.ts               manifest YAML schema + parser → DesiredState
      errors.ts                      taxonomy: transient|precondition|conflict|fatal|partial
    store/
      db.ts                          pg Pool + migration runner
      migrations/                    NNN_*.sql (forward-only)
      observed-store.ts              observed state CRUD (Postgres)
      working-store.ts               working desired state CRUD (Postgres)
      state-events.ts                append-only, ordered, actor + scope
      advisory-lock.ts               pg advisory lock per scope
      manifest-repo.ts               git YAML canonical read (read-only v1 + promote)
      secrets.ts                     ref-resolution interface (age/sops v1); apply-only
    providers/
      provider.ts                    Provider interface + verify() + idempotency contract
      http-client.ts                 retry/backoff/jitter, Retry-After, pagination
      hetzner-cloud.ts               servers/networks/volumes/firewall
      hetzner-dns.ts                 hcloud DNS upsert
      docker.ts                      Docker Engine API via SSH
      wireguard.ts                   WG mesh
      backup-restic.ts               restic snapshot/restore/policy
    reconciler/
      plan.ts                        desired×observed diff → topo DAG (net→server→vol→container)
      apply.ts                       idempotent per-action + verify()
      reconcile.ts                   Observe→Plan→Gate→Apply→Record; advisory lock; triggers
      circuit-breaker.ts             per-provider; open → dependents blocked
      drift.ts                       drift detection (observed + working×git)
    agent/
      envelope.ts                    WriteEnvelope builders
      capability.ts                  per-agent cred + scope enforcement (→ StateEvent)
      approval-gate.ts               pending_approval TTL 24h; webhook + poll fallback
      tools.ts                       12-tool catalog logic (shared by REST + MCP)
      rest.ts                        REST implementing console/CONTRACT.md exactly
      mcp.ts                         MCP server over same core
      auth.ts                        agent credential auth
  test/
    fakes/
      hetzner-http.ts                fake Hetzner Cloud + DNS HTTP server
      docker-http.ts                 fake Docker Engine API server
      provider-fakes.ts              in-memory Provider implementations
      pg-harness.ts                  pg test harness (testcontainers or documented local pg)
```

---

# Task 0 — Ratificação & scaffold (BLOCKING GATE)

**Goal/deliverable:** `core/` package compiles, lints, runs an empty Vitest suite, ratified stack recorded. No business logic. **Exit criteria:** `npm --prefix core test` runs (0 tests pass / trivially green), `npm --prefix core run typecheck` clean, CI note documented.

- Files: create `core/package.json`, `core/tsconfig.json`, `core/vitest.config.ts`, `core/.env.example`, `core/src/_smoke.test.ts` (temporary).
- [ ] Add `core/package.json`: `"type": "module"`, scripts `test` (`vitest run`), `test:watch`, `typecheck` (`tsc --noEmit`), `live` (`vitest run --project live`). Deps: `@modelcontextprotocol/sdk`, `pg`, `zod`, `pino`, Hetzner Cloud SDK; devDeps: `typescript@5`, `vitest`, `@types/node`, `@types/pg`.
- [ ] Add `core/tsconfig.json`: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"verbatimModuleSyntax": true`.
- [ ] Add `core/vitest.config.ts`: two projects — `unit` (default, glob `src/**/*.test.ts` + `test/**`) and `live` (glob `**/*.live.test.ts`, excluded from default run). `@live` never in CI.
- [ ] Write `core/src/_smoke.test.ts`: `it("scaffold is wired", () => expect(1).toBe(1))`.
- [ ] Run `npm --prefix core install && npm --prefix core test` → expect: 1 passing. Run `npm --prefix core run typecheck` → expect: no errors.
- [ ] Document CI note in `core/package.json` README field or `core/.env.example` header: "CI runs `npm --prefix core test` + integration fakes on every commit; `@live` manual pre-release only."
- [ ] Delete `_smoke.test.ts` in the same commit once Fase 1 has a real test (or keep until first real test lands; do not leave it long-term).
- [ ] Commit: `chore(core): ratify stack + scaffold package (Task 0)`

---

# Fase 1 — State Store + modelo + parser de manifesto

**Phase goal:** A persisted, queryable desired/observed state model with append-only audited events, manifest parsing, advisory locking, and manifest-drift detection. **Deliverable:** importable store API + domain schemas. **Exit criteria:** all Fase 1 tests green; entities provably structurally compatible with `console/src/api/contract.ts`; StateEvents append-only & ordered; round-trip property holds.

### Task 1.1 — Domain entities (Zod), structurally compatible with console contract

- Files: create `core/src/domain/entities.ts`, `core/src/domain/entities.test.ts`.
- [ ] Failing test — import the console's schemas as the **assertion oracle** and prove core entities accept the same shapes:
  ```ts
  // core/src/domain/entities.test.ts
  import { describe, it, expect } from "vitest";
  import { ServerSchema, StateSchema, StateEventSchema } from "./entities.js";
  import {
    ServerSchema as ConsoleServer,
    StateSchema as ConsoleState,
  } from "../../../console/src/api/contract.js"; // path-mapped or relative; oracle only

  const validServer = {
    name: "bevox-app-1", type: "cx32", location: "nbg1",
    image: "ubuntu-24.04", ssh_keys: ["k1"], labels: { app: "x" },
    network: "bevox-priv", status: "healthy",
  };

  describe("entities ↔ console contract", () => {
    it("a core-valid Server is console-valid", () => {
      expect(() => ServerSchema.parse(validServer)).not.toThrow();
      expect(() => ConsoleServer.parse(validServer)).not.toThrow();
    });
    it("StateSchema has the six collections the console expects", () => {
      const empty = { servers: [], networks: [], volumes: [], services: [], dns: [], backups: [] };
      expect(() => StateSchema.parse(empty)).not.toThrow();
      expect(() => ConsoleState.parse(empty)).not.toThrow();
    });
    it("StateEvent requires ts, actor, op, entity, result", () => {
      expect(() => StateEventSchema.parse({ actor: "vox" })).toThrow();
    });
  });
  ```
  > If importing across packages is awkward in CI, vendor a frozen copy of `contract.ts`'s schemas into `core/test/fakes/console-contract.snapshot.ts` with a comment pointing at the source-of-truth path; the assertion intent is unchanged.
- [ ] Run `npm --prefix core test entities` → expect FAIL (module missing).
- [ ] Minimal impl `entities.ts`: mirror `contract.ts` — `StatusEnum`, `ServerSchema`, `NetworkSchema`, `VolumeSchema`, `ServiceSchema`, `DnsRecordSchema`, `BackupPolicySchema`, `StateEventSchema`, `StateSchema`. Add spec-only internal fields (e.g. `Server.network_id`) as **optional** so console parsing still succeeds.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): domain entities mirroring console contract (1.1)`

### Task 1.2 — Error taxonomy

- Files: create `core/src/domain/errors.ts`, `core/src/domain/errors.test.ts`.
- [ ] Failing test:
  ```ts
  import { classify, ReconcileError } from "./errors.js";
  it("maps to the 5 spec classes", () => {
    expect(classify({ httpStatus: 429 })).toBe("transient");
    expect(classify({ httpStatus: 503, code: "timeout" })).toBe("transient");
    expect(classify({ kind: "missing-dependency" })).toBe("precondition");
    expect(classify({ kind: "drift" })).toBe("conflict");
    expect(classify({ httpStatus: 401 })).toBe("fatal");
    expect(classify({ kind: "partial" })).toBe("partial");
  });
  it("ReconcileError carries class + retryable + entity for the envelope", () => {
    const e = new ReconcileError("transient", "rate limited", { entity: "server:a", retryAfterMs: 1000 });
    expect(e.retryable).toBe(true);
    expect(e.toApiError()).toMatchObject({ code: "transient", retryable: true, entity: "server:a" });
  });
  ```
- [ ] Run → FAIL. Impl `errors.ts`: `type ErrorClass = "transient"|"precondition"|"conflict"|"fatal"|"partial"`, `classify()`, `ReconcileError` with `.toApiError()` producing the contract `ApiError` shape (`code`,`message`,`retryable`,`entity`). `retryable === (class === "transient" || class === "partial")`.
- [ ] Run → PASS. Commit: `feat(core): error taxonomy transient|precondition|conflict|fatal|partial (1.2)`

### Task 1.3 — Manifest YAML schema + parser

- Files: create `core/src/domain/desired-state.ts`, `core/src/domain/desired-state.test.ts`, fixture `core/test/fixtures/manifest-ok.yaml`, `core/test/fixtures/manifest-bad.yaml`.
- [ ] Failing test: parse the spec's conceptual manifest (servers/services/backups, `env_from: secret:bevox-harness`, `server_selector`) → typed `DesiredState`; assert `secret:` refs are preserved as **references, never resolved**; bad manifest throws a `precondition`-class error with file/line context.
- [ ] Run → FAIL. Impl: YAML parse → Zod `DesiredStateSchema` (`servers[]`, `networks[]`, `volumes[]`, `services[]`, `dns[]`, `backups[]`); secret refs kept verbatim.
- [ ] Run → PASS. Commit: `feat(core): manifest YAML schema + parser (1.3)`

### Task 1.4 — pg pool + migration runner

- Files: create `core/src/store/db.ts`, `core/src/store/migrations/001_init.sql`, `core/test/fakes/pg-harness.ts`, `core/src/store/db.test.ts`.
- [ ] `pg-harness.ts`: spin a disposable Postgres (testcontainers if available; otherwise documented `DATABASE_URL_TEST` against a local pg 16 — document the fallback clearly at the top of the file).
- [ ] Failing test: `runMigrations(pool)` is idempotent — running twice creates the schema once, no error; a `schema_migrations` ledger records applied files.
- [ ] Run → FAIL. Impl `db.ts`: `createPool(config)`, `runMigrations(pool)` (forward-only, ledger-tracked, advisory-locked during migration). `001_init.sql`: tables `observed_state`, `working_state`, `state_events`, `schema_migrations`.
- [ ] Run → PASS. Commit: `feat(core): pg pool + idempotent migration runner (1.4)`

### Task 1.5 — Observed & working stores

- Files: create `core/src/store/observed-store.ts`, `core/src/store/working-store.ts`, `+ .test.ts` each.
- [ ] Failing test (property-flavored round-trip): for arbitrary valid `State`, `put` then `get` returns a structurally-equal `State` that still `StateSchema.parse`s; upsert is idempotent (same input twice = same row, no duplicate).
- [ ] Run → FAIL. Impl both stores as typed CRUD over their tables, JSON-encoded, schema-validated on read.
- [ ] Run → PASS. Commit: `feat(core): observed + working desired-state stores (1.5)`

### Task 1.6 — Append-only StateEvents with actor + scope

- Files: create `core/src/store/state-events.ts`, `core/src/store/state-events.test.ts`.
- [ ] Failing test: `append(event)` requires `actor` and `scope`; events come back ordered by monotonic sequence; **no `update`/`delete` API exists** (assert the module exports only `append` + `query`); `query({actor,entity,result})` filters match `events` tool semantics.
- [ ] Run → FAIL. Impl: insert-only; `seq BIGSERIAL`; `query` with the three filters from `/api/events?actor=&entity=&result=`. Each row stores effective capability scope.
- [ ] Run → PASS. Commit: `feat(core): append-only ordered StateEvents w/ actor + scope (1.6)`

### Task 1.7 — Advisory lock per scope

- Files: create `core/src/store/advisory-lock.ts`, `core/src/store/advisory-lock.test.ts`.
- [ ] Failing test: `withScopeLock("scope-a", fn)` runs `fn`; a second concurrent acquisition of the same scope **waits or rejects** (choose `tryLock` semantics → returns `false` if held) while a different scope proceeds in parallel.
- [ ] Run → FAIL. Impl using `pg_advisory_lock`/`pg_try_advisory_lock` keyed by hashed scope; always released in `finally`.
- [ ] Run → PASS. Commit: `feat(core): pg advisory lock per reconcile scope (1.7)`

### Task 1.8 — git manifest repo read + working×git manifest drift

- Files: create `core/src/store/manifest-repo.ts`, `core/src/store/drift-manifest.test.ts`.
- [ ] Failing test: `readCanonicalManifest(repoPath)` parses the committed YAML into `DesiredState`; `diffManifest(working, git)` returns drift items (no auto-correction) when working ≠ git; identical inputs → empty drift.
- [ ] Run → FAIL. Impl: read-only git working-tree read (no write/commit in v1 except the explicit promote path, deferred to Fase 4); reuse `desired-state.ts` parser; drift = structural diff reported as `conflict`-class items.
- [ ] Run → PASS. Commit: `feat(core): git manifest read + working×git manifest-drift (1.8)`

### Task 1.9 — Secrets reference model (no value, ever)

- Files: create `core/src/store/secrets.ts`, `core/src/store/secrets.test.ts`.
- [ ] Failing test: `SecretRef.parse("secret:bevox-harness")` ok; the resolver interface exposes `describe(ref) → { name, keys, used_by }` (the contract `Secret` shape, **`.strict()`, no value**) and `resolve(ref)` is **only callable behind an `applyContext` token** (assert calling `resolve` without it throws). Plan/dry_run code paths must never reach `resolve`.
- [ ] Run → FAIL. Impl: `SecretResolver` interface; v1 stub backed by age/sops file (actual decryption deferred — keys are out of scope, see Fora de escopo). `describe()` returns metadata only.
- [ ] Run → PASS. Commit: `feat(core): secret ref model — metadata only, apply-gated resolve (1.9)`

**Done (Fase 1) =** entities console-compatible (1.1 oracle green); errors taxonomy complete; manifest parses; migrations idempotent; observed/working round-trip property holds; StateEvents append-only/ordered; advisory lock isolates scopes; working×git drift reported; secrets expose no value. `npm --prefix core test` fully green.

---

# Fase 2 — HetznerCloudProvider + reconciler (servers/redes/volumes)

**Phase goal:** Translate desired state into Hetzner Cloud reality (servers, networks, volumes) idempotently via a faked HTTP API, with a DAG-ordered plan/apply/reconcile cycle and the central idempotency guarantee. **Deliverable:** `reconcile()` converges a manifest against fakes. **Exit criteria:** idempotency property test green (N× converges, 2nd+ = no-op); fail-safe verified (drift/orphans reported, never deleted).

### Task 2.1 — Provider interface + verify() + idempotency contract

- Files: create `core/src/providers/provider.ts`, `core/src/providers/provider.test.ts`.
- [ ] Failing test: a conforming fake provider implements `observe()`, `apply(action)`, `verify(action)`; calling `apply` twice for the same desired action is a no-op the second time (`verify` returns satisfied without a second write).
  ```ts
  export interface Provider<TKind extends string = string> {
    readonly name: string;
    observe(scope: string): Promise<ObservedSlice>;
    apply(action: PlanAction): Promise<ApplyResult>;   // MUST be idempotent
    verify(action: PlanAction): Promise<boolean>;       // true = reality matches desired
  }
  ```
- [ ] Run → FAIL. Impl interface + a `conformanceHarness(provider)` test helper asserting the idempotency contract; reused by every concrete provider.
- [ ] Run → PASS. Commit: `feat(core): Provider interface + verify + idempotency conformance (2.1)`

### Task 2.2 — HTTP client: retry/backoff/jitter, Retry-After, pagination

- Files: create `core/src/providers/http-client.ts`, `core/src/providers/http-client.test.ts`.
- [ ] Failing test (against a tiny in-test fake handler):
  ```ts
  it("retries 429 with backoff+jitter and respects Retry-After", async () => {
    const seq = [429, 429, 200]; // server replies; 2nd 429 sets Retry-After: 0
    const c = new HttpClient({ maxRetries: 3, baseDelayMs: 1 });
    const res = await c.get(fakeUrl("/x"));         // succeeds on 3rd
    expect(res.status).toBe(200);
    expect(c.attempts).toBe(3);
  });
  it("follows Hetzner cursor pagination until exhausted", async () => {
    const all = await c.getAllPages(fakeUrl("/servers")); // 3 pages → flat list
    expect(all.length).toBe(/* total */);
  });
  it("does NOT retry a 401 (fatal)", async () => { /* attempts === 1 */ });
  ```
- [ ] Run → FAIL. Impl: exponential backoff + full jitter, honor `Retry-After` (seconds or HTTP-date), cap retries, classify non-2xx via `errors.ts`, `getAllPages` for Hetzner `meta.pagination`.
- [ ] Run → PASS. Commit: `feat(core): resilient HTTP client (retry/jitter/Retry-After/pagination) (2.2)`

### Task 2.3 — Fake Hetzner Cloud HTTP server

- Files: create `core/test/fakes/hetzner-http.ts`, `core/test/fakes/hetzner-http.test.ts`.
- [ ] Failing test: fake serves `/servers`, `/networks`, `/volumes` CRUD with pagination + a configurable `429`/`Retry-After` fault and a `401` fault toggle; state is in-memory and resettable per test.
- [ ] Run → FAIL. Impl minimal Hetzner Cloud API surface needed by Fase 2 only (YAGNI). Document: this is translation/convergence testing, NOT testing Hetzner.
- [ ] Run → PASS. Commit: `test(core): fake Hetzner Cloud HTTP server (2.3)`

### Task 2.4 — HetznerCloudProvider

- Files: create `core/src/providers/hetzner-cloud.ts`, `core/src/providers/hetzner-cloud.test.ts`.
- [ ] Failing test: against the fake — `observe()` lists existing servers/networks/volumes; `apply(create server)` then `apply` again = no-op (passes `conformanceHarness`); error mapping: fake 429→`transient`, 401→`fatal`, missing network→`precondition`.
- [ ] Run → FAIL. Impl provider over `http-client` + fake; map manifest → Hetzner API; `verify()` re-reads real state.
- [ ] Run → PASS. Commit: `feat(core): HetznerCloudProvider against fake API (2.4)`

### Task 2.5 — plan.ts: desired×observed diff → topo DAG

- Files: create `core/src/reconciler/plan.ts`, `core/src/reconciler/plan.test.ts`.
- [ ] Failing test: given desired (network+server+volume) and empty observed → plan ordered `network → server → volume → container`; an existing-equal resource → `noop`; an unmanaged observed resource → a `drift` item, **not** a `remove` (fail-safe).
- [ ] Run → FAIL. Impl: build dependency DAG, topological sort, emit `PlanItem[]` using the contract `PlanOp` enum (`create|update|scale|drift|destroy|noop|...`). Orphans → `drift` only.
- [ ] Run → PASS. Commit: `feat(core): plan as topo-sorted desired×observed diff (2.5)`

### Task 2.6 — apply.ts: idempotent per-action + verify

- Files: create `core/src/reconciler/apply.ts`, `core/src/reconciler/apply.test.ts`.
- [ ] Failing test: applying a plan executes actions in order; each action calls `provider.verify()` after; a `precondition` failure aborts that action + marks dependents, **continues independent actions**; no destructive rollback on partial failure (state left consistent + reportable).
- [ ] Run → FAIL. Impl per-action apply with post-`verify`, error-class-driven control flow per spec error model.
- [ ] Run → PASS. Commit: `feat(core): idempotent apply with verify + fail-safe partials (2.6)`

### Task 2.7 — reconcile.ts: Observe→Plan→Gate→Apply→Record + advisory lock

- Files: create `core/src/reconciler/reconcile.ts`, `core/src/reconciler/reconcile.test.ts`.
- [ ] Failing test: one `reconcile(scope)` cycle observes (fake) → plans → applies (no gating yet in Fase 2; gate is a pass-through) → records a `StateEvent` per action with `actor`; a second concurrent `reconcile` on the same scope is blocked by the advisory lock; triggers: on-demand + periodic timer hook exist (webhook deferred).
- [ ] Run → FAIL. Impl the 5-step cycle wiring Fase 1 stores + Fase 2 provider; gate is an injected strategy (real impl Fase 4).
- [ ] Run → PASS. Commit: `feat(core): reconcile cycle Observe→Plan→Gate→Apply→Record (2.7)`

### Task 2.8 — Idempotency property test (CENTRAL GUARANTEE)

- Files: create `core/src/reconciler/idempotency.property.test.ts`.
- [ ] Failing test:
  ```ts
  it("applying any manifest N times converges; cycle 2..N is a no-op", async () => {
    for (const manifest of sampleManifests) {        // hand-rolled + a few generated
      const ctx = freshFakeWorld();
      await reconcile(ctx, manifest);                 // cycle 1: mutating
      const after1 = await observeAll(ctx);
      for (let i = 0; i < 4; i++) {
        const events = await reconcile(ctx, manifest);// cycle 2..5
        expect(events.appliedMutations).toBe(0);      // strict no-op
      }
      expect(await observeAll(ctx)).toEqual(after1);  // stable
    }
  });
  ```
- [ ] Run → FAIL. Make it pass with minimal fixes to `plan`/`apply` (likely `verify`-before-`apply` short-circuit). Do not weaken the assertion.
- [ ] Run → PASS. Commit: `test(core): idempotency property — N× converges, 2nd+ no-op (2.8)`

### Task 2.9 — Fail-safe drift/orphan reporting

- Files: modify `core/src/reconciler/drift.ts` (create), test `core/src/reconciler/drift.test.ts`.
- [ ] Failing test: an observed resource absent from desired → emitted as `drift` in the plan and never produces a `destroy`/`remove` action; reconcile leaves it untouched.
- [ ] Run → FAIL. Impl observed-side drift detector feeding `plan.ts`.
- [ ] Run → PASS. Commit: `feat(core): fail-safe observed drift reporting (no auto-delete) (2.9)`

**Done (Fase 2) =** HetznerCloudProvider passes conformance; HTTP client resilient; plan DAG-ordered; apply idempotent + fail-safe; reconcile cycle records actored events under advisory lock; **idempotency property test green**; orphans reported never deleted.

---

# Fase 3 — DockerProvider + WireGuardProvider

**Phase goal:** Run services as Docker containers over SSH on a private WireGuard mesh, resolving secrets at apply only. **Deliverable:** reconcile converges a Service manifest. **Exit criteria:** Docker/WG providers pass `conformanceHarness`; secrets resolved at apply (never in plan/dry_run) and injected as env.

### Task 3.1 — Fake Docker Engine API server

- Files: `core/test/fakes/docker-http.ts` (+ test). TDD: fake serves container create/start/stop/list/inspect over an SSH-tunnel-shaped transport seam; resettable. Commit: `test(core): fake Docker Engine API server (3.1)`

### Task 3.2 — DockerProvider (Engine API via SSH)

- Files: `core/src/providers/docker.ts` (+ test). TDD: `observe`/`apply`/`verify` for Services; passes `conformanceHarness` (apply twice = no-op); SSH transport is an injectable seam (no real SSH in tests). Map `Service` → container spec (image, replicas, ports, volumes, server_selector). Commit: `feat(core): DockerProvider via Engine API over SSH seam (3.2)`

### Task 3.3 — Secret resolution AT APPLY only

- Files: `core/src/reconciler/apply.ts` (modify), `core/src/providers/docker.ts` (modify), test `core/src/reconciler/secret-apply.test.ts`. TDD:
  - plan/dry_run for a service with `env_from: secret:x` shows only the **reference** in `PlanItem.change` (assert no key/value leaks);
  - apply path calls `SecretResolver.resolve` **with** the `applyContext` token and injects values as container env;
  - resolving without `applyContext` throws (regression guard for 1.9).
  Commit: `feat(core): resolve secrets at apply, inject as env, never in plan (3.3)`

### Task 3.4 — WireGuardProvider (mesh)

- Files: `core/src/providers/wireguard.ts` (+ test). TDD: `observe`/`apply`/`verify` peer config for the private mesh against an in-memory seam; idempotent (re-apply = no-op); conformance harness green. Commit: `feat(core): WireGuardProvider mesh (idempotent) (3.4)`

### Task 3.5 — Reconcile services on private network (integration)

- Files: `core/src/reconciler/reconcile.services.test.ts`. TDD: a manifest with network+server+service converges via Hetzner+Docker+WG fakes; plan order respects `net→server→volume→container`; idempotency property still holds with services in the mix. Commit: `test(core): services converge on private mesh via fakes (3.5)`

**Done (Fase 3) =** services deploy as containers over the SSH seam on a WG mesh; secrets resolved only at apply and shown only as refs in plan; idempotency property still green with services.

---

# Fase 4 — Agent Interface (MCP + REST) + Approval Gate

**Phase goal:** Expose the core to agents and the console via the **frozen contract**, with capability scope enforced at the interface and a full approval lifecycle. **Deliverable:** REST + MCP servers; console MSW-contract shapes produced. **Exit criteria:** contract-conformance test green against `console/src/api/contract.ts`; capability scope recorded in `StateEvent`; approval lifecycle (pending→approved/rejected/expired) correct.

### Task 4.1 — WriteEnvelope builders

- Files: `core/src/agent/envelope.ts` (+ test). TDD: builders for `planned` (with `plan: PlanItem[]`), `pending_approval` (with `approval_id`), `applied`, `error` (with `ApiError`); every output **parses against the vendored `WriteEnvelopeSchema`** from the console contract; `next` may be added but is not validated. Commit: `feat(core): WriteEnvelope builders (contract-shaped) (4.1)`

### Task 4.2 — Capability scope enforcement at the interface

- Files: `core/src/agent/capability.ts`, `core/src/agent/auth.ts` (+ tests). TDD: an agent credential carries a capability set (e.g. Vox⊇`destroy`, runner⊆`deploy_service`); a tool call outside scope is rejected **before any desired-state write** with a `fatal`/authz `ApiError`; the **effective scope is recorded in the StateEvent** for allowed calls. Enforcement is here, NOT in the reconciler (regression guard). Commit: `feat(core): per-capability scope enforced at interface + recorded in StateEvent (4.2)`

### Task 4.3 — Approval Gate lifecycle

- Files: `core/src/agent/approval-gate.ts` (+ test). TDD:
  - sensitive action → `pending_approval` record, TTL default 24h, reconciler does **not** block (action stays `blocked`, re-evaluated each cycle);
  - resolution via webhook handler (preferred) **and** a polling fallback both transition pending→approved/rejected;
  - expired → `cancelled` + event emitted; rejected → `cancelled` + reason recorded.
  Commit: `feat(core): approval gate lifecycle (TTL 24h, webhook+poll, expiry) (4.3)`

### Task 4.4 — Tool catalog (12 tools), shared logic

- Files: `core/src/agent/tools.ts` (+ test). TDD per tool, asserting the approval policy from the contract table: reads (`get_state`,`diff`,`events`,`health`) no approval; `provision_server` always approval; `deploy_service` dry_run→planned / apply→conditional; `scale_service` conditional; `set_dns` none; `snapshot` none; `restore` approval; `destroy` approval; `apply_manifest` conditional. One sub-task per tool, each its own commit `feat(core): tool <name> logic (4.4.x)`.

### Task 4.5 — REST API implementing CONTRACT.md exactly

- Files: `core/src/agent/rest.ts` (+ test). TDD: every row of the Tool→Endpoint table wired with the exact method/path/query; `dry_run` defaults to the contract behavior for destructive ops; responses are `WriteEnvelope`/entity shapes. Sub-tasks grouped by endpoint, one commit each `feat(core): REST <METHOD path> (4.5.x)`.

### Task 4.5b — Wire `GET /api/secrets` (console-only read, refs/usage only)

> Not in the Tool→Endpoint table (it is a console read, not one of the 12 tools), so Task 4.5's table iteration does not cover it. It IS part of the frozen contract the console consumes (`console/src/api/client.ts` `getSecrets`, `useSecrets`, `Secrets.tsx`). **Hard invariant:** this endpoint MUST NOT expose secret values — it mirrors the console's `.strict()` `SecretSchema` and the secret-leak guard from Tasks 1.9/3.3. No value ever leaves the core.

- Files: `core/src/agent/rest.ts` (modify), test `core/src/agent/rest.secrets.test.ts`.
- [ ] Failing test: `GET /api/secrets` returns `SecretSchema[]` derived from the Fase-1 secrets model's `describe()` metadata — each item `{ name, keys, used_by }` (names + key counts + `used_by`, **never a value**); assert every item parses against the vendored console `SecretSchema` and that `.strict()` rejects any injected `value`-like field; explicitly assert no `value`/secret-material field appears on any item (parallels the console's strict schema + the no-value guard from 1.9/3.3).
- [ ] Run `npm --prefix core test rest.secrets` → expect FAIL (route missing).
- [ ] Minimal impl: route handler returns `SecretResolver.describe()` mapped to `{ name, keys, used_by }` only; never calls `resolve()` (no `applyContext` on a read path).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): GET /api/secrets — refs/usage only, never values (4.5b)`

### Task 4.6 — CONTRACT CONFORMANCE (downstream truth oracle)

- Files: `core/src/agent/contract-conformance.test.ts`.
- [ ] Failing test — derive the **console's expected schemas** and assert real REST responses parse against them:
  ```ts
  import {
    StateSchema, WriteEnvelopeSchema, ApprovalSchema,
    HealthReportSchema, SecretSchema, StateEventSchema,
  } from "../../../console/src/api/contract.js"; // downstream truth (or vendored snapshot)

  it("GET /api/state → StateSchema", async () => {
    const r = await api.get("/api/state");
    expect(() => StateSchema.parse(r.body)).not.toThrow();
  });
  it("POST /api/services dry_run → planned WriteEnvelope", async () => {
    const r = await api.post("/api/services", { name:"h", image:"i:1", replicas:1, dry_run:true });
    const env = WriteEnvelopeSchema.parse(r.body);
    expect(env.status).toBe("planned");
    expect(env.plan?.length).toBeGreaterThan(0);
  });
  it("POST /api/destroy → pending_approval with approval_id", async () => {
    const env = WriteEnvelopeSchema.parse((await api.post("/api/destroy",{ entity:"server:a" })).body);
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toMatch(/^apr_/);
  });
  // Depends on Task 4.5b (wires GET /api/secrets). The route serves the
  // Fase-1 secrets describe() metadata only; .strict + the no-value assertion
  // are the regression guard mirroring Tasks 1.9/3.3.
  it("GET /api/secrets → SecretSchema[] (.strict, NO value, ever)", async () => {
    for (const s of (await api.get("/api/secrets")).body) {
      expect(() => SecretSchema.parse(s)).not.toThrow();   // .strict rejects any value field
      expect(s).not.toHaveProperty("value");               // explicit no-value assertion
    }
  });
  it("error → status:error + ApiError {code,message,retryable,entity}", async () => {
    const env = WriteEnvelopeSchema.parse((await api.post("/api/services", { bad:true })).body);
    expect(env.status).toBe("error");
    expect(env.error).toMatchObject({ retryable: expect.any(Boolean) });
  });
  it("GET /api/approvals → ApprovalSchema[]; GET /api/health → HealthReportSchema", async () => { /* ... */ });
  ```
- [ ] Run → FAIL where shapes diverge. Fix the **core** (never the contract) until green.
- [ ] Commit: `test(core): REST conforms to console contract.ts (downstream oracle) (4.6)`

### Task 4.7 — MCP server over the same core

- Files: `core/src/agent/mcp.ts` (+ test). TDD: MCP exposes the same 12 tools sharing `tools.ts`; an MCP `destroy` and a REST `POST /api/destroy` produce the same envelope + the same `StateEvent` (no parallel logic). Commit: `feat(core): MCP server sharing tool core with REST (4.7)`

### Task 4.8 — Promote working→git tool (approval-gated)

- Files: `core/src/store/manifest-repo.ts` (modify: add write/commit), `core/src/agent/tools.ts` (modify), test. TDD: a `promote_manifest` tool diffs working×git, requires approval, and on apply writes+commits the canonical YAML; rejected/expired approval = no write. Commit: `feat(core): approval-gated promote working→git manifest (4.8)`

**Done (Fase 4) =** REST matches `console/CONTRACT.md` and parses against `contract.ts` (4.6 green); the console-only read `GET /api/secrets` wired (4.5b) and serving refs/usage only (never a value); MCP shares the same core; capability scope enforced at the interface and recorded in events; approval lifecycle complete; working→git promotion approval-gated.

---

# Fase 5 — HetznerDNSProvider + BackupProvider (restic)

**Phase goal:** DNS upserts (non-destructive, no approval) and restic backups (snapshot no approval / restore destructive→approval). **Deliverable:** `set_dns`, `snapshot`, `restore` end-to-end via fakes. **Exit criteria:** DNS upsert idempotent + non-destructive; restore gated; backup entries match `BackupEntrySchema`/`SnapshotEntrySchema`.

### Task 5.1 — Fake hcloud DNS server

- Files: `core/test/fakes/hetzner-http.ts` (extend DNS routes) + test. TDD: zone/record CRUD + pagination. Commit: `test(core): fake hcloud DNS routes (5.1)`

### Task 5.2 — HetznerDNSProvider (upsert, non-destructive)

- Files: `core/src/providers/hetzner-dns.ts` (+ test). TDD: `set_dns` upserts a record (create if absent, update if changed, no-op if equal); **never deletes** unmanaged records (fail-safe); conformance harness green; no approval path. Commit: `feat(core): HetznerDNSProvider non-destructive upsert (5.2)`

### Task 5.3 — BackupProvider (restic) snapshot/restore

- Files: `core/src/providers/backup-restic.ts` (+ test). TDD against a restic CLI/transport seam: `snapshot(target)` requires **no approval** and returns a `SnapshotEntry`; `restore(target, id)` is destructive → routes through the approval gate (Fase 4); backup policy listing returns `BackupEntry` (policy + `last_run` + `snapshots[]`), all parsing against the vendored contract schemas. Commit: `feat(core): restic BackupProvider snapshot(no-appr)/restore(appr) (5.3)`

### Task 5.4 — Wire backup/DNS endpoints + conformance

- Files: `core/src/agent/rest.ts` (modify), `core/src/agent/contract-conformance.test.ts` (extend). TDD: `/api/dns`, `/api/backups/:target/snapshot`, `/api/backups/:target/restore`, `GET /api/backups` produce contract-valid bodies; `restore` returns `pending_approval`. Commit: `feat(core): DNS + backup endpoints, contract-conformant (5.4)`

**Done (Fase 5) =** DNS upsert idempotent/non-destructive/no-approval; snapshot no-approval; restore approval-gated; backup/DNS responses parse against contract.

---

# Fase 6 — Drift detection periódico + circuit breaker + endurecimento

**Phase goal:** Continuous drift detection, per-provider circuit breaking with dependent blocking, timeouts, and an end-to-end fakes scenario. **Deliverable:** hardened reconciler daemon. **Exit criteria:** periodic drift (~5min, injectable clock) green; circuit breaker opens + blocks dependents + surfaces in `/api/health`; full-stack fakes scenario converges to healthy and survives fault injection.

### Task 6.1 — Periodic drift detection (~5 min, injectable clock)

- Files: `core/src/reconciler/drift.ts` (modify), `core/src/reconciler/reconcile.ts` (modify) + test. TDD: with a fake clock, a periodic trigger runs observed-drift + working×git drift every interval and emits drift events without correcting (fail-safe). Commit: `feat(core): periodic drift detection (injectable clock) (6.1)`

### Task 6.2 — Circuit breaker per provider

- Files: `core/src/reconciler/circuit-breaker.ts` (+ test). TDD: after N consecutive provider failures the breaker **opens**, further calls short-circuit, **dependents are marked `blocked`**, half-open probe after cooldown; breaker state matches `HealthReportSchema.circuit_breakers` (`name`,`state`,`failures`,`max_failures`,`last_failure`). Commit: `feat(core): per-provider circuit breaker + dependent blocking (6.2)`

### Task 6.3 — Timeouts + hardening

- Files: `core/src/providers/http-client.ts` (modify), `core/src/reconciler/reconcile.ts` (modify) + tests. TDD: per-call timeout → `transient`; cycle-level timeout aborts cleanly leaving consistent state (no fail-deleting); structured Pino logs include actor + scope + entity. Commit: `feat(core): timeouts + reconcile hardening (6.3)`

### Task 6.4 — `/api/health` aggregation

- Files: `core/src/agent/rest.ts` (modify), conformance test (extend). TDD: `GET /api/health` aggregates `circuit_breakers`, `degraded`, `blocked`, `drift`, `reconciler` exactly per `HealthReportSchema`. Commit: `feat(core): health endpoint aggregation (contract-conformant) (6.4)`

### Task 6.5 — End-to-end fakes scenario + fault injection

- Files: `core/test/e2e/full-stack.test.ts`. TDD: a manifest representing the full Bevox stack (servers + private network + WG + services + DNS + backups) converges to all-`healthy` via fakes; then inject faults (provider 503 storm, partial replicas, observed drift) and assert: degraded/blocked surfaces in `/api/health`, no resource auto-deleted, recovery on next clean cycle (idempotent re-run), every mutation has an actored StateEvent. Commit: `test(core): end-to-end full Bevox stack + fault injection (6.5)`

### Task 6.6 — Bootstrap server (REST + MCP + reconciler daemon)

- Files: `core/src/server.ts`, `core/src/config.ts` (+ tests). TDD: `config.ts` parses env via Zod (typed, fails fast on missing required keys, no secret defaults); `server.ts` boots REST + MCP + the periodic reconciler with graceful shutdown (releases advisory locks). Commit: `feat(core): bootstrap server — REST+MCP+reconciler daemon (6.6)`

**Done (Fase 6) =** periodic drift runs without silent correction; circuit breaker opens and blocks dependents and is visible in `/api/health`; timeouts safe; full-stack fakes scenario converges and survives fault injection; bootstrap daemon runs all three with graceful shutdown.

---

## Fora de escopo / depende de credenciais reais

- **Live Hetzner / hcloud DNS** — `@live` suite only, manual, pre-release; needs a real Hetzner API token (operator-supplied, never in repo/CI).
- **Real SSH hosts / Docker Engine over real SSH** — tests use the injectable SSH transport seam; real keys/hosts out of scope here.
- **age/sops decryption keys** — `secrets.ts` exposes the resolver interface and metadata only; actual decryption depends on operator-provisioned keys; no key material in repo.
- **Secret rotation** — explicitly excluded in v1 (recreate service applies new value). YAGNI per CLAUDE.md.
- **Webhook receiver from Approval Center** — the gate supports the webhook handler shape + a polling fallback; the external Approval Center wiring/URL is operator config, not built here.
- **console↔core base-URL wiring** — the console points its MSW/real client at the core; choosing/deploying that base URL and CORS/auth tokens is deployment config, out of scope for the core build.
- **git write credentials for promote** — `promote_manifest` writes/commits locally; pushing to a remote and the git identity/creds are operator config.
- **Multi-tenant, billing, autoscaling, multi-cloud, rich web UI** — non-objectives per spec/CLAUDE.md.

## Done = (per phase, summary)

- **Task 0:** `core/` scaffolds, typechecks, empty Vitest green, CI note recorded.
- **Fase 1:** store/domain green; entities console-compatible; events append-only; round-trip property holds.
- **Fase 2:** Hetzner Cloud convergence via fakes; **idempotency property green**; fail-safe.
- **Fase 3:** services on WG mesh via SSH seam; secrets apply-only.
- **Fase 4:** REST/MCP match the frozen contract (conformance oracle green); scope + approvals correct.
- **Fase 5:** DNS upsert + restic backups, restore approval-gated, contract-conformant.
- **Fase 6:** periodic drift + circuit breaker + hardening + e2e fault-injection green; daemon boots.

Each phase ends with `npm --prefix core test` fully green and a clean `npm --prefix core run typecheck` before the next phase starts.
