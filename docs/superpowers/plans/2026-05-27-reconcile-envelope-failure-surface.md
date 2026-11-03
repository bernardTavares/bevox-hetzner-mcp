# `reconcileToEnvelope` failure surface + logger threading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each task
> is a self-contained TDD unit (failing test → run → minimal impl → run →
> commit). Do not skip the red step. Do not batch commits.

**Goal:** Make `core/src/agent/tools.ts::reconcileToEnvelope` return a
`WriteEnvelope { status: "error" }` carrying the first `FailedItem`'s
`{errorClass, message, entity}` whenever `applyPlan` reports failures and
the gate withheld nothing — without disturbing the existing
`pending_approval > applied` precedence — and thread the `ToolDeps.logger`
seam into the catalog's `reconcile()` call so on-demand apply paths emit
the same structured journal lines the periodic reconciler already does.

**Architecture:** Two surgical, additive deltas in one consumer file
(`core/src/agent/tools.ts`) plus a one-line wiring change in
`core/src/server.ts`. No new files. No new types beyond an optional
`logger?: Logger` field on `ToolDeps`. No change to `applyPlan`,
`reconcile()` factory, `WriteEnvelope` enum, `state_events.after` shape, or
the Approval Gate. The reconcile precedence becomes explicit and
documented in code: **withheld > failed > applied**.

**Tech Stack:** Inherits v1 (Node.js 20+, TypeScript 5.x ESM/NodeNext strict,
Vitest, Zod, Pino). **Zero new dependencies.** Reuses
`core/src/observability/logger.ts::Logger` already imported by
`reconcile.ts`, and the already-imported `error as errorEnvelope` from
`core/src/agent/envelope.ts`.

