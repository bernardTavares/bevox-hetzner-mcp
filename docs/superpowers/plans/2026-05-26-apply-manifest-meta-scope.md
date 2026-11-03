# `apply_manifest` meta-scope — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. 2-3 TDD-sized tasks, ~5 LOC impl + 2 tests.

**Goal:** Make `apply_manifest` via REST work end-to-end (apply path, not just dry_run). Resolve `compositeProvider: unsupported scope/kind "manifest"` 400 precondition by adding a `"manifest"` meta-scope case to `compositeProvider.observe(scope)` that unions native per-kind observes.

**Architecture:** Single-file behavioral change in `core/src/reconciler/composite-provider.ts` + 1 tool-unit regression test + 1 REST integration test (fills the gap noted in spec §1: no current test covers the REST → executeTool path with scope literal "manifest").

**Tech Stack:** Inherits ratified v1 stack — Node 20+, TS 5 strict ESM/NodeNext, Vitest with in-memory fakes, PostgreSQL 16 via `pg`. **Zero new deps, zero new files in `core/src/`.**

**Specs:**
- Spec-filha: `docs/specs/2026-05-26-apply-manifest-meta-scope.md` (Aceita)
- Spec-mãe v1: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` (FROZEN)

---

## Working agreement

- **TDD strict per task**: red → minimal green → commit. Reference `@superpowers:test-driven-development`.
- **Frequent commits**: one task = one commit. Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Tests never touch real infra**: existing fakes in `core/test/fakes/` only.
- **DRY/YAGNI**: only the case `"manifest"` is added; no refactor of `targetsFor` signature; no other scope handling changed.

---

## Non-negotiable principles (CONTRIBUTING §"Ground rules")

1. **Specs come first**: spec-filha aceita 2026-05-26 precedes this code change.
2. **Idempotency by design**: composite.observe stays pure. Existing idempotency property tests stay green.
3. **Fail-safe, never fail-deleting**: composite gains a union accumulator, NEVER a delete path.
4. **Secrets at apply only**: composite.observe never resolves secrets; meta-scope preserves this.
5. **StateEvent actor**: unchanged. No changes to the state-events writer.

---

## File structure

```
core/src/reconciler/composite-provider.ts        MODIFIED: add "manifest" meta-scope branch in observe()
core/src/agent/tools.test.ts                     MODIFIED: regression test (executeTool scope="manifest", apply path)
core/src/agent/rest.test.ts                      MODIFIED: REST integration test for POST /api/apply
```

No new files. No schema migration.

---

# Task 0 — Branch + baseline (BLOCKING GATE)

### Task 0.1 — Branch + baseline verify
- Files: none (branch only). Branch `fix/apply-manifest-meta-scope` already created (controller handled).
- [ ] Baseline `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test npm --prefix core test` → expect 927/928 green matching post-PR-#11 baseline. STOP if red.
- [ ] Done (Task 0) = branch exists, baseline green, F1 may begin.

---

# Fase 1 — Implementation (2 commits)

**Phase goal:** Add the `"manifest"` meta-scope to `compositeProvider.observe`. Add the regression sentinel + the REST integration test.

### Task 1.1 — Composite meta-scope `"manifest"` (impl + unit regression test)
- Files: `core/src/reconciler/composite-provider.ts`, `core/src/agent/tools.test.ts`.
- [ ] Familiarise: read `composite-provider.ts:85-160` (`targetsFor`, `observe`, `apply`). Note that `apply` already routes by `action.entity` kind — no change needed.
- [ ] Failing tool-unit test (append to `tools.test.ts`): use the production-shape composite (route map with the standard 4-6 backends; in-memory fakes from `core/test/fakes/`). Call `executeTool("apply_manifest", { manifest: { networks: [{name:"net-a", ip_range:"10.0.0.0/16"}], servers: [...] }, dry_run: false }, ctx(fullCred(), "manifest"))`. Expected behaviour AFTER the impl lands: envelope `status === "applied"` OR `status === "pending_approval"` — **never** `code: "precondition"` with message matching `/unsupported scope.kind "manifest"/`.
- [ ] Run → expect FAIL with exactly that precondition message (the bug).
- [ ] Minimal impl in `composite-provider.ts` `observe(scope)`:
  ```ts
  async observe(scope: string): Promise<ObservedSlice> {
    if (scope === "manifest") {
      // Meta-scope: union of native observes across every backend.
      // Each backend receives its OWN scope (server/network/volume/service/
      // dns/backup), never "manifest" — preserves assertScope contracts in
      // each concrete provider.
      // Cite: docs/specs/2026-05-26-apply-manifest-meta-scope.md §2.
      const seen = new Set<string>();
      const visited = new Set<Provider>();
      const visit = async (kind: string, p: Provider) => {
        if (visited.has(p)) return;
        visited.add(p);
        const slice = await p.observe(kind);
        for (const e of slice.entities) seen.add(e);
      };
      await visit("network", routes.network);
      for (const p of routes.server) await visit("server", p);
      await visit("volume", routes.volume);
      await visit("service", routes.service);
      if (routes.dns) await visit("dns", routes.dns);
      if (routes.backup) await visit("backup", routes.backup);
      return { scope: "manifest", entities: [...seen] };
    }
    // ... existing per-scope logic unchanged ...
  }
  ```
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean (modulo pre-existing).
- [ ] Commit: `fix(core): compositeProvider observe — manifest meta-scope (1.1)`

### Task 1.2 — REST integration test for `POST /api/apply` (gap-fill)
- Files: `core/src/agent/rest.test.ts`.
- [ ] Familiarise: locate existing REST integration tests in `rest.test.ts`. Most use a fake `catalog` injected into `createRestServer`. Find the pattern for a `POST` route test (auth + body parsing + `executeTool` dispatch).
- [ ] Failing test BEFORE 1.1 would have caught this. AFTER 1.1, the test should PASS. The point of 1.2 is the **regression guard**: future changes that re-introduce the silo will break this test.
- [ ] Test scaffold:
  ```ts
  it("POST /api/apply with multi-kind manifest does not 400 on scope=manifest", async () => {
    // Spin a REST server with a real composite (fakes underneath) + minimal
    // pool. POST manifest with networks + servers + dry_run:false. Read
    // body. Assert response is NOT { code: "precondition", entity:
    // "manifest" } with message matching /unsupported scope.kind/.
    // Status 200 with envelope of status "applied" OR "pending_approval".
  });
  ```
- [ ] Run → expect PASS already (1.1 fixed the root cause). If it accidentally fails, regression is upstream — repair, don't weaken the test.
- [ ] Commit: `test(core): REST integration — POST /api/apply manifest meta-scope (1.2)`

**Done (F1) =** Composite handles `"manifest"` meta-scope; unit + REST tests both green; full suite still 927→929 green (+2).

---

# Fase 2 — Doc updates (optional, 0-1 commit)

`composite-provider.ts` should have a docstring update at the top of the file (or inline at the new branch) citing this spec. This is folded into the 1.1 commit per the task description — Fase 2 is empty unless implementation reveals a broader doc gap.

---

## Risks

- **Composite-provider tests existing** may rely on `targetsFor` being called for every scope; the new branch short-circuits before `targetsFor` for `"manifest"`. Verify no existing test calls `targetsFor("manifest")` expecting the throw.
- **Dedup logic (`visited` Set)** is required because `routes.server` may share a Provider instance with `routes.network`/`routes.volume` (HetznerCloud is shared across multiple kinds). Without dedup, observe could be invoked redundantly.
- **Order of native scopes in the union** must be deterministic — order them alphabetically by kind for stability in tests (network, server, volume, service, dns, backup). The implementation above happens to use the route-map ordering; if that produces test flakiness, switch to alphabetical.

---

## Rollback

If the fix introduces an unforeseen regression in `apply_manifest`, the revert is a single `git revert` of the 1.1 commit. Composite returns to throwing `unsupported scope/kind "manifest"` on the apply path; the `bevox-meta-api` apply real path becomes blocked again but no other regression.

---

## Done = (per phase)

- Task 0 done: branch exists, baseline green.
- F1 done: composite has meta-scope; tool-unit regression test green; REST integration test green; full suite stays green; typecheck clean.
- After merge: rebuild (`npm --prefix core run build`) + `sudo systemctl restart bevox-daemon.service` + notify `bevox-meta-api` parallel session to retry `apply_manifest` apply path.
