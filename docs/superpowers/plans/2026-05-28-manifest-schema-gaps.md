# Manifest schema gaps (`services[]` additive fields) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each task is
> a self-contained TDD unit (failing test → run → minimal impl → run → commit).
> Do not skip the red step. Do not batch commits.

**Goal:** Close the four `services[]` manifest gaps surfaced during the
bevox-harness go-live — `command` (argv), `restart` policy, the dead `env_from`
field, and intra-`service` ordering/health-wait via `depends_on` — by adding
four **optional, additive** fields to `ManifestServiceSchema` and propagating
them through the `DockerProvider`, while preserving every v1/v2 invariant
byte-identically. At the end: a manifest can declare `command:`, `restart:`,
`depends_on:` (with optional per-dep `wait_healthy_timeout`) and (Phase 2.1)
`healthcheck:`; the dead `env_from` is gone from schema, fixture and docs; and
an existing container with none of the new fields converges with a
byte-identical create body and never flaps.

**Architecture:** The change is intentionally thin. The schema surface
(`core/src/domain/desired-state.ts`) grows three optional fields in Phase 1 and
a fourth (`healthcheck`) in Phase 2.1; `DockerProvider.createContainerBody`
(`core/src/providers/docker.ts:306-353`) gains conditional injections that only
fire when a field is *declared*; `isConverged` (`docker.ts:366-395`) gains
comparisons that only run when a field is *declared* (the transversal
no-flap invariant). Intra-`service` ordering is a NEW pure helper
`core/src/providers/docker-depends-on.ts` (`topoSortServices`) that rejects
cycles and dangling deps as `ReconcileError("precondition")` *before any
mutation*; its edges feed the existing reconciler DAG so the cross-kind order
(network→server→volume→service) is unchanged. Wait-for-healthy (Phase 2.0)
polls the Engine's `State.Health.Status` through an injectable `waitForHealthy`
seam tested against the `docker-http` fake. The provider does NOT emit
StateEvents: it surfaces wait outcomes via a new **optional additive**
`ApplyResult.events?[]` field, and the reconciler **Record step** persists each
with the cycle `actor`+`scope`+`after`. Timeout aborts fail-safe **by return**
(`changed:false` + `service.dep_health_timeout` event, nothing created or
deleted, reconverge next cycle, no backoff); no-HEALTHCHECK degrades to
ordering-only with a `service.wait_skipped` event and proceeds. For `apply()` to
see the deps, `entities.ServiceSchema` gains `depends_on` in Phase 2.0 — but
`createContainerBody` / `isConverged` keep ignoring it: `depends_on` is
desired-state ordering, not container shape, so it never enters the create body
nor `isConverged`.