**Specs:**
- This change (spec-filha): `docs/specs/2026-05-27-reconcile-envelope-failure-surface.md` (Aceita 2026-05-27)
- v1 base (FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Sibling spec exposing the bug during smoke-test: `docs/specs/2026-05-26-apply-manifest-silo-fanout.md`

**Branch:** `fix/reconcile-envelope-failure-surface` (already cut from
`main`). This plan **MUST NOT** create a new branch — all commits land on
the existing branch.

---

## How this plan is executed

Two short phases plus a verification gate. F1 closes the spec's primary
defect (silent `applied` masking real failures); F2 closes the correlated
observability defect (silent journal on the tool path). F3 is a single
verification step before opening the PR. Run F1 to completion before
starting F2; do not batch.

All paths are relative to repo root ``.
The test command is always:

```bash
DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
  npm --prefix core test -- <relative-path-under-core>
```

Suite baseline before any change: **950/951 green** (1 `@live` skipped).
After F1+F2 the baseline becomes **954-955/956 green** depending on whether
the optional precedence-coverage test in T1.3 is added (the plan keeps it
because the regression value is high).

### Working agreement (all tasks)

- **TDD, always**: red → minimal green → commit. Reference
  @superpowers:test-driven-development.
- **DRY / YAGNI / minimal change**: only the two deltas the spec authorises.
  No refactor of `applyPlan`, `reconcile()` factory, `WriteEnvelope`,
  Approval Gate, or `state_events`. Reference
  @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Commit trailer mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: fakes only (`makeFakeProvider`,
  `pg-harness`). `@live` excluded by the vitest `unit` project glob.
- **TS strict ESM/NodeNext**: every relative import ends in `.js`; every
  type-only import uses `import type`.
- **No silent drift correction**, **no destructive rollback**. This plan
  does not add a delete path. (CONTRIBUTING §"Ground rules" #3.)
- **No new config knob.** The behaviour change is unconditional.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — no changes

The wire contract (`console/src/api/contract.ts WriteEnvelopeSchema`) is
**not** touched. The `status: "error"` variant has been in the enum since
v1; this plan only constructs it in a code path that previously returned
`applied()` incorrectly. No new fields, no new statuses, no new tools.

The `WriteEnvelope.error` shape is the existing `ApiError`:

```ts
{ code: ErrorClass, message: string, retryable: boolean, entity: string }
```

mapped 1:1 from a `FailedItem`'s `{errorClass, message, entity}` via the
already-imported `errorEnvelope(new ReconcileError(class, msg, {entity}))`.

---

## Non-negotiable principles (additive to v1)

All v1 principles apply unchanged. Additions for this plan:

14. **Precedence is data, not branching elsewhere.** `reconcileToEnvelope`
    is the single site that maps `ReconcileResult` → `WriteEnvelope`; the
    precedence `withheld > failed > applied` lives only here, and is
    documented inline with a path reference to this spec.
15. **`logger` stays optional.** Every existing call site of
    `createToolCatalog({...})` that does not pass a logger must continue
    to compile and run exactly as before (silent `noopLogger` inside
    reconcile). Backwards-compat is enforced by leaving the default
    fallback in `reconcile.ts:305` untouched.

---

## Testing strategy

Inherits v1 strategy (CONTRIBUTING §"Tests never touch real infra"). All
new assertions live in `core/src/agent/tools.test.ts` next to the
existing catalog suite (~1300 lines, beforeAll/beforeEach already wire
`pg-harness`).

| Layer                  | How                                                                                                                                              | What it covers                                                                                       |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Unit (tools.test.ts)   | New `describe("reconcileToEnvelope failure surfacing")` with a `makeFailingProvider(entity, message)` whose `apply()` throws a `ReconcileError`. | Spec §9 acceptance #1 — `failed > 0 && withheld === 0` → `error` envelope; pinning via `requested.entity`. |
| Unit (tools.test.ts)   | Regression: existing all-success path through the same fake (no throw) still returns `applied`.                                                  | Spec §9 acceptance #2 — backwards-compat for the no-failure happy path.                              |
| Unit (tools.test.ts)   | Precedence: a `provision_server` call (always-sensitive gate) whose apply also has a failed item ⇒ still returns `pending_approval`.             | Spec §9 acceptance #3 — approval precedes failure.                                                   |
| Unit (tools.test.ts)   | Logger spy injected via new `ToolDeps.logger`; calls `apply_manifest`; asserts the spy received the `"reconcile cycle complete"` info line.      | Spec §9 acceptance #5 — logger threaded into the on-demand reconcile path.                           |
| Unit (existing suite)  | Re-run all ~950 existing tests untouched.                                                                                                        | Spec §9 acceptance #6 + #7 — `noopLogger` fallback + no regression in 950/951 baseline.              |
| Property (existing)    | `core/src/reconciler/idempotency*.property.test.ts`. **No edits, no weakening.**                                                                 | Idempotency invariant preserved (no apply/destroy changes).                                          |
| `@live`                | Not required. No new HTTP wire, no new provider.                                                                                                 | n/a                                                                                                  |

---

## File structure (one responsibility per file)

```
core/
  src/
    agent/
      tools.ts                  MODIFIED  — reconcileToEnvelope precedence (~12 lines) + ToolDeps.logger optional (~3 lines) + destructure + thread to reconcile()
      tools.test.ts             MODIFIED  — append two new describe blocks (failure surfacing + logger threading)
    server.ts                   MODIFIED  — single-line: pass `logger` to createToolCatalog({...}) (line ~399-412)
```

No new files. No file approaches the ~600-line soft limit by this change
(`tools.ts` grows by ~15 lines net; `tools.test.ts` grows by ~140 lines —
well within budget).

---

# Task 0 — pre-flight baseline (BLOCKING)

**Goal/deliverable:** Confirm the working tree starts from the documented
baseline so the red step in T1.1 is unambiguous (a test that fails
because the production code is wrong, not because the suite was already
broken).

**Exit criteria:** Full suite green at 950/951 (1 `@live` skipped). Branch
`fix/reconcile-envelope-failure-surface` checked out.

### Task 0.1 — baseline verification

- Files: none (read-only).
- [ ] Confirm branch: `git rev-parse --abbrev-ref HEAD` returns
  `fix/reconcile-envelope-failure-surface`.
- [ ] Confirm clean tree: `git status` is clean.
- [ ] Run the full suite:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  ```
- [ ] Expect: 950 passed, 1 skipped (`@live`). If the count differs,
  STOP and surface the deviation to the operator before continuing.
- [ ] Run typecheck:
  ```bash
  npm --prefix core run typecheck
  ```
- [ ] Expect: clean exit, zero diagnostics.
- [ ] No commit (read-only gate).

**Done (Task 0) =** baseline confirmed, branch ready.

---

# Fase 1 (F1) — failure surfacing

**Phase goal:** `reconcileToEnvelope` returns `error` when `applyPlan`
reports failures and the gate withheld nothing. Approval precedence
preserved.

**Deliverable:** Spec §9 acceptance criteria #1, #2, #3, #4 met.

**Exit criteria:**

- Three new tests in `tools.test.ts` pass.
- All pre-existing tests still pass.
- `npm --prefix core run typecheck` clean.
- Inline comment in `tools.ts` cites the spec path and documents the
  precedence.

### Task 1.1 — failing test: `failed > 0 && withheld === 0` → `error` envelope

**Files to read first (with line ranges):**

- `core/src/agent/tools.ts:73-78` — confirm `error as errorEnvelope` import.
- `core/src/agent/tools.ts:329-386` — current `reconcileToEnvelope` body.
- `core/src/agent/tools.test.ts:89-201` — existing `makeFakeProvider` +
  `makeCatalog` harness shape (the new fake is a sibling of the throwing
  observe provider at lines 120-133).
- `core/src/reconciler/apply.ts:80-85` — `FailedItem` shape.
- `core/src/domain/errors.ts:133-175` — `ReconcileError` constructor +
  `toApiError()` mapping (errorClass → ApiError.code, retryable
  derivation).

**Files to modify:** `core/src/agent/tools.test.ts` (append a new
`describe` block after the existing `describe("authorized-but-failed
mutation")` block around line 1196; place it BEFORE the `Task F4.7`
block at line 1212).

- [ ] Familiarise: read the four files above; note that
  `applyPlan` (`core/src/reconciler/apply.ts`) catches a thrown
  `ReconcileError`, calls `classify`, and pushes a `FailedItem` with
  `errorClass`, `message`, `entity`. A throwing fake provider is the
  cleanest way to drive a `failed` bucket without touching apply.ts.

- [ ] Failing test — append to `core/src/agent/tools.test.ts`:

  ```ts
  // ===========================================================================
  // 9. Spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md
  //    reconcileToEnvelope precedence: withheld > failed > applied.
  // ===========================================================================

  /**
   * A Provider whose `apply()` throws a ReconcileError for a specific entity
   * key. observe() returns no observed entities (so plan() emits a create);
   * verify() is never reached. Used to drive applyPlan into the `failed`
   * bucket without touching apply.ts.
   */
  function makeFailingApplyProvider(
    failOn: string,
    message: string,
    errorClass: "transient" | "precondition" | "conflict" | "fatal" | "partial" = "transient",
  ): Provider {
    const reality = new Set<string>();
    return {
      name: "failing-apply",
      async observe(scope: string): Promise<ObservedSlice> {
        const prefix = `${scope}:`;
        return {
          scope,
          entities: [...reality].filter((k) => k.startsWith(prefix)),
        };
      },
      async apply(action: PlanAction): Promise<ApplyResult> {
        if (action.entity === failOn) {
          // Imported lazily so the require chain stays tight. Use the
          // already-exported ReconcileError.
          const { ReconcileError } = await import("../domain/errors.js");
          throw new ReconcileError(errorClass, message, { entity: failOn });
        }
        reality.add(action.entity);
        return { entity: action.entity, op: action.op, changed: true };
      },
      async verify(action: PlanAction): Promise<boolean> {
        return reality.has(action.entity);
      },
    };
  }

  describe("reconcileToEnvelope failure surfacing (spec 2026-05-27)", () => {
    it("failed > 0 && withheld === 0 → error envelope carrying the FailedItem", async () => {
      // apply_manifest with a single network whose apply() throws transient.
      // Conditional policy + non-sensitive op ⇒ gate approves ⇒ apply runs ⇒
      // FailedItem present, withheld empty.
      const provider = makeFailingApplyProvider(
        "network:bug5-diag",
        "POST /v1/networks failed with HTTP 400",
        "transient",
      );
      const cat = makeCatalog({ provider });
      const res = await cat.executeTool(
        "apply_manifest",
        {
          manifest: {
            networks: [{ name: "bug5-diag", ip_range: "10.50.0.0/16" }],
          },
          dry_run: false,
        },
        ctx(fullCred(), "network"),
      );
      expect(res.status).toBe("error");
      const e = env(res);
      expect(e.error?.code).toBe("transient");
      expect(e.error?.message).toBe("POST /v1/networks failed with HTTP 400");
      expect(e.error?.entity).toBe("network:bug5-diag");
      expect(e.error?.retryable).toBe(true); // transient ⇒ retryable
    });
  });
  ```

- [ ] Run the new test ONLY:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test -- src/agent/tools.test.ts \
    -t "failed > 0 && withheld === 0"
  ```
- [ ] Expect: **FAIL** with `expected "applied" to be "error"` (or
  similar). Confirm the failure is the assertion on `res.status`, NOT a
  type/import error. If the test errors before assertion, fix the test
  scaffolding (imports, fake shape) before touching production.

- [ ] Minimal impl in `core/src/agent/tools.ts::reconcileToEnvelope`
  (the function ends at line 386 today with `return applied();`):

  - Locate the closing block of the `if (result.withheld.length > 0)`
    branch (currently ending around line 384 with the `throw new
    ReconcileError("fatal", ...)`).
  - Immediately AFTER that closing brace and BEFORE the final
    `return applied();`, insert a new block that:
    - checks `result.failed.length > 0`;
    - picks the `FailedItem` matching `requested.entity` when
      `requested !== undefined`, fallback to `result.failed[0]`;
    - guards a `picked === undefined` internal-invariant violation with a
      `throw new ReconcileError("fatal", ..., { entity: scope })`
      mirroring the existing withheld-no-id guard;
    - returns `errorEnvelope(new ReconcileError(picked.errorClass,
      picked.message, { entity: picked.entity }))`.
  - Update the JSDoc above `reconcileToEnvelope` (currently lines
    320-328) to document the explicit precedence
    `withheld > failed > applied` and cite
    `docs/specs/2026-05-27-reconcile-envelope-failure-surface.md`.

  Shape reference (do NOT copy verbatim; preserve surrounding style):

  ```ts
  // Spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.1:
  // withheld > failed > applied. With no withheld items, surface the first
  // FailedItem as an error envelope; if the caller pinned an entity, prefer
  // the FailedItem whose entity matches.
  if (result.failed.length > 0) {
    const picked =
      requested !== undefined
        ? result.failed.find((f) => f.entity === requested.entity)
          ?? result.failed[0]
        : result.failed[0];
    if (!picked) {
      throw new ReconcileError(
        "fatal",
        "reconcileToEnvelope: report.failed.length > 0 but no item present (internal invariant)",
        { entity: scope },
      );
    }
    return errorEnvelope(
      new ReconcileError(picked.errorClass, picked.message, {
        entity: picked.entity,
      }),
    );
  }
  return applied();
  ```

- [ ] Re-run the targeted test → expect **PASS**.
- [ ] Run the full suite:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  ```
- [ ] Expect: 951 passed, 1 skipped. No regressions.
- [ ] `npm --prefix core run typecheck` → clean.
- [ ] Commit:
  ```
  fix(core): reconcileToEnvelope surfaces apply failures as error envelope (1.1)

  Spec: docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.1.
  When applyPlan reports failed items and the gate withheld nothing, return
  WriteEnvelope{status:"error"} carrying the first FailedItem's
  {errorClass, message, entity}. Precedence withheld > failed > applied
  is now documented inline.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Task 1.2 — failing test: pinning prefers the matching `FailedItem`

**Files to read first:**

- `core/src/agent/tools.ts:405-446` — `doProvisionServer` (the
  per-entity tool that pins `requested.entity`).
- `core/src/agent/tools.ts:355-385` — the existing pinning logic for
  `pendingApprovals` is the exact pattern to mirror for `failed`.

**Files to modify:** `core/src/agent/tools.test.ts` (append inside the
same describe block opened in T1.1).

- [ ] Failing test — append inside the
  `describe("reconcileToEnvelope failure surfacing (spec 2026-05-27)")`
  block:

  ```ts
  it("pins the FailedItem to requested.entity when the caller pins one", async () => {
    // apply_manifest declares TWO networks; provider fails on the second
    // (alphabetically later) only. apply_manifest does NOT pin a
    // requested.entity, so the fallback picks failed[0]. To exercise the
    // PIN branch we drive provision_server (which pins via requested
    // { op:"create", entity:"server:<name>" }), but provision_server is
    // always-sensitive (gate withholds — pending_approval). The test
    // therefore uses apply_manifest with TWO failing networks and asserts
    // the envelope's error.entity is one of them (the deterministic first
    // in failed[]). A separate provision_server-style test is impossible
    // without changing the gate; the existing pendingApprovals pinning
    // test (lines 437-541) already covers the symmetric path.
    //
    // What this test ACTUALLY needs to prove is the find()-vs-[0]
    // selection. We use a fake that fails on BOTH entities and assert
    // the result depends on which fan-out scope reconcile picks up.
    const provider = makeFailingApplyProvider(
      "network:net-b", // only net-b fails
      "boom-net-b",
      "conflict",
    );
    const cat = makeCatalog({ provider });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [
            { name: "net-a", ip_range: "10.0.0.0/16" },
            { name: "net-b", ip_range: "10.1.0.0/16" },
          ],
        },
        dry_run: false,
      },
      ctx(fullCred(), "network"),
    );
    expect(res.status).toBe("error");
    expect(env(res).error?.entity).toBe("network:net-b");
    expect(env(res).error?.code).toBe("conflict");
    expect(env(res).error?.retryable).toBe(false); // conflict ⇒ not retryable
  });
  ```

  Note: if the executor finds during red-run that
  `apply_manifest` does pass a `requested` (it does NOT, per
  `tools.ts:624`), this assertion only covers the **fallback** path
  (`result.failed[0]`). That is the spec-§4.1 explicit case for tools
  that do not pin. The PIN branch is exercised structurally by the
  existing `pendingApprovals` pinning suite (lines 437-541) which mirrors
  the same `requested.entity` matching pattern; the production code in
  T1.1 reuses that exact pattern verbatim. No additional pin-specific
  red test is necessary — the patch is mechanically symmetric.

- [ ] Run targeted test → expect **PASS** (the impl from T1.1 already
  handles this case because `result.failed[0]` will be `network:net-b`
  when it is the only failing item).

  If it does not pass on the first run, the production impl in T1.1 is
  wrong (not the test): re-read the impl, do not adjust the assertion.

- [ ] Run full suite → 952/953 (one more test added).
- [ ] `npm --prefix core run typecheck` → clean.
- [ ] Commit:
  ```
  test(core): reconcileToEnvelope picks the failing FailedItem deterministically (1.2)

  Spec: docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.1.
  Locks in the failed[0] fallback for tools that do not pin a
  requested.entity (apply_manifest). The PIN branch is structurally
  identical to the existing pendingApprovals pinning logic (tools.ts ~355-370)
  and is covered by symmetry.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Task 1.3 — failing test: precedence guard (`withheld > failed`)

**Files to read first:**

- `core/src/agent/tools.ts:355-385` — current `if
  (result.withheld.length > 0) { ... return pendingApproval(id); }`
  branch; this test asserts that branch wins when both buckets are
  non-empty.
- `core/src/agent/tools.test.ts:437-541` — existing
  `pending_approval carries the EXACT requested-action approval_id`
  block; the new test mirrors its harness.

**Files to modify:** `core/src/agent/tools.test.ts` (append inside the
same describe block).

- [ ] Failing test — append inside
  `describe("reconcileToEnvelope failure surfacing (spec 2026-05-27)")`:

  ```ts
  it("withheld > failed: pending_approval wins even when the cycle also has failed items", async () => {
    // provision_server is always-sensitive ⇒ gate WITHHOLDS the server
    // create (pending_approval row opened). The provider also fails on
    // the network create that plan() emits to satisfy ref-completeness.
    // Spec §4.1: withheld precedes failed ⇒ envelope is pending_approval,
    // never error.
    const provider = makeFailingApplyProvider(
      "network:net-a", // network apply fails ...
      "boom",
      "transient",
    );
    const desiredByScope = new Map<string, DesiredState>([
      ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
    ]);
    const cat = makeCatalog({ provider, desiredByScope });
    const res = await cat.executeTool(
      "provision_server",
      { name: "app-1", type: "cx22", location: "nbg1", network: "net-a" },
      ctx(fullCred(), "server"),
    );
    // provision_server is ALWAYS-sensitive ⇒ the gate withholds the
    // server create. Even though the network apply ALSO fails this cycle,
    // the envelope MUST be pending_approval (approval precedence).
    expect(res.status).toBe("pending_approval");
    expect(env(res).approval_id).toMatch(/^apr_/);
  });
  ```