**Tech Stack:** Inherits the v1/v2 ratified stack unchanged (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`, PostgreSQL 16,
Docker Engine API via SSH, WireGuard, restic, Zod, Pino, Vitest + HTTP fakes).
**Zero new dependencies.** No new external HTTP surface — wait-for-healthy reads
the existing container-inspect endpoint already served by
`core/test/fakes/docker-http.ts` (which returns `State.Status` today and gains
a per-container drivable `State.Health.Status` for the wait tests).
`StateEventSchema.op` is `z.string()` (open enum) — the two new `op` values
(`service.wait_skipped`, `service.dep_health_timeout`) need NO Postgres
migration. The Phase 2.0 wiring is **additive only**: `ApplyResult` gains an
optional `events?[]`, `entities.ServiceSchema` gains an optional `depends_on`,
and the reconciler `record()` helper gains an optional `after` — nothing
existing changes shape.

**Specs:**
- This spec (spec-filha): `docs/specs/2026-05-28-manifest-schema-gaps.md`
  (Status: Aceita · **Revisão 2026-05-28b** — §1.5/§3/§6/§8 corrected the
  Phase 2.0/2.1 StateEvent mechanism after Phase 1 shipped)
- Parent contract (spec-mãe, FROZEN): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- v1 base: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Companion motivation: `docs/manifest-schema-cheatsheet.md` (§"Gaps conhecidos" #1–#4)

---

## How this plan is executed

This is a **single master plan covering Phase 1, Phase 2.0 and Phase 2.1**,
executed phase by phase. **Phase 1 is fully shippable and mergeable on its own**
— it unblocks the bevox-harness go-live and does NOT depend on Phase 2.x. Do
not start Phase 2.0 until Phase 1's "Done =" holds and CI is green; do not start
Phase 2.1 until Phase 2.0's "Done =" holds. Each phase is additive and
independently mergeable; Phase 2.x never blocks Phase 1.

There is no blocking "Task 0" foundation here — the schema and provider already
exist on `main`; this plan extends them. Every task cites this spec by date+slug
(`2026-05-28-manifest-schema-gaps.md`) in its commit body.

All paths in this plan are absolute. New code: `core/src/providers/docker-depends-on.ts`
(Phase 1) and `core/src/providers/docker-wait-healthy.test.ts` (Phase 2.0).
Existing files are modified additively only — no v1 file is renamed or
restructured; `ManifestServiceSchema` gains optional fields only.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail for the RIGHT reason
  (assertion mismatch, not import/type error) → minimal implementation → run,
  see it pass → commit. Reference @superpowers:test-driven-development and
  `.claude/rules/tdd-required.md`.
- **DRY / YAGNI / minimal change**: build only what the phase needs. No
  speculative abstraction. Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Conventional Commits, with the
  mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
  Each commit body cites `spec: 2026-05-28-manifest-schema-gaps.md` and this
  plan's task index.
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim. Run `npm --prefix core run typecheck` and
  `npm --prefix core test` (expect full suite green, 1 `@live` skipped).
- **Tests never touch real infra**: Docker Engine goes through the
  `core/test/fakes/docker-http.ts` fake and `core/test/fakes/ssh-exec.ts`;
  no real network/SSH in the `unit` project. `.live.test.ts` only under
  `core/test/live/`.
- **Fail-safe, never fail-deleting** (ground rule #3): no new error path deletes
  a resource. The wait-for-healthy timeout ABORTS and records a StateEvent; it
  does not remove containers. Reconverge next cycle, no backoff.
- **Secrets resolved at apply only** (ground rule #4): no new field touches the
  secret path. `core/src/reconciler/secret-apply.test.ts` stays byte-identical.
- **Every StateEvent records the actor** sourced from the reconcile cycle
  (`reconcile({ actor })`), NOT from `ApplyContext` (ground rule #5). Providers
  do NOT write StateEvents — they surface outcomes via the additive optional
  `ApplyResult.events?[]`, and the reconciler Record step persists each with the
  cycle `actor`+`scope`. `ApplyContext` (`store/secrets.ts:119`) is only a
  secret brand token and carries no actor.
- **ESM/NodeNext hygiene**: relative imports end in `.js`; `import type` for
  type-only imports; narrow indexed access; Zod on the wire; no `console.*` in
  `core/src/`.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — what does NOT change

This spec-filha realises additives only. The following stay byte-identical and
each phase's exit criteria re-assert them:

- **ALL_TOOLS (12) and V2_TOOLS** — the tool catalogue is untouched. No new
  tool, no removed tool, no changed descriptor.
- **Top-level `DesiredStateSchema` is `.strict()`** (`desired-state.ts:106+`) —
  unchanged. Only the non-strict item schema `ManifestServiceSchema` gains
  fields.
- **`secret-apply.test.ts` golden** — no new field reaches the secret path; the
  resolved-secret leak sentinels (`S3CR3T-*`) stay confined to the allowlisted
  test files (`.gitleaks.toml`).
- **Container create body for a service with NONE of the new fields** — must be
  byte-identical to the current `createContainerBody` output. This is the
  transversal idempotency invariant: omitted field ⇒ body byte-identical ⇒
  `isConverged()` must NOT flap on existing containers ⇒ no forced re-create on
  the first apply after upgrade.

---

## Non-negotiable principles (this plan)

All v1/v2 principles apply unchanged. The transversal rule for THIS plan:

1. **Every new field is OPTIONAL.** Omitted ⇒ create body byte-identical ⇒
   `isConverged()` does not compare it ⇒ no flap.
2. **`isConverged()` compares a new field ONLY when it is declared** on the
   desired service. (`command`, `restart`, `healthcheck` — yes when declared;
   `depends_on` — NEVER, it is ordering not shape.)
3. **`depends_on` ordering errors abort BEFORE any mutation** — cycle / dangling
   dep ⇒ `ReconcileError("precondition")`. Fail-safe: nothing is created or
   deleted on a malformed DAG.
4. **Wait-for-healthy timeout is fail-safe by return**: the provider returns
   `changed:false` and surfaces a `service.dep_health_timeout` event via
   `ApplyResult.events?[]`; nothing is created, nothing deleted/stopped;
   reconverge next ~60s cycle; no backoff. It NEVER `throw`s (a throw would land
   on the generic `report.failed` path with the PlanAction's `op`).
5. **No-HEALTHCHECK degrades, never punishes**: `service.wait_skipped` event via
   `ApplyResult.events?[]`, apply proceeds (degrades to Phase-1 ordering-only).
6. **Providers never emit StateEvents.** Wait outcomes ride `ApplyResult.events?[]`
   (optional ⇒ conformanceHarness and every existing provider stay green
   untouched); the reconciler Record step persists each event with the cycle
   `actor`+`scope`+`after`. The actor is the cycle actor (`reconcile({ actor })`),
   NOT `ApplyContext` (a secret brand token with no actor). No secret value
   appears in any payload (only service names + health status).

---

## Testing strategy

| Layer | File | Covers |
|---|---|---|
| Schema unit | `core/src/domain/desired-state.test.ts` (EXTEND) | `command` array; `restart` enum (rejects out-of-enum); `depends_on` short + object form; `wait_healthy_timeout` duration regex; **`env_from` dropped** (no longer asserted preserved) |
| `topoSortServices` | `core/src/providers/docker-depends-on.test.ts` (NEW) | correct order; stable tie-break = declaration order; cycle → precondition; dangling dep → precondition |
| `createContainerBody` | `core/src/providers/docker.test.ts` (EXTEND) | `Cmd` present iff `command` declared; `RestartPolicy.Name` present iff `restart` declared; both omitted ⇒ body byte-identical; (2.1) `Healthcheck` present iff declared |
| `isConverged`/`verify` | `core/src/providers/docker.test.ts` (EXTEND) | omitted ⇒ no-flap on existing container; declared+divergent ⇒ not converged |
| Property idempotency | `core/src/reconciler/idempotency.property.test.ts` (EXTEND) | manifests with new fields: apply N× converges; cycle 2..N = no-op (zero mutating actions) |
| `ApplyResult.events` + Record | `core/src/providers/provider.test.ts` (if present) + `core/src/reconciler/reconcile.test.ts` (EXTEND) | `ApplyResult.events[]` is persisted by the reconciler Record step with cycle `actor`+`scope`+`after`; `record()` accepts optional `after`; `conformanceHarness` and every existing provider stay green (`events` optional) |
| `entities.ServiceSchema.depends_on` | `core/src/domain/entities.test.ts` (EXTEND, if present) + `core/src/providers/docker.test.ts` (EXTEND) | `depends_on` survives `ServiceSchema.safeParse(action.desired)` so `apply()` sees it; `createContainerBody` and `isConverged` STILL ignore it (no body key, no flap) |
| wait-for-healthy (2.0) | `core/src/providers/docker-wait-healthy.test.ts` (NEW) | healthy before timeout ⇒ proceed; timeout ⇒ abort by return (`changed:false`) + `service.dep_health_timeout` via `ApplyResult.events` + nothing created/deleted; no HEALTHCHECK ⇒ `service.wait_skipped` via `ApplyResult.events` + proceed; injected clock/sleep (no wall-clock wait). Against `docker-http` fake |
| Secret sentinel | `core/src/reconciler/secret-apply.test.ts` | UNCHANGED — byte-identical; no new field touches the secret path |
| `@live` opt-in | `core/test/live/*.live.test.ts` | optional pre-release; excluded from `npm test` |

CI runs the `unit` project (fakes only) on every commit. `@live` runs on demand
pre-release. Tests never test the Engine itself — only translation and
convergence logic.

---

## File structure (one responsibility per file)

```
core/
  src/
    domain/
      desired-state.ts            MODIFIED: +command +restart +depends_on (P1); +healthcheck (P2.1); -env_from (P1)
      desired-state.test.ts       MODIFIED: assert new fields; assert env_from dropped
      entities.ts                 MODIFIED (P2.0): ServiceSchema gains optional depends_on (so apply() sees deps); body/isConverged still ignore it; update the Phase-1 "intentionally NOT here" comment; +healthcheck (P2.1)
    providers/
      provider.ts                 MODIFIED (P2.0): ApplyResult gains optional additive events?: ReadonlyArray<{ op: string; after?: Record<string, unknown> }> (conformanceHarness untouched — optional)
      docker.ts                   MODIFIED: createContainerBody injections + isConverged comparisons (P1); waitForHealthy seam + dep-health gate that pushes ApplyResult.events (P2.0); +healthcheck mapping (P2.1)
      docker.test.ts              MODIFIED: body + isConverged assertions; depends_on ignored by body/isConverged (P2.0)
      docker-depends-on.ts        NEW (P1): pure topoSortServices(services) — cycle/dangling → ReconcileError("precondition"); reused normaliser for dep names/timeouts
      docker-depends-on.test.ts   NEW (P1)
      docker-wait-healthy.test.ts NEW (P2.0): waitForHealthy seam against docker-http fake; healthy/wait_skipped/timeout; ApplyResult.events surfaced
    reconciler/
      plan.ts                     MODIFIED (P1): feed depends_on edges into buildNodes DAG (intra-service ordering)
      plan.test.ts                MODIFIED (P1): intra-service ordering + cycle/dangling precondition
      reconcile.ts                MODIFIED (P2.0): record() helper accepts optional after → appendEvent; after each report.applied item, iterate ApplyResult.events and record(...) each with cycle actor+scope+after
      reconcile.test.ts           MODIFIED (P2.0): ApplyResult.events persisted with cycle actor+scope+after
      idempotency.property.test.ts MODIFIED: new fields converge; 2nd cycle no-op
    store/
      state-events.ts             CONFIRM (P2.0): appendEvent already accepts/persists after (AppendEventInput.after :67, INSERT :156) — extend only if a gap is found
  test/
    fakes/
      docker-http.ts              MODIFIED (P2.0): inspect returns per-container drivable State.Health.Status via fake.setHealth(name, statuses[]); present ONLY when health set (absent ⇒ no-HEALTHCHECK)
    fixtures/
      manifest-ok.yaml            MODIFIED (P1): drop env_from
docs/
  manifest-schema-cheatsheet.md   MODIFIED: gaps #1/#3/#4 resolved (P1), #2 per-phase; services[] tables gain command/restart/depends_on
CHANGELOG.md                      MODIFIED: [Unreleased] minor entry
```

---

# Phase 1 (P1) — `command` + `restart` + remove `env_from` + `depends_on` ordering

> ✅ shipped (full suite 1138 green) — Tasks 1.1–1.8 complete and committed on
> `main`. Text preserved verbatim for traceability; do not re-run.

**Phase goal:** A manifest can declare `command`, `restart`, and `depends_on`
(short or object form). `command`/`restart` propagate to the container body and
into `isConverged` only when declared; `depends_on` orders services within the
`service` kind (cycle/dangling → precondition before any mutation) and never
enters the body or `isConverged`. The dead `env_from` field is removed from
schema, fixture and docs. **Deliverable:** schema + provider + DAG ordering +
docs, fully shippable. **Exit criteria:** all P1 tests green; typecheck clean;
ALL_TOOLS(12)/V2_TOOLS unchanged; `manifest-ok.yaml` + `desired-state.test.ts`
no longer reference `env_from`; idempotency property covers the new fields;
byte-identical create body for services without new fields.

### Task 1.1 — Remove dead `env_from` from schema, fixture, doc comment

- Files: modify `core/src/domain/desired-state.ts`,
  `core/src/domain/desired-state.test.ts`,
  `core/test/fixtures/manifest-ok.yaml`.
- [x] Familiarise: read `desired-state.ts:73-83` (`ManifestServiceSchema`, the
  dead `env_from: z.string().optional()` at :78), the doc comment at :67-71
  that mentions `env_from`, and `desired-state.test.ts:75-90` (the test
  currently asserting `env_from` is preserved verbatim). Confirm the
  manifest item schema is non-strict (`:27-31`) so legacy manifests carrying
  `env_from` are silently stripped (graceful removal, no error).
- [x] Failing test: in `desired-state.test.ts`, REPLACE the
  `"preserves env_from secret: ref as a plain string"` test (~:75) with a test
  asserting `env_from` is DROPPED:
  ```ts
  it("drops the dead env_from field (silently stripped, non-strict item schema)", () => {
    const state = parseManifest(
      "services:\n  - name: s\n    image: img\n    replicas: 1\n    env_from: secret:legacy\n",
      { sourcePath: "inline" },
    );
    const svc = state.services![0]!;
    expect("env_from" in svc).toBe(false);
  });
  ```
  Also update the existing `manifest-ok.yaml`-driven assertions that read
  `svc.env_from` (~:75-90) so they no longer reference the field.
- [x] Run `npm --prefix core test desired-state` → expect FAIL (the new
  assertion fails because `env_from` is still in the schema and survives parse).
- [x] Minimal impl:
  - Delete the `env_from: z.string().optional()` line (`desired-state.ts:78`)
    and the secret-related `env_from` mention in the doc comment (:67-71); keep
    the `env:` secret note.
  - Remove the `env_from: secret:bevox-harness` line from
    `manifest-ok.yaml` (the fixture's only `env_from` use).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `refactor(core): remove dead env_from from manifest service schema (1.1)`

### Task 1.2 — `command` → `Cmd`; conditional, byte-identical when omitted

- Files: modify `core/src/domain/desired-state.ts`,
  `core/src/domain/desired-state.test.ts`,
  `core/src/providers/docker.ts`,
  `core/src/providers/docker.test.ts`.
- [x] Familiarise: read `createContainerBody` (`docker.ts:306-353`) — the
  `body` object built at :343-352 (`Image`, `Labels`, conditional `Env`,
  `ExposedPorts`, `HostConfig.Binds`) — and `isConverged` (`docker.ts:366-395`).
- [x] Failing test (schema, in `desired-state.test.ts`): parses
  `command: ["redis-server", "--appendonly", "yes"]` into a `string[]`; rejects
  a non-array (e.g. `command: "redis-server"`) as a precondition.
- [x] Failing test (body, in `docker.test.ts`): a service WITH
  `command` produces `body.Cmd` equal to the array; a service WITHOUT `command`
  produces a body with NO `Cmd` key (assert via `"Cmd" in body === false` and a
  byte-identical comparison to the current body for a no-new-fields service).
- [x] Failing test (isConverged, in `docker.test.ts`): with `command` declared
  and the fake inspect's `Config.Cmd` differing ⇒ `isConverged` false; with
  `command` omitted ⇒ `Config.Cmd` ignored (no flap).
- [x] Run `npm --prefix core test desired-state docker` → expect FAIL.
- [x] Minimal impl:
  - Schema: add `command: z.array(z.string()).optional()` to
    `ManifestServiceSchema`.
  - `createContainerBody`: after the body is assembled,
    `if (svc.command !== undefined) body.Cmd = [...svc.command];`
  - `Inspect.Config` type (`docker.ts:165-172`): add optional
    `readonly Cmd?: readonly string[];`.
  - `isConverged`: only when `svc.command !== undefined`, compare
    `insp.Config.Cmd` to `svc.command` (array equality, length + per-index;
    narrow indexed access per `noUncheckedIndexedAccess`); return false on
    mismatch.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): manifest services[].command -> container Cmd (1.2)`

### Task 1.3 — `restart` enum → `HostConfig.RestartPolicy`; conditional

- Files: modify `core/src/domain/desired-state.ts`,
  `core/src/domain/desired-state.test.ts`,
  `core/src/providers/docker.ts`,
  `core/src/providers/docker.test.ts`.
- [x] Familiarise: re-read the `HostConfig` assembly in `createContainerBody`
  (`docker.ts:349-351`, currently `body.HostConfig = { Binds: [...] }`) — the
  restart injection must MERGE, not clobber, so a service with both `volumes`
  and `restart` keeps its `Binds`.
- [x] Failing test (schema): `restart: "always"` parses; `restart: "sometimes"`
  is rejected (precondition). Valid set: `no | on-failure | always | unless-stopped`.
- [x] Failing test (body): WITH `restart` ⇒
  `body.HostConfig.RestartPolicy.Name === svc.restart` AND existing `Binds`
  preserved when `volumes` also present; WITHOUT `restart` ⇒ no `RestartPolicy`
  key (byte-identical to current body).
- [x] Failing test (isConverged): `restart` declared and inspect
  `HostConfig.RestartPolicy.Name` differs ⇒ false; omitted ⇒ not compared
  (Engine default stays, no flap).
- [x] Run `npm --prefix core test desired-state docker` → expect FAIL.
- [x] Minimal impl:
  - Schema: add
    `const RestartPolicySchema = z.enum(["no","on-failure","always","unless-stopped"]);`
    and `restart: RestartPolicySchema.optional()` to `ManifestServiceSchema`.
  - `createContainerBody`:
    `if (svc.restart !== undefined) body.HostConfig = { ...(body.HostConfig as Record<string,unknown> ?? {}), RestartPolicy: { Name: svc.restart } };`
  - `Inspect.HostConfig` type: add optional
    `readonly RestartPolicy?: { readonly Name?: string };`.
  - `isConverged`: only when `svc.restart !== undefined`, compare
    `insp.HostConfig?.RestartPolicy?.Name` to `svc.restart`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): manifest services[].restart -> HostConfig.RestartPolicy (1.3)`

### Task 1.4 — `depends_on` schema (short + object form) + duration regex

- Files: modify `core/src/domain/desired-state.ts`,
  `core/src/domain/desired-state.test.ts`.
- [x] Familiarise: re-read `ManifestServiceSchema` (`desired-state.ts:73-83`).
  This task adds the schema ONLY; ordering/wait wiring come in 1.5/Phase 2.0.
- [x] Failing test (schema): `depends_on: ["postgres"]` parses (short form);
  `depends_on: [{ name: "postgres", wait_healthy_timeout: "120s" }]` parses
  (object form); `wait_healthy_timeout: "2m"` accepted; `"120"` and `"120ms"`
  rejected (duration regex `^\d+[sm]$`); `depends_on: [{ name: "" }]` rejected.
  On the Phase 1 path `wait_healthy_timeout` is parsed/validated but unused.
- [x] Run `npm --prefix core test desired-state` → expect FAIL.
- [x] Minimal impl:
  - `const DurationSchema = z.string().regex(/^\d+[sm]$/);`
  - `const DependsOnEntrySchema = z.union([ z.string().min(1), z.object({ name: z.string().min(1), wait_healthy_timeout: DurationSchema.optional() }) ]);`
  - add `depends_on: z.array(DependsOnEntrySchema).optional()` to
    `ManifestServiceSchema`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): manifest services[].depends_on schema (short+object) (1.4)`

### Task 1.5 — `topoSortServices` pure helper (cycle/dangling → precondition)

- Files: create `core/src/providers/docker-depends-on.ts`,
  `core/src/providers/docker-depends-on.test.ts`.
- [x] Familiarise: read the existing cross-kind topo sort in
  `core/src/reconciler/plan.ts:121-165` and the
  `ReconcileError("precondition")` usage in `core/src/domain/errors.ts` — match
  that error class and message style (cite the cycle / missing name). This helper
  is PURE (no I/O) and intra-`service` only.
- [x] Failing test (`docker-depends-on.test.ts`):
  ```ts
  import { describe, it, expect } from "vitest";
  import { topoSortServices } from "./docker-depends-on.js";
  import { ReconcileError } from "../domain/errors.js";

  const svc = (name: string, depends_on?: unknown[]) =>
    ({ name, image: "img", replicas: 1, ...(depends_on ? { depends_on } : {}) }) as never;

  describe("topoSortServices", () => {
    it("orders each dep before its dependent", () => {
      const out = topoSortServices([svc("app", ["db"]), svc("db")]);
      expect(out.map((s) => s.name)).toEqual(["db", "app"]);
    });
    it("preserves declaration order on a tie (stable, deterministic)", () => {
      const out = topoSortServices([svc("a"), svc("b"), svc("c")]);
      expect(out.map((s) => s.name)).toEqual(["a", "b", "c"]);
    });
    it("accepts the object form of depends_on", () => {
      const out = topoSortServices([
        svc("app", [{ name: "db", wait_healthy_timeout: "120s" }]),
        svc("db"),
      ]);
      expect(out.map((s) => s.name)).toEqual(["db", "app"]);
    });
    it("rejects a cycle as ReconcileError(precondition) citing the cycle", () => {
      expect(() => topoSortServices([svc("a", ["b"]), svc("b", ["a"])])).toThrow(
        ReconcileError,
      );
    });
    it("rejects a dangling dep as ReconcileError(precondition) citing the name", () => {
      let caught: unknown;
      try { topoSortServices([svc("app", ["ghost"])]); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ReconcileError);
      expect((caught as ReconcileError).message).toContain("ghost");
    });
  });
  ```
- [x] Run `npm --prefix core test docker-depends-on` → expect FAIL (module missing).
- [x] Minimal impl `docker-depends-on.ts`:
  - export `topoSortServices(services: ManifestService[]): ManifestService[]`.
  - normalise each entry's dep names (short string OR `{ name }`).
  - Kahn / DFS topo sort; tie-break = declaration order (stable).
  - dangling dep (name not in the service set) ⇒
    `throw new ReconcileError("precondition", "depends_on references unknown service: <name>")`.
  - cycle ⇒ `throw new ReconcileError("precondition", "depends_on cycle: <a>-><b>->...")`,
    raised BEFORE returning any partial order (fail-safe — no mutation possible
    because the helper has no I/O).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): topoSortServices pure DAG helper for depends_on (1.5)`

### Task 1.6 — Wire `depends_on` edges into the reconciler DAG

- Files: modify `core/src/reconciler/plan.ts`,
  `core/src/reconciler/plan.test.ts`.
- [x] Familiarise: read `buildNodes` (`plan.ts:121-165`) — services get
  `deps = (svc.volumes ?? []).map(vol => key("volume", vol))` at :154-161. The
  cross-kind order (`network`→`server`→`volume`→`service`, priority map at
  :80) is FROZEN; this task adds intra-`service` edges only.
- [x] Failing test (`plan.test.ts`): a manifest with
  `services: [app(depends_on:[db]), db]` plans `db` before `app`; a
  self-dependent / cyclic `depends_on` raises `ReconcileError("precondition")`
  before any op is emitted; a `depends_on` referencing a non-existent service
  raises precondition; a `depends_on` referencing a service that DOES exist but
  whose volumes order them differently still keeps each dep before its dependent.
- [x] Run `npm --prefix core test plan` → expect FAIL.
- [x] Minimal impl: in `buildNodes`, for each service add the normalised
  `depends_on` names as `key("service", depName)` to that node's `deps`
  (reusing the normaliser from `docker-depends-on.ts` — DRY, single source for
  the short/object form). The existing cycle/dangling detection in plan()'s
  topo sort now also rejects intra-service cycles and unknown service refs
  (precondition), with no separate code path. `depends_on` is NOT added to
  `PlanAction.desired` shape and never reaches `isConverged`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): order services[] by depends_on in reconciler DAG (1.6)`

### Task 1.7 — Idempotency property covers the new fields (P1)

- Files: modify `core/src/reconciler/idempotency.property.test.ts`.
- [x] Familiarise: read the existing property harness in
  `idempotency.property.test.ts` (how it generates desired states and asserts
  the 2nd+ apply cycle emits zero mutating actions). This is the ground-rule-#2
  invariant for `core/src/providers/**` + `core/src/reconciler/**`.
- [x] Failing test: extend the generator to emit services with random optional
  `command`, `restart`, and `depends_on` (acyclic by construction); assert:
  (a) applying the same desired state twice converges; (b) the 2nd cycle emits
  zero mutating actions; (c) a service with NONE of the new fields produces a
  create body byte-identical to the pre-change body (no flap → no re-create).
- [x] Run `npm --prefix core test idempotency.property` → expect FAIL.
- [x] Minimal impl: none expected in production code — if the property fails,
  the failure is a real convergence bug in 1.2/1.3/1.6 to fix (do NOT weaken
  the property). Only the test file changes.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): idempotency property covers command/restart/depends_on (1.7)`

### Task 1.8 — Docs: cheatsheet + CHANGELOG

- Files: modify `docs/manifest-schema-cheatsheet.md`,
  `CHANGELOG.md`.
- [x] Familiarise: read the cheatsheet `services[]` table (:113-124), the
  "Gaps conhecidos" table (:193-200), the "armadilha do silent-strip"
  note (:202-209), and the `[Unreleased]` section of `CHANGELOG.md`. This is a
  docs-only task (no `core/src/` change) — exempt from TDD per
  `.claude/rules/specs-first.md` "Trivial changes".
- [x] Edits:
  - `services[]` table: add rows for `command` (`string[]`, → `Cmd`),
    `restart` (enum `no|on-failure|always|unless-stopped`, → `RestartPolicy`),
    `depends_on` (`string[] | { name, wait_healthy_timeout }[]`, intra-service
    ordering). Remove the `env_from` row (gap #3 resolved).
  - "Gaps conhecidos": mark #1 (`command`), #3 (`env_from`), #4 (`restart`)
    RESOLVED (Phase 1); mark #2 (`depends_on` + healthcheck-wait) with per-phase
    status (ordering Phase 1, wait Phase 2.0, declarative healthcheck Phase 2.1).
  - Update the "Última verificação contra `main`" date and the silent-strip note
    (gaps #1/#4 now land; only true typos still evaporate).
  - `CHANGELOG.md`: add a minor `### Added` / `### Removed` entry under
    `[Unreleased]` citing this spec by date+slug.
- [x] Verify: cheatsheet no longer mentions `env_from` as a live field; the
  example manifest does not use `env_from`.
- [x] Commit: `docs: cheatsheet + CHANGELOG for services[] additive fields (1.8)`

**Done (P1) =** `command`/`restart`/`depends_on` declarable; body + isConverged
extended only when declared; `depends_on` orders the service DAG (cycle/dangling
→ precondition before mutation) and never enters the body/isConverged; dead
`env_from` removed from schema/fixture/docs; idempotency property green;
byte-identical body for no-new-field services; ALL_TOOLS(12)/V2_TOOLS unchanged;
secret golden test byte-identical. **Shippable / mergeable independently.**

---

# Phase 2.0 (P2.0) — wait-for-healthy via Engine `State.Health.Status` (rev b)

> **Rewritten per spec rev 2026-05-28b (§1.5/§3/§8).** The original 2.0 tasks
> assumed "the provider emits a StateEvent with the actor from `ApplyContext`."
> Implementing Phase 1 proved that contradicts the architecture: `ApplyContext`
> (`store/secrets.ts:119`) is only a secret brand token (no actor); the
> `Provider` contract is `apply() → ApplyResult { entity, op, changed }`
> (providers do NOT write StateEvents); only the reconciler **Record** step
> writes via `appendEvent` (`reconcile.ts:478`) with the cycle `actor`. The
> corrected mechanism: the provider surfaces wait outcomes via a new optional
> additive `ApplyResult.events?[]`, and the Record step persists each with the
> cycle `actor`+`scope`+`after`.

**Phase goal:** When `apply(dependent)` runs, before creating the dependent's
containers it waits for each declared dep's `State.Health.Status` to be
`healthy`, with a per-dep `wait_healthy_timeout` (default 120s). For `apply()`
to see the deps, `entities.ServiceSchema` gains an optional `depends_on`
(`createContainerBody`/`isConverged` still ignore it). No HEALTHCHECK ⇒
degraded-skip (`service.wait_skipped` via `ApplyResult.events`, apply proceeds).
Timeout ⇒ abort **by return** (`changed:false` + `service.dep_health_timeout`
via `ApplyResult.events`, nothing created/deleted, reconverge next cycle, no
backoff). **Deliverable:** `ApplyResult.events?[]` + reconciler Record wiring +
`entities.ServiceSchema.depends_on` + injectable `waitForHealthy` seam + the two
events. **Exit criteria:** all P2.0 tests green; nothing created or deleted on
timeout; both events persisted by Record with the **cycle** actor (not
`ApplyContext`); `conformanceHarness` and every existing provider stay green
(events optional); fakes-only.

### Task 2.0.1 — `ApplyResult.events?[]` + reconciler Record wiring (+ `appendEvent` after)

- Files: modify `core/src/providers/provider.ts`,
  `core/src/reconciler/reconcile.ts`,
  `core/src/reconciler/reconcile.test.ts`,
  `core/src/store/state-events.ts` (confirm; extend only if needed).
- [ ] Familiarise: read `ApplyResult` (`provider.ts:107-111`), the `Provider`
  interface (`:140`) and `conformanceHarness` (`:150+`) — the new field MUST be
  optional so the harness and all existing providers stay green untouched. Read
  the Record loop in `reconcile.ts`: the `record(entity, op, result)` helper
  (`:466-486`, `appendEvent` call at `:478`), the `report.applied` loop
  (`:488-491`), and confirm the cycle `actor`/`scope` are in scope (`actor` at
  `:311`). Read `appendEvent` (`state-events.ts:125`) and confirm
  `AppendEventInput.after` (`:67`) is already persisted (INSERT at `:156`,
  serialised at `:173`) — it is, so no `state-events.ts` change is expected.
- [ ] Failing test (`reconcile.test.ts`): drive a fake provider whose `apply()`
  returns `{ entity, op, changed:true, events: [{ op: "service.wait_skipped",
  after: { reason: "no_healthcheck", dep: "db" } }] }`. After a `reconcile({
  actor })` cycle, assert the `state_events` store contains a row with
  `op: "service.wait_skipped"`, `actor` === the cycle actor, `scope` === the
  cycle scope, and `after: { reason: "no_healthcheck", dep: "db" }`. Assert the
  ordinary `apply`-item row is ALSO present (the events are additive, not a
  replacement). Assert a provider returning NO `events` behaves exactly as today
  (no extra rows).
- [ ] Run `npm --prefix core test reconcile` → expect FAIL (the events row is
  not persisted — `record()` ignores `ApplyResult.events`).
- [ ] Minimal impl:
  - `provider.ts`: extend `ApplyResult` with
    `readonly events?: ReadonlyArray<{ readonly op: string; readonly after?: Record<string, unknown> }>;`
    (optional ⇒ `conformanceHarness` untouched). Document it as "provider-surfaced
    StateEvents; the reconciler Record step persists each with the cycle actor".
  - `reconcile.ts`: extend the `record()` helper signature to accept an optional
    `after?: Record<string, unknown>` and pass it through to
    `appendEvent(pool, { actor, scope, op, entity, result, after })`.
  - In the `report.applied` loop, after recording the apply item, iterate that
    item's `ApplyResult.events ?? []` and `record(a.entity, ev.op, "ok",
    ev.after)` for each — same cycle `actor`+`scope`. (Events ride `result:"ok"`;
    they are not failures.)
  - `state-events.ts`: confirm `after` is accepted/persisted; extend only if a
    gap is found (none expected).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean. Confirm
  `conformanceHarness`-based provider tests still green.
- [ ] Commit: `feat(core): ApplyResult.events surfaced via reconciler Record step (2.0.1)`

### Task 2.0.2 — `entities.ServiceSchema` gains `depends_on` (body/isConverged still ignore it)

- Files: modify `core/src/domain/entities.ts`,
  `core/src/domain/entities.test.ts` (or
  `desired-state.test.ts` if entities has no sibling test),
  `core/src/providers/docker.test.ts`.
- [ ] Familiarise: read `entities.ServiceSchema` (`entities.ts:71-87`) — note the
  Phase-1 comment at `:75-76` that says `depends_on` is "intentionally NOT here:
  it is manifest-level ordering, stripped before the provider". Phase 2.0
  reverses that decision: `apply()` must see the deps to wait on them. Read
  `parseService` (`docker.ts:202-219`, `ServiceSchema.safeParse(action.desired)`
  at `:204`), `createContainerBody` (`~:343-359`) and `isConverged` (`:366+`).
  Reuse the `depends_on` shape (short string OR `{ name, wait_healthy_timeout }`)
  and the normaliser already in `core/src/providers/docker-depends-on.ts`.
- [ ] Failing test (entities schema): `ServiceSchema.safeParse({ name, image,
  replicas, depends_on: ["db"] })` succeeds and the parsed object RETAINS
  `depends_on` (today it is stripped). Object form
  `depends_on: [{ name: "db", wait_healthy_timeout: "120s" }]` also retained.
- [ ] Failing test (`docker.test.ts`): a service with `depends_on` declared
  produces a `createContainerBody` with NO `depends_on`-derived key and
  byte-identical to the same service without `depends_on`; `isConverged` does NOT
  compare `depends_on` (a container that exists converges regardless of
  `depends_on`). (Proves the field reaches the provider WITHOUT leaking into
  container shape.)
- [ ] Run `npm --prefix core test entities docker desired-state` → expect FAIL
  (the entities schema strips `depends_on`).
- [ ] Minimal impl:
  - `entities.ts`: add `depends_on` to `ServiceSchema` mirroring the
    manifest shape — `z.array(z.union([z.string().min(1), z.object({ name:
    z.string().min(1), wait_healthy_timeout: z.string().regex(/^\d+[sm]$/).optional() })])).optional()`.
    Update the Phase-1 "intentionally NOT here" comment to explain it is now
    present for Phase 2.0 wait-for-healthy and is STILL ignored by
    `createContainerBody`/`isConverged`.
  - `docker.ts`: NO change to `createContainerBody` / `isConverged` — they must
    keep ignoring `depends_on`. (If a test proves either now reads it, that is a
    regression to fix in this task.)
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): entities ServiceSchema carries depends_on for apply (2.0.2)`

### Task 2.0.3 — Fake `docker-http` inspect exposes drivable `State.Health.Status`

- Files: modify `core/test/fakes/docker-http.ts`.
- [ ] Familiarise: read the container record `FakeContainer` (`~:90`), the create
  handler (`~:251`), and the inspect projection's `Config`/`HostConfig`/`State`
  (`~:315-330`, returns `State: { Running, Status }` today; `Cmd`/`RestartPolicy`
  already echoed conditionally from Phase 1). The fake must let a test drive a
  named container's health over successive inspect calls (e.g. `starting` →
  `healthy`, or absent for no HEALTHCHECK).
- [ ] Failing test (fake sibling test, or a new assertion in
  `docker-wait-healthy.test.ts`): after `fake.setHealth(name, ["starting",
  "healthy"])`, successive inspects return `State.Health.Status` transitioning to
  `healthy`; a container with no `setHealth` returns inspect WITHOUT
  `State.Health` (no-HEALTHCHECK case).
- [ ] Run `npm --prefix core test docker-http` (or `docker-wait-healthy`) →
  expect FAIL.
- [ ] Minimal impl: add a per-container health driver (a queue of statuses set
  via a new `fake.setHealth(name, statuses[])` seam — last value sticks after the
  queue drains); include `State.Health = { Status }` in the inspect response ONLY
  when health is set (absent ⇒ no-HEALTHCHECK). Keep `State.Status`/`State.Running`
  and the Phase-1 `Cmd`/`RestartPolicy` echo byte-identical for existing tests.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): docker-http fake drives State.Health.Status (2.0.3)`

### Task 2.0.4 — `waitForHealthy` seam: healthy-before-timeout proceeds

- Files: modify `core/src/providers/docker.ts`
  (or a co-located `docker-wait-healthy.ts` if `docker.ts` nears ~600 lines);
  create `core/src/providers/docker-wait-healthy.test.ts`.
- [ ] Familiarise: re-read the apply create+start loop (`docker.ts:493-560`) —
  `replicasOf(svc.name)` at `:503`, `resolveSecretEnv` at `:509`. apply runs
  per-PlanAction (one service). Wait-for-healthy is the dependent's
  pre-condition: before creating the dependent's containers, for each normalised
  dep find the dep's replica containers (via `replicasOf`/`listManaged`) and poll
  Engine `State.Health.Status`. The poll reuses the existing inspect `call` seam;
  `now`/`sleep` are injected so tests never wall-clock-wait.
- [ ] Failing test (`docker-wait-healthy.test.ts`): with the fake driving a dep
  to `healthy` on the 3rd poll within the 120s budget, `waitForHealthy(depName,
  timeoutMs, { call, now, sleep })` resolves `{ outcome: "healthy" }` after ≤3
  polls; assert it advanced the injected clock (no real wall-clock delay).
- [ ] Run `npm --prefix core test docker-wait-healthy` → expect FAIL.
- [ ] Minimal impl: add a pure-ish `waitForHealthy(depName, timeoutMs, { call,
  now, sleep })` helper (in `docker.ts`, or split to a co-located module keeping
  the public API stable if the soft limit is near). It inspects the dep's
  replicas, returns `{ outcome: "healthy" }` when all report
  `State.Health.Status === "healthy"`, polling on the injected `sleep`/`now`
  until the budget. Default budget 120s; per-dep override parses the normalised
  `wait_healthy_timeout` (`^\d+[sm]$` → ms) — reuse the `docker-depends-on.ts`
  normaliser. No outcome wiring into `apply()` yet (2.0.5/2.0.6).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): waitForHealthy seam (healthy proceeds) (2.0.4)`

### Task 2.0.5 — No HEALTHCHECK ⇒ degraded-skip; `service.wait_skipped` via `ApplyResult.events`

- Files: modify `core/src/providers/docker.ts`,
  `core/src/providers/docker-wait-healthy.test.ts`.
- [ ] Familiarise: re-read §1.5/§3 of the spec (rev b) — the provider does NOT
  emit StateEvents; it pushes them onto the returned `ApplyResult.events`. The
  Record step (wired in 2.0.1) persists them with the cycle actor. `op` is a free
  `z.string()` — no migration.
- [ ] Failing test: a dep whose inspect lacks `State.Health` ⇒ `waitForHealthy`
  returns `{ outcome: "wait_skipped", reason: "no_healthcheck", dep }`; the
  provider's `apply(dependent)` PROCEEDS to create the dependent's containers AND
  returns `events` containing `{ op: "service.wait_skipped", after: { reason:
  "no_healthcheck", dep } }`. Assert: the dependent's containers ARE created
  (degrades to ordering-only); no container is removed; a `warn` is logged via
  the Pino seam (no secret in payload).
- [ ] Run `npm --prefix core test docker-wait-healthy` → expect FAIL.
- [ ] Minimal impl: in `waitForHealthy`, when the dep's inspect lacks
  `State.Health`, return `wait_skipped` immediately (no polling). In `apply()`,
  on `wait_skipped`, push `{ op: "service.wait_skipped", after: { reason:
  "no_healthcheck", dep } }` onto the result's `events`, `logger.warn(...)`, and
  continue the create/start loop. No secret value in the payload.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): degraded-skip on missing HEALTHCHECK via ApplyResult.events (2.0.5)`

### Task 2.0.6 — Timeout ⇒ abort by return; `service.dep_health_timeout` via `ApplyResult.events`

- Files: modify `core/src/providers/docker.ts`,
  `core/src/providers/docker-wait-healthy.test.ts`.
- [ ] Familiarise: re-read `.claude/rules/fail-safe.md` — the timeout path must
  NOT delete/stop/remove ANYTHING and must NOT `throw` (a throw lands on the
  reconciler's `report.failed` path with the generic PlanAction `op` `create`).
  It aborts by **return** (`changed:false`) so the event rides the single
  `events` channel. The reconciler reconverges next cycle (no backoff).
- [ ] Failing test: a dep that never reaches `healthy` within the budget ⇒
  `waitForHealthy` returns `{ outcome: "timeout", dep, status, waited_ms }`; the
  provider's `apply(dependent)` does NOT create the dependent's containers,
  returns `{ entity, op, changed: false, events: [{ op:
  "service.dep_health_timeout", after: { dep, status, waited_ms } }] }`. CRITICAL
  assertions: the dep's containers and any pre-existing dependent containers are
  UNCHANGED in the fake's container set (nothing created, nothing deleted/stopped);
  a subsequent `apply` with the dep now healthy converges (reconverge next cycle);
  the event is persisted by Record with the cycle actor (cross-check via the
  reconcile-level test from 2.0.1's wiring).
- [ ] Run `npm --prefix core test docker-wait-healthy` → expect FAIL.
- [ ] Minimal impl: `waitForHealthy` returns `timeout` when the budget elapses on
  the injected clock. In `apply()`, on `timeout`, BEFORE the create loop, push
  `{ op: "service.dep_health_timeout", after: { dep, status, waited_ms } }` onto
  `events` and `return { entity, op, changed: false, events }` — no create, no
  delete, no stop. No backoff state is stored.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): wait-for-healthy timeout aborts by return + ApplyResult.events (2.0.6)`

### Task 2.0.7 — Idempotency property + secret-golden re-assertion (P2.0)

- Files: modify `core/src/reconciler/idempotency.property.test.ts`;
  run (do not edit) `core/src/reconciler/secret-apply.test.ts`.
- [ ] Familiarise: the property is DB-backed — run with
  `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`. Read
  how the generator seeds desired states and asserts the 2nd+ cycle emits zero
  mutating actions (ground rule #2).
- [ ] Failing test: extend the generator so dep services are seeded `healthy` by
  the fake (`fake.setHealth(dep, ["healthy"])`); assert a manifest with
  `depends_on` + wait converges and the 2nd cycle is a no-op — wait-for-healthy
  on an already-healthy dep creates nothing and emits NO `ApplyResult.events`
  (no `service.wait_skipped`/`service.dep_health_timeout` on a converged cycle),
  so zero mutating actions and no spurious StateEvent rows.
- [ ] Run `npm --prefix core test idempotency.property secret-apply` → expect
  FAIL on the new property assertion; `secret-apply.test.ts` must stay green and
  byte-identical (no edit).
- [ ] Minimal impl: only the property test changes; any failure is a real bug in
  2.0.1–2.0.6 to fix without weakening the property.
- [ ] Run → expect PASS. Confirm `secret-apply.test.ts` unchanged on disk and
  green. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): idempotency holds with wait-for-healthy; secret golden intact (2.0.7)`

**Done (P2.0) =** `ApplyResult` carries an optional additive `events?[]`; the
reconciler Record step persists each with the cycle `actor`+`scope`+`after`
(`conformanceHarness` and existing providers untouched); `entities.ServiceSchema`
carries `depends_on` (body/isConverged still ignore it); `waitForHealthy` reads
`State.Health.Status` via an injectable seam; healthy proceeds; no HEALTHCHECK
degrades with `service.wait_skipped` and proceeds; timeout aborts by return
(`changed:false` + `service.dep_health_timeout`) creating and deleting nothing,
reconverging next cycle; both events carry the cycle actor (NOT `ApplyContext`);
idempotency property green; secret golden byte-identical.

---

# Phase 2.1 (P2.1) — declarative `services[].healthcheck`

**Phase goal:** Remove the "upstream image without HEALTHCHECK" friction by
letting the manifest declare a compose-style `healthcheck`, mapped 1:1 to
`ContainerCreate.Healthcheck`. The manifest overrides the image HEALTHCHECK; it
enters `isConverged` only when declared; byte-identical when omitted. Like
`command`/`restart` in Phase 1, `healthcheck` must also be added to
`entities.ServiceSchema` so it reaches the provider. **Deliverable:**
`healthcheck` schema (manifest + entities) + body mapping + isConverged. **Exit
criteria:** all P2.1 tests green; a declared healthcheck reaches the create body
(and unblocks Phase 2.0 wait for upstream images); omitted ⇒ byte-identical body.

### Task 2.1.1 — `HealthcheckSchema` (compose-style) — manifest + entities

- Files: modify `core/src/domain/desired-state.ts`,
  `core/src/domain/desired-state.test.ts`,
  `core/src/domain/entities.ts`,
  `core/src/domain/entities.test.ts` (if present).
- [ ] Familiarise: re-read `ManifestServiceSchema` and the `DurationSchema` added
  in Task 1.4 (reuse it); re-read `entities.ServiceSchema` (`entities.ts:71-87`)
  — `command`/`restart` are present there from Phase 1; `healthcheck` follows the
  same path so `apply()` sees it.
- [ ] Failing test (schema): `parseManifest` parses
  `healthcheck: { test: ["CMD","pg_isready","-U","bevox"], interval: "10s", timeout: "5s", retries: 5, start_period: "30s" }`;
  `test` must be a non-empty `string[]` (rejects empty array); `retries` a
  positive int; durations validated by `^\d+[sm]$`. ALSO assert
  `entities.ServiceSchema.safeParse({ ..., healthcheck })` RETAINS `healthcheck`
  (it must reach the provider).
- [ ] Run `npm --prefix core test desired-state entities` → expect FAIL.
- [ ] Minimal impl:
  ```ts
  const HealthcheckSchema = z.object({
    test: z.array(z.string()).min(1),
    interval: DurationSchema.optional(),
    timeout: DurationSchema.optional(),
    retries: z.number().int().positive().optional(),
    start_period: DurationSchema.optional(),
  });
  ```
  add `healthcheck: HealthcheckSchema.optional()` to BOTH `ManifestServiceSchema`
  (`desired-state.ts`) and `entities.ServiceSchema` (`entities.ts`).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): manifest+entities services[].healthcheck schema (2.1.1)`

### Task 2.1.2 — Map `healthcheck` → `ContainerCreate.Healthcheck`; isConverged when declared

- Files: modify `core/src/providers/docker.ts`,
  `core/src/providers/docker.test.ts`.
- [ ] Familiarise: re-read `createContainerBody` (`~:343-359`) and the Engine
  `ContainerCreate.Healthcheck` shape (`Test: string[]`, `Interval`, `Timeout`,
  `Retries`, `StartPeriod` — durations in nanoseconds per Engine API; map
  `^\d+[sm]$` → ns). Confirm the `Inspect.Config` type addition needed for
  comparison (mirror the Phase-1 `Cmd` addition).
- [ ] Failing test (body): WITH `healthcheck` ⇒ `body.Healthcheck.Test` equals
  the declared `test` and duration fields map to ns; WITHOUT ⇒ no `Healthcheck`
  key (byte-identical to current body). Override note: when both image
  HEALTHCHECK and manifest `healthcheck` exist, the create body carries the
  manifest's (Engine precedence, compose-style).
- [ ] Failing test (isConverged): `healthcheck` declared and inspect
  `Config.Healthcheck.Test` differs ⇒ false; omitted ⇒ not compared (no flap).
- [ ] Run `npm --prefix core test docker` → expect FAIL.
- [ ] Minimal impl:
  - `createContainerBody`: when `svc.healthcheck !== undefined`, set
    `body.Healthcheck = { Test: [...], Interval?, Timeout?, Retries?, StartPeriod? }`
    with durations converted to ns.
  - `Inspect.Config` type: add optional
    `readonly Healthcheck?: { readonly Test?: readonly string[] }`.
  - `isConverged`: only when `svc.healthcheck !== undefined`, compare
    `insp.Config.Healthcheck?.Test` to `svc.healthcheck.test` (array equality,
    narrow indexed access per `noUncheckedIndexedAccess`).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): map services[].healthcheck to ContainerCreate.Healthcheck (2.1.2)`

### Task 2.1.3 — Idempotency property + docs + CHANGELOG (P2.1)

- Files: modify `core/src/reconciler/idempotency.property.test.ts`,
  `docs/manifest-schema-cheatsheet.md`,
  `CHANGELOG.md`.
- [ ] Failing test: extend the property generator with optional `healthcheck`;
  assert convergence and 2nd-cycle no-op; omitted ⇒ byte-identical body.
- [ ] Run `npm --prefix core test idempotency.property` → expect FAIL.
- [ ] Minimal impl: test-only change; fix any real convergence bug in 2.1.2
  without weakening the property. Then update the cheatsheet `services[]` table
  with the `healthcheck` row and mark gap #2's declarative-healthcheck status
  RESOLVED (Phase 2.1); add the `[Unreleased]` CHANGELOG line citing the spec by
  date+slug (rev b).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): idempotency for healthcheck + docs (2.1.3)`

**Done (P2.1) =** declarative `healthcheck` is declarable in both manifest and
`entities.ServiceSchema`, maps to `ContainerCreate.Healthcheck`, overrides the
image HEALTHCHECK, enters `isConverged` only when declared, and is byte-identical
when omitted; idempotency property green; cheatsheet + CHANGELOG updated.

---

## Acceptance criteria (spec §5 — close before final "done")

- [ ] `npm --prefix core run typecheck` clean.
- [ ] `npm --prefix core test` — full suite green (1 `@live` skipped).
- [ ] ALL_TOOLS (12) and V2_TOOLS unchanged (this plan never touches the catalogue).
- [ ] `manifest-ok.yaml` and `desired-state.test.ts` no longer reference `env_from`.
- [ ] `docs/manifest-schema-cheatsheet.md` updated: gaps #1/#3/#4 resolved
      (Phase 1), #2 per-phase; `services[]` tables gain `command`/`restart`/`depends_on`
      (and `healthcheck` after P2.1).
- [ ] Idempotency property test covers the new fields.
- [ ] No stray `S3CR3T-*` sentinel outside `.gitleaks.toml`-allowlisted files;
      `secret-apply.test.ts` byte-identical.
- [ ] `CHANGELOG.md` `[Unreleased]` minor entry present.

---

## Risks

- **Byte-identical body regression.** The transversal invariant is easy to break
  if a new field is injected unconditionally (e.g. `body.Cmd = svc.command ?? []`
  instead of guarding on `!== undefined`). Mitigation: every body task asserts a
  byte-identical body for a no-new-field service (1.2/1.3/2.1.2), and the
  idempotency property re-runs the full loop (1.7/2.0.7/2.1.3).
- **`HostConfig` clobber.** Adding `restart` after `volumes` could drop `Binds`.
  Mitigation: 1.3 explicitly tests `volumes` + `restart` coexistence (merge, not
  replace).
- **Ordering home ambiguity.** The spec names a pure `topoSortServices` helper
  but the provider applies one PlanAction at a time; intra-service ordering must
  live where the DAG is built (`plan.ts`). Mitigation: 1.5 ships the pure helper
  + normaliser (the spec's named contract), 1.6 reuses its normaliser to feed
  `buildNodes`, so cycle/dangling detection has ONE source. If the executor finds
  the provider is a better wiring point, that is a permitted refinement provided
  the fail-safe (precondition before mutation) and "not in isConverged" hold.
- **Wait-for-healthy real-clock flake.** Mitigation: clock/sleep are injected;
  no test wall-clock-waits; the fake drives health transitions deterministically.
- **Fail-safe violation on timeout.** Highest-severity risk. Mitigation: 2.0.6
  aborts by RETURN (`changed:false`, never `throw`), and the test asserts the
  fake's container set is unchanged after a timeout (nothing created, nothing
  deleted) and that a later apply converges (reconverge next cycle).
- **`ApplyResult` / Record contract change (rev b).** Extending `ApplyResult`
  with `events?[]` and threading it through the reconciler `record()` helper
  touches a FROZEN-adjacent seam consumed by `conformanceHarness`
  (`provider.ts:150+`) and every existing provider. Mitigation: `events` is
  STRICTLY OPTIONAL — omitting it is byte-identical to today, so the harness and
  all current providers stay green untouched; 2.0.1's test asserts both that a
  provider returning no `events` behaves exactly as before AND that the ordinary
  apply-item row still lands (events are additive rows, never a replacement). The
  actor is sourced from the cycle (`reconcile({ actor })`), never from
  `ApplyContext` (a secret brand token with no actor) — state-event-actor ground
  rule #5 holds via the canonical source.
- **Duration unit for Engine Healthcheck.** Engine expects nanoseconds.
  Mitigation: 2.1.2 explicitly tests the `^\d+[sm]$` → ns conversion.

## Rollback notes

- Every phase is additive and independently revertible by reverting its commit
  range; no Postgres migration is involved (StateEvent `op` is an open
  `z.string()` enum), so there is nothing to roll forward/back in the schema.
- Phase 1 ships without Phase 2.x; reverting Phase 2.0/2.1 leaves Phase 1's
  `command`/`restart`/`depends_on`-ordering intact.
- The only removal (`env_from`, Task 1.1) is graceful: the item schema is
  non-strict, so a reverted-then-reapplied legacy manifest carrying `env_from` is
  silently stripped either way — no apply error, identical runtime behaviour.
- No destructive operation is introduced anywhere in this plan; reverting cannot
  orphan or delete a managed resource.

## Done = (per phase, summary)

- **P1:** `command`/`restart`/`depends_on`(ordering) shippable; `env_from`
  removed; body + isConverged extended only when declared; `depends_on` orders
  the DAG (cycle/dangling → precondition before mutation, never in isConverged);
  idempotency property green; byte-identical body for no-new-field services.
- **P2.0 (rev b):** `ApplyResult` gains optional additive `events?[]`; the
  reconciler Record step persists each with the cycle `actor`+`scope`+`after`
  (conformanceHarness/providers untouched); `entities.ServiceSchema` carries
  `depends_on` (body/isConverged still ignore it); wait-for-healthy via
  `State.Health.Status` seam; healthy proceeds; no-HEALTHCHECK degraded-skip
  (`service.wait_skipped`); timeout aborts by return (`changed:false` +
  `service.dep_health_timeout`, nothing created/deleted, reconverge next cycle);
  events carry the cycle actor (NOT `ApplyContext`); idempotency + secret golden
  intact.
- **P2.1:** declarative `healthcheck` (manifest + `entities.ServiceSchema`) →
  `ContainerCreate.Healthcheck`, overrides image HEALTHCHECK, in isConverged only
  when declared, byte-identical when omitted; idempotency green; docs + CHANGELOG
  updated.