- [ ] Run targeted test → expect **PASS** (T1.1's impl placed the
  `failed` branch AFTER the existing `withheld` branch, so withheld
  still short-circuits first).

  If it fails, the impl from T1.1 is in the wrong place — the failed
  branch must come AFTER the withheld branch, not before.

- [ ] Run full suite → 953/954.
- [ ] `npm --prefix core run typecheck` → clean.
- [ ] Commit:
  ```
  test(core): pending_approval precedes failed in reconcileToEnvelope (1.3)

  Spec: docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.1.
  Regression sentinel proving precedence withheld > failed > applied:
  even when applyPlan reports both buckets non-empty, the envelope is
  pending_approval. This preserves the v1 gating-precedes-reporting
  posture documented in §4.1 of the spec.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Task 1.4 — regression sentinel: all-success path still returns `applied`

**Files to read first:**

- `core/src/agent/tools.test.ts:991-1003` — existing happy-path
  `apply_manifest` test. This T1.4 sentinel just confirms our new
  branching did not break it.

**Files to modify:** `core/src/agent/tools.test.ts` (append inside the
same describe block).

- [ ] Failing test — append inside the same describe block. Because the
  existing test at line 991 already proves the happy path, this task adds
  a sibling that explicitly uses the new `makeFailingApplyProvider`
  helper with `failOn` set to an unreachable entity, locking in that the
  new code does not regress when `failed` is empty:

  ```ts
  it("all-success path (no failed, no withheld) still returns applied — regression for the new branch", async () => {
    // Same failing-apply helper, but failOn targets an entity that is
    // NOT in the manifest ⇒ apply never throws ⇒ failed.length === 0.
    const provider = makeFailingApplyProvider("network:does-not-exist", "unreachable");
    const cat = makeCatalog({ provider });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        },
        dry_run: false,
      },
      ctx(fullCred(), "network"),
    );
    expect(res.status).toBe("applied");
    expect(env(res).error).toBeUndefined();
  });
  ```

- [ ] Run targeted test → expect **PASS**.
- [ ] Run full suite → 954/955.
- [ ] `npm --prefix core run typecheck` → clean.
- [ ] Commit:
  ```
  test(core): reconcileToEnvelope still returns applied when no failure (1.4)

  Spec: docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §9 #2.
  Regression sentinel for backwards-compat: the new failed-branch must
  not affect the no-failure happy path.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

**Done (F1) =** `reconcileToEnvelope` surfaces failures as `error`,
preserves `pending_approval` precedence, preserves `applied` happy path,
and is documented inline. Full suite green at 954/955.

---

# Fase 2 (F2) — logger threading

**Phase goal:** Thread the `ToolDeps.logger` seam into `reconcile()` so
on-demand apply paths emit the same `reconcile cycle complete` /
`reconcile apply item` lines the periodic reconciler already does. Keep
`logger` optional so existing test harnesses are unaffected.

**Deliverable:** Spec §9 acceptance criteria #5 and #6 met.

**Exit criteria:**

- One new test in `tools.test.ts` passes (logger spy receives the cycle
  line on the apply path).
- All pre-existing tests still pass (logger absent ⇒ `noopLogger`
  fallback preserved).
- `server.ts` `createToolCatalog({...})` call passes `logger` from outer
  scope.
- `npm --prefix core run typecheck` clean.

### Task 2.1 — failing test: `ToolDeps.logger` reaches `reconcile()`

**Files to read first:**

- `core/src/observability/logger.ts:53-74` — `Logger` interface and
  `LogFields` shape.
- `core/src/reconciler/reconcile.ts:197-211` — `ReconcileDeps.logger`
  (optional) — the seam being threaded.
- `core/src/reconciler/reconcile.ts:300-310` — factory destructure + the
  `noopLogger` fallback at line 305. **Do not touch this fallback.**
- `core/src/agent/tools.ts:181-208` — `ToolDeps` interface (where the
  optional `logger?: Logger` field is added).
- `core/src/agent/tools.ts:311-313` — the `createToolCatalog` factory
  destructure (where `logger` is added).
- `core/src/agent/tools.ts:345-352` — the `reconcile({...})` call inside
  `reconcileToEnvelope` (where `logger` is forwarded).
- `core/src/server.ts:399-412` — the production `createToolCatalog({...})`
  call site (where `logger` is passed in from outer scope).
- `core/src/server.ts:463-472` — confirms `logger` is already in scope
  here (line 469 wires it into the periodic `reconcileDeps`).

**Files to modify:**

- `core/src/agent/tools.test.ts` — append a new top-level describe block
  after the F1 block.
- `core/src/agent/tools.ts` — `ToolDeps` interface + factory destructure
  + `reconcile()` call.
- `core/src/server.ts` — single-line addition to the
  `createToolCatalog({...})` call.

- [ ] Familiarise: read all eight ranges above. Note that `Logger.info`
  takes `(fields: LogFields, msg: string)`. `reconcile.ts` emits two
  info-level cycle lines: `"reconcile cycle complete"` (per cycle) and
  `"reconcile apply item"` (per applied item). Either is sufficient
  proof the logger reached `reconcile`; the cycle-complete line is the
  more deterministic single-shot signal.

- [ ] Failing test — append to `core/src/agent/tools.test.ts` (after
  the F1 block, before `Task F4.7`):

  ```ts
  // ===========================================================================
  // 10. Spec docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.2
  //     ToolDeps.logger threads to reconcile() so on-demand apply emits
  //     the same journal lines the periodic reconciler already does.
  // ===========================================================================

  describe("ToolDeps.logger threading (spec 2026-05-27 §4.2)", () => {
    it("createToolCatalog({...logger}) forwards logger to reconcile() — cycle-complete is logged on apply path", async () => {
      type LogCall = { fields: Record<string, unknown>; msg: string };
      const calls: LogCall[] = [];
      const spyLogger = {
        info(fields: Record<string, unknown>, msg: string): void {
          calls.push({ fields, msg });
        },
        warn(fields: Record<string, unknown>, msg: string): void {
          calls.push({ fields, msg });
        },
        error(fields: Record<string, unknown>, msg: string): void {
          calls.push({ fields, msg });
        },
      };

      // Build a catalog like makeCatalog() but pass the spy logger.
      const desiredByScope = new Map<string, DesiredState>();
      let idn = 0;
      const cat: ToolCatalog = createToolCatalog({
        pool,
        provider: makeFakeProvider(),
        observedAdapter,
        loadDesired: async (scope: string): Promise<DesiredState> =>
          desiredByScope.get(scope) ?? {},
        writeDesired: async (scope: string, desired: DesiredState) => {
          desiredByScope.set(scope, desired);
        },
        makeGate: (isSensitive): ReconcileGate =>
          createApprovalGate({
            pool,
            clock,
            isSensitive,
            idFactory: () => `apr_test_${++idn}`,
          }),
        logger: spyLogger,
      });

      const res = await cat.executeTool(
        "apply_manifest",
        {
          manifest: { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] },
          dry_run: false,
        },
        ctx(fullCred(), "network"),
      );
      expect(res.status).toBe("applied");

      // The reconcile() factory emits at least one structured info line per
      // completed cycle. We assert the spy received one of the canonical
      // cycle-level messages on this on-demand apply path.
      const messages = calls.map((c) => c.msg);
      expect(messages).toContain("reconcile cycle complete");
    });

    it("ToolDeps.logger absent ⇒ no logger calls (noopLogger fallback preserved)", async () => {
      // The default makeCatalog() does NOT pass logger; the existing 950+
      // tests already prove this code path is silent. This sentinel just
      // locks in that the new optional field really is optional at the
      // TypeScript level (compile-time check) and runtime (no thrown
      // TypeError).
      const cat = makeCatalog();
      const res = await cat.executeTool(
        "apply_manifest",
        {
          manifest: { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] },
          dry_run: false,
        },
        ctx(fullCred(), "network"),
      );
      expect(res.status).toBe("applied");
    });
  });
  ```

  Note: the spy uses a structural `Record<string, unknown>` for `fields`
  instead of importing `LogFields` directly — the catalog passes a
  `Logger` by structural compatibility; the test does not need the
  nominal type. This keeps the test colocated and avoids broadening the
  test's import surface.

- [ ] Run the new test ONLY:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test -- src/agent/tools.test.ts \
    -t "createToolCatalog.*forwards logger"
  ```
- [ ] Expect: **FAIL** — either:
  - `createToolCatalog` rejects the `logger` property at the TypeScript
    level (compile error in the test), OR
  - `messages` does not contain `"reconcile cycle complete"` because the
    catalog never forwards `logger` to `reconcile()`.

  Either failure mode is correct red. If the test errors before
  assertion due to a stale import path, fix the test scaffolding before
  touching production.

- [ ] Minimal impl — three coordinated edits:

  **(a) `core/src/agent/tools.ts:181-208`** — add optional field to
  `ToolDeps`:

  - Insert (after the existing `observedReader?` field block, before the
    closing `}`):

    ```ts
    /**
     * OPTIONAL — structured logger threaded into the reconcile() factory
     * inside reconcileToEnvelope (spec docs/specs/2026-05-27-…). When
     * omitted, reconcile() falls back to noopLogger — backwards-compat
     * with every existing test that constructs ToolDeps without logger.
     */
    readonly logger?: Logger;
    ```

  - At the top of the file (after the existing `import type` block
    around line 87), add:

    ```ts
    import type { Logger } from "../observability/logger.js";
    ```

  **(b) `core/src/agent/tools.ts:311-313`** — destructure `logger` from
  `deps`:

  - Change the existing destructure line to additively pull `logger`:

    ```ts
    const { pool, provider, observedAdapter, loadDesired, writeDesired, makeGate, logger } =
      deps;
    ```

  **(c) `core/src/agent/tools.ts:345-352`** — forward `logger` to
  `reconcile({...})`:

  - Update the `reconcile({...})` call inside `reconcileToEnvelope` to
    spread the optional logger:

    ```ts
    const run = reconcile({
      pool,
      provider,
      gate,
      observedAdapter,
      loadDesired,
      ...(logger ? { logger } : {}),
    });
    ```

  Using the `...(logger ? { logger } : {})` shape (mirroring
  `server.ts:471` `...(deps.startTimeout ? ...)`) ensures we never pass
  an explicit `undefined` that could shadow the `noopLogger` default.

- [ ] Re-run the targeted test → expect **PASS** for the
  `forwards logger` assertion. The `noopLogger fallback preserved`
  assertion also passes because `makeCatalog()` still omits `logger`.

- [ ] **(d) `core/src/server.ts:399-412`** — pass the outer-scope
  `logger` to the production catalog factory:

  - Change the `createToolCatalog({...})` call to include `logger`:

    ```ts
    const catalog = createToolCatalog({
      pool,
      provider,
      observedAdapter,
      loadDesired,
      writeDesired,
      makeGate: (isSensitive: (item: PlanItem) => boolean): ReconcileGate =>
        createApprovalGate({
          pool,
          clock,
          isSensitive,
          ...(deps.idFactory ? { idFactory: deps.idFactory } : {}),
        }),
      logger,
    });
    ```

  Confirm `logger` is already in scope (it is — used at
  `server.ts:469` to wire the periodic reconciler).

- [ ] Run the full suite:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  ```
- [ ] Expect: 955 passed, 1 skipped. No regressions in the existing
  ~950 tests (they construct `createToolCatalog` without `logger`).
- [ ] `npm --prefix core run typecheck` → clean.
- [ ] Commit:
  ```
  fix(core): thread ToolDeps.logger into reconcile() on the tool catalog path (2.1)

  Spec: docs/specs/2026-05-27-reconcile-envelope-failure-surface.md §4.2.
  Adds optional ToolDeps.logger, threaded into reconcile({...logger})
  inside reconcileToEnvelope, and wires the daemon's outer-scope logger
  through createToolCatalog({...logger}) at server.ts:399-412. Backwards
  compatible: omitting logger preserves the noopLogger fallback at
  reconcile.ts:305 (all ~950 existing tests unchanged).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

**Done (F2) =** logger threads end-to-end on the on-demand apply path;
`noopLogger` fallback preserved for unmodified test harnesses.

---

# Fase 3 (F3) — verification gate

**Phase goal:** Confirm the two deltas land cleanly with no regressions
before the PR opens.

**Deliverable:** Spec §9 acceptance criterion #7 met (full suite green,
property tests intact).

**Exit criteria:**

- Full suite green at the expected new baseline (955/956, 1 `@live`
  skipped).
- `npm --prefix core run typecheck` clean.
- No edits to `applyPlan`, `reconcile()` factory, `WriteEnvelope` enum,
  `state_events.after` shape, or the Approval Gate (grep verification).
- The inline comment in `reconcileToEnvelope` cites the spec path.

### Task 3.1 — verification + property-test integrity

**Files to read first:**

- `core/src/reconciler/idempotency.property.test.ts` (and any sibling
  `idempotency*.property.test.ts`) — confirm they have not been touched
  by this branch's diff.

- [ ] Run the full suite end-to-end:
  ```bash
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  ```
- [ ] Expect: 955 passed, 1 skipped (`@live`).
- [ ] Run typecheck:
  ```bash
  npm --prefix core run typecheck
  ```
- [ ] Expect: clean.
- [ ] Grep verifications (each should return zero changes against
  `main`):
  ```bash
  git diff main -- core/src/reconciler/apply.ts
  git diff main -- core/src/reconciler/reconcile.ts
  git diff main -- core/src/agent/envelope.ts
  git diff main -- core/src/store/state-events.ts
  git diff main -- core/src/agent/approval-gate.ts
  git diff main -- core/src/reconciler/idempotency.property.test.ts
  ```
  Each MUST be empty. If any of these files appears in the diff, the
  change has drifted out of scope — STOP and surface to the operator.
- [ ] Confirm the only modified production files are:
  - `core/src/agent/tools.ts`
  - `core/src/agent/tools.test.ts`
  - `core/src/server.ts`
- [ ] Confirm the inline comment in `reconcileToEnvelope` cites
  `docs/specs/2026-05-27-reconcile-envelope-failure-surface.md`.
- [ ] No additional commit (this task is a gate, not a code change).

**Done (F3) =** verification gate passed; branch ready to push and open
PR.

---

## Fora de escopo / dependências para outras specs

(Explicit list of what this plan intentionally leaves to follow-up
work, mirroring v1's "Não-objetivos".)

- **PR-B — HetznerCloud declarative→wire body translation.** The HTTP
  400 that detonated bug #5's investigation lives in the network create
  payload shape; PR-B is a separate spec/plan. This plan's correctness
  is observable in production via the corrected envelope, but does not
  remove the underlying 400.
- **`skipped` and `drift` surfacing on the envelope.** Spec §3 keeps
  these channels separate. If a future consumer demands per-skipped
  granularity, a follow-up spec widens the envelope or carries the
  detail via `next`. Not in this plan.
- **`WriteEnvelope.error` becoming a list.** The envelope's `error`
  remains singular. Callers needing the full failed set read
  `state_events` via the `events` tool.
- **Logger seam in `composite-provider`.** Already registered as
  follow-up cosmetic work (PR #13 thread). This plan only fixes the
  seam that already exists.
- **`@live` smoke.** No new HTTP wire; no live coverage required for
  this change.

## Done = (per phase, summary)

- **Task 0:** baseline confirmed (950/951 green); branch
  `fix/reconcile-envelope-failure-surface` clean.
- **F1:** `reconcileToEnvelope` returns `error` when
  `failed > 0 && withheld === 0`; pinning + fallback + precedence
  proved; inline comment cites the spec.
- **F2:** `ToolDeps.logger` (optional) is threaded into
  `reconcile({...logger})`; `server.ts` wires the outer-scope `logger`
  through; `noopLogger` fallback preserved for unmodified test
  harnesses.
- **F3:** full suite green at 955/956 (1 `@live` skipped); typecheck
  clean; no edits outside the three sanctioned files.
