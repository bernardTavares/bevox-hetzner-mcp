# `apply_manifest` desired-state silo fan-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL:
> `superpowers:subagent-driven-development`. ~6 TDD-sized tasks across 3
> phases. Spec aceita 2026-05-26.

**Goal:** Make `apply_manifest` (apply path) fan-out the manifest into
per-scope desired-state entries and partition the resulting observed-state
into per-kind rows, so that downstream consumers (`provision_server`,
`get_state(scope=server)`, periodic drift sweep) see what `apply_manifest`
declared. Also anchor a regression sentinel for
`apply_manifest({dry_run:true}) → {status:"planned"}`. dry_run path stays
untouched.

**Architecture:** Two surgical changes + one regression sentinel:
- **Mudança 1 (write-side fan-out)** — `doApplyManifest` apply branch in
  `core/src/agent/tools.ts:594-615` decomposes the validated manifest and
  issues `writeDesired(<kind>, slice)` per declared slice (alphabetical:
  `backup`, `dns`, `network`, `server`, `service`, `volume`). The silo
  `writeDesired("manifest", manifest)` is removed. Slices absent from the
  manifest are NOT written (fail-safe: ausência ≠ apagar).
- **Mudança 2 (reconcile observed partitioning, Opção A3)** — `reconcile()`
  in `core/src/reconciler/reconcile.ts` keeps
  `reconcileToEnvelope("manifest", ...)` but, when `scope === "manifest"`,
  partitions the State produced by `observedAdapter(slice)` per-kind and
  calls `putObservedState(pool, <kind>, slice_<kind>)` for each kind
  present, instead of the single `putObservedState(pool, "manifest", ...)`.
- **Mudança 3 (regression sentinel)** — explicit unit test pinning the
  shape `apply_manifest({dry_run:true}) ⇒ {status:"planned", plan:[...]}`.
  The code path appears correct today; the test anchors it.

**Tech Stack:** Inherits v1 — Node 20+, TS 5 strict ESM/NodeNext, Zod,
Pino, Vitest + fakes. Zero new deps. Zero new files in `core/src/`. No
new MCP tool, no new wire field, no new env knob.

**Specs:**
- Spec-filha: `docs/specs/2026-05-26-apply-manifest-silo-fanout.md`
  (Aceita 2026-05-26)
- Spec-mãe (v1): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Spec irmãs:
  - `docs/specs/2026-05-26-apply-manifest-meta-scope.md` (PR #12)
  - `docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md`
    (PR #13)
  - `docs/specs/2026-05-26-server-scope-transport-decoupling.md` (PR #11)
- Plan irmã (estilo de referência):
  `docs/superpowers/plans/2026-05-26-tolerant-meta-scope-and-managed-services.md`

---

## How this plan is executed

Branch `fix/apply-manifest-silo-fanout` is already cut from `main`
post-PR #13 (controller-managed; do NOT create another). Each task lands
as a single conventional-commits commit, TDD strict (red → minimal green
→ commit). Subagent execution: each task is self-contained — assume the
subagent does NOT have access to this conversation. The "Files to read
first" and snippet blocks per task are the whole context the subagent
needs.

Phase order:
- **Task 0** verifies baseline (no commit).
- **F1** lands Mudança 1 (write-side fan-out) + Mudança 3 (regression
  sentinel) — both touch `tools.ts` / `tools.test.ts`.
- **F2** lands Mudança 2 (reconcile observed partitioning) — touches
  `reconcile.ts` / `reconcile.test.ts`.
- **F3** lands the REST integration test that ties the two changes
  together (`rest.test.ts`).

No documentation phase: the spec is internal-bug-fix; user-facing
contract is unchanged. The inline code comment in `doApplyManifest`
(F1.1) is the only artifact citing the spec.

### Working agreement (all tasks)

- TDD, always: red → green → commit. Reference
  @superpowers:test-driven-development.
- DRY / YAGNI / minimal change. Reference
  @superpowers:minimal-change-engineer.
- One task = one commit. Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- @superpowers:verification-before-completion before any "done" claim.
- Tests never touch real infra (fakes from `core/test/fakes/`; no
  `@live`).
- No silent drift correction; no destructive rollback (`.claude/rules/fail-safe.md`).
- Steps use `- [ ]` checkboxes. Check them as you go.
- Run command for the local Postgres fake harness:
  ```
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test -- <path>
  ```

---

## Non-negotiable principles (per spec §5)

| # | Invariant | Guard in this plan |
|---|---|---|
| 1 | Specs first | Spec aceita precedes code; every commit cites task index from this plan. |
| 2 | Idempotência | `writeDesired(scope, slice)` is overwrite per-scope (same `Map.set` contract); existing idempotency property tests untouched. |
| 3 | Fail-safe, never fail-deleting | Fan-out ONLY adds Map entries; slices absent from manifest do NOT delete pre-existing per-scope entries. Operator wanting to drain a slice declares it explicitly as `[]`. |
| 4 | Secrets at apply only | Fan-out is pure DesiredState (`secret:<ref>` stays as string). No `resolveSecret`, no logger emits resolved values. |
| 5 | StateEvent actor | `reconcileToEnvelope` continues to thread actor through reconcile; partitioned `putObservedState` writes do NOT emit StateEvents (observed-store is row-replace; the existing `StateEvent` written by reconcile's Record phase is unchanged). |

---

## Anti-patterns (explicit DO-NOTs)

- Do NOT refactor the `writeDesired(scope, desired)` signature. It
  stays exactly as in `core/src/entrypoint-wiring.ts:221-226` and the
  test harness in `core/src/agent/tools.test.ts:190-192`.
- Do NOT create a new seam (no new `loadDesiredByKind`, no
  `partitionedWriteDesired` helper exported from a new module). The
  existing seams are sufficient.
- Do NOT add a new MCP tool. Tool surface is frozen.
- Do NOT touch the `dry_run` branch in `doApplyManifest` other than the
  regression assertion test (Task 1.2).
- Do NOT introduce a feature flag / env knob to opt into the old
  silo behavior. This is a bug fix, not an opt-in.
- Do NOT migrate or delete legacy `observed_state` rows with
  `scope='manifest'` from Postgres. Spec §7 leaves them as inert
  residue; no caller per-scope reads them.

---

## Testing strategy (per spec §6)

| Layer | Where | What it covers |
|---|---|---|
| Unit | `core/src/agent/tools.test.ts` | F1.1 fan-out write per slice; F1.2 dry_run regression sentinel. |
| Unit | `core/src/reconciler/reconcile.test.ts` | F2.1 per-kind partitioning of `putObservedState` when `scope === "manifest"`. |
| Integration | `core/src/agent/rest.test.ts` | F3.1 POST /api/apply (manifest multi-kind) ⇒ GET /api/state?scope=server reflects servers. |
| Property | (existing) `core/src/reconciler/idempotency*.property.test.ts` | UNCHANGED. No relaxation. |
| Live | n/a | Not required — no provider/wire change. |

All test files use fakes from `core/test/fakes/` and the disposable
Postgres on port 5546 documented in CONTRIBUTING §"First-time setup".

---

## File structure (one responsibility per file)

```
core/src/agent/tools.ts                          MODIFIED: doApplyManifest apply branch fan-out (F1.1)
core/src/agent/tools.test.ts                     MODIFIED: fan-out test (F1.1), dry_run sentinel (F1.2)
core/src/reconciler/reconcile.ts                 MODIFIED: per-kind partition when scope==="manifest" (F2.1)
core/src/reconciler/reconcile.test.ts            MODIFIED: partition test (F2.1)
core/src/agent/rest.test.ts                      MODIFIED: end-to-end /api/apply → /api/state assertion (F3.1)
```

No new files in `core/src/`. No edits outside the five files above.

---

# Task 0 — Branch + baseline (BLOCKING GATE)

**Goal/deliverable:** Confirm baseline test count + branch correctness.
No code change, no commit.

**Exit criteria:** Test suite green at baseline (941/942 with 1 @live
skipped); branch is `fix/apply-manifest-silo-fanout`.

### Task 0.1 — Verify baseline

- Files: none (no edit).
- [ ] Confirm `git rev-parse --abbrev-ref HEAD` returns
      `fix/apply-manifest-silo-fanout`. If not, stop and report.
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test
      ```
      → expect **941 passed / 1 skipped (@live)** out of 942 total.
      If the count differs by more than the skipped live test, stop and
      report (baseline drift outside this plan's scope).
- [ ] Run `npm --prefix core run typecheck` → expect clean (zero
      errors).
- [ ] No commit. Proceed to F1.

**Done (Task 0) =** baseline green, on the right branch, typecheck
clean.

---

# Fase 1 (F1) — Mudança 1 (write-side fan-out) + Mudança 3 (regression sentinel)

**Phase goal:** `doApplyManifest` apply branch decomposes the manifest
into per-kind `writeDesired` calls; dry_run branch stays exact; tests
anchor both behaviors.
**Deliverable:** 2 commits on top of Task 0 baseline.
**Exit criteria:** new fan-out test + dry_run sentinel green; legacy
tests (`apply_manifest via production composite + scope=manifest →
applied (meta-scope)`, etc.) still green; typecheck clean.

### Task 1.1 — Write-side fan-out in `doApplyManifest` apply path

- Files: `core/src/agent/tools.ts`,
  `core/src/agent/tools.test.ts`.
- [ ] Familiarise (read first):
  - `core/src/agent/tools.ts:594-615` — current `doApplyManifest`.
  - `core/src/agent/tools.test.ts:140-200` — `makeCatalog` harness and
    the `desiredByScope` Map captured by `loadDesired`/`writeDesired`.
  - `core/src/domain/desired-state.ts:116-127` — `DesiredStateSchema`
    confirms the 6 slices: `servers`, `networks`, `volumes`,
    `services`, `dns`, `backups`.
  - `docs/specs/2026-05-26-apply-manifest-silo-fanout.md` §4.1 (table
    of slice→scope mapping).
- [ ] Failing test — append to the existing
      `describe("conditional tools (deploy_service / apply_manifest / scale_service)", ...)`
      block in `core/src/agent/tools.test.ts` (near the existing
      "meta-scope" regression around line 985):
      ```ts
      // Regression: spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.1.
      // doApplyManifest (apply path) MUST fan-out the manifest into per-scope
      // desired entries. The "manifest" silo entry MUST NOT exist after.
      it("apply_manifest (apply path) writes desired per-scope, NOT under 'manifest'", async () => {
        const desiredByScope = new Map<string, DesiredState>();
        const cat = makeCatalog({ desiredByScope });
        const res = await cat.executeTool(
          "apply_manifest",
          {
            manifest: {
              networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
              servers: [
                {
                  name: "app-1",
                  type: "cx22",
                  location: "nbg1",
                  network: "net-a",
                  image: "ubuntu-24.04",
                },
              ],
            },
            dry_run: false,
          },
          ctx(fullCred(), "manifest"),
        );
        expect(["applied", "pending_approval"]).toContain(res.status);
        // Fan-out: per-kind entries populated.
        expect(desiredByScope.get("network")).toEqual({
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        });
        expect(desiredByScope.get("server")).toEqual({
          servers: [
            {
              name: "app-1",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
              image: "ubuntu-24.04",
            },
          ],
        });
        // Slices NOT present in the manifest are NOT written.
        expect(desiredByScope.has("volume")).toBe(false);
        expect(desiredByScope.has("service")).toBe(false);
        expect(desiredByScope.has("dns")).toBe(false);
        expect(desiredByScope.has("backup")).toBe(false);
        // Silo entry MUST NOT exist (the bug we are fixing).
        expect(desiredByScope.has("manifest")).toBe(false);
      });

      // Fail-safe: ausência ≠ apagar. A manifest declaring only `servers`
      // does NOT clobber a pre-existing `network` slice that the operator
      // declared earlier via apply_manifest.
      it("apply_manifest (apply path) does NOT clobber unrelated pre-existing per-scope slices", async () => {
        const desiredByScope = new Map<string, DesiredState>();
        desiredByScope.set("network", {
          networks: [{ name: "pre-existing", ip_range: "10.9.0.0/16" }],
        });
        const cat = makeCatalog({ desiredByScope });
        await cat.executeTool(
          "apply_manifest",
          {
            manifest: {
              servers: [
                {
                  name: "app-2",
                  type: "cx22",
                  location: "nbg1",
                  network: "pre-existing",
                  image: "ubuntu-24.04",
                },
              ],
            },
            dry_run: false,
          },
          ctx(fullCred(), "manifest"),
        );
        // Server slice populated.
        expect(desiredByScope.get("server")?.servers?.[0]?.name).toBe("app-2");
        // Pre-existing network slice INTACT (ausência ≠ apagar).
        expect(desiredByScope.get("network")).toEqual({
          networks: [{ name: "pre-existing", ip_range: "10.9.0.0/16" }],
        });
      });
      ```
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- core/src/agent/tools.test.ts
      ```
      → expect **FAIL** on the two new tests (`desiredByScope.get("network")`
      will be `undefined`, `desiredByScope.has("manifest")` will be `true`).
- [ ] Minimal impl — in `core/src/agent/tools.ts:613` replace the line
      `await writeDesired(scope, manifest);` with a per-slice fan-out.
      Order: alphabetical by target scope name for determinism. Pseudocode
      (the executor writes the code; preserve existing comment style and
      cite the spec inline):
      ```ts
      // FAN-OUT (spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.1):
      // Decompose the manifest into per-scope desired-state entries so that
      // per-kind callers (loadDesired("server"), get_state, periodic drift
      // sweep) observe what apply_manifest declared. Slices absent from the
      // manifest are NOT written — ausência ≠ apagar (fail-safe §5 #3).
      if (manifest.backups)  await writeDesired("backup",  { backups:  manifest.backups });
      if (manifest.dns)      await writeDesired("dns",     { dns:      manifest.dns });
      if (manifest.networks) await writeDesired("network", { networks: manifest.networks });
      if (manifest.servers)  await writeDesired("server",  { servers:  manifest.servers });
      if (manifest.services) await writeDesired("service", { services: manifest.services });
      if (manifest.volumes)  await writeDesired("volume",  { volumes:  manifest.volumes });
      ```
      The `reconcileToEnvelope(scope, actor, defaultIsSensitive)` line
      below stays unchanged (the synthetic `scope` is still `"manifest"`).
- [ ] Run the same test command → expect **PASS** on the two new tests
      and on every pre-existing `apply_manifest*` test in the file
      (including the meta-scope regression at line 985 — it asserts
      `res.status` shape, which is unchanged).
- [ ] Run `npm --prefix core run typecheck` → expect clean.
- [ ] Commit:
      `fix(core): apply_manifest fans out desired per-scope, no silo (1.1)`

### Task 1.2 — Regression sentinel: `apply_manifest({dry_run:true}) → "planned"`

- Files: `core/src/agent/tools.test.ts` (only).
- [ ] Familiarise (read first):
  - `core/src/agent/tools.ts:594-611` — `doApplyManifest` dry_run branch
    (returns `planned(plan(manifest, observed))`).
  - `docs/specs/2026-05-26-apply-manifest-silo-fanout.md` §1.4 (anomaly
    context) + §9 (acceptance criterion #2).
  - `core/src/agent/tools.test.ts:703-740` — the existing
    `describe("apply_manifest dry_run", ...)` block (read both for tone
    and to confirm no duplicate). The new test will be appended here.
- [ ] Failing test — append to
      `describe("apply_manifest dry_run", ...)`:
      ```ts
      // Regression sentinel (spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md
      // §1.4 + §9 #2): the consumer reported receiving {status:"applied"}
      // for a dry_run call. Code review showed the current path returns
      // planned(...) before any reconcile, but no test pinned the shape.
      // This anchors it — and also asserts ZERO desired-store writes occur
      // on dry_run (no silo, no fan-out — the dry_run path is pure).
      it("apply_manifest({dry_run:true}) returns {status:'planned'} and writes NO desired-state", async () => {
        const desiredByScope = new Map<string, DesiredState>();
        const cat = makeCatalog({ desiredByScope });
        const res = await cat.executeTool(
          "apply_manifest",
          {
            manifest: {
              networks: [{ name: "net-dry", ip_range: "10.7.0.0/16" }],
              servers: [
                {
                  name: "dry-app",
                  type: "cx22",
                  location: "nbg1",
                  network: "net-dry",
                  image: "ubuntu-24.04",
                },
              ],
            },
            dry_run: true,
          },
          ctx(fullCred(), "manifest"),
        );
        expect(res.status).toBe("planned");
        // Shape: planned envelope carries a plan array.
        const e = env(res);
        expect(Array.isArray(e.plan)).toBe(true);
        // Pure dry_run: no desired-state write under ANY scope.
        expect(desiredByScope.size).toBe(0);
      });
      ```
      Note: `env(res)` and `planned` shape — match the helper already
      used in the same file (e.g. tools.test.ts:1014 uses
      `const e = env(res)`). If the helper signature differs, conform
      to the local convention without renaming.
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- core/src/agent/tools.test.ts
      ```
      → expect **PASS** immediately (the current code path is already
      correct per §1.4). The test is a sentinel — no production code
      change needed. NOTE: this is the documented exception to "red
      first" — per CONTRIBUTING.md "Definition of failing test for the
      right reason" and the spec §1.4 acceptance criterion #2, the test
      anchors an existing-but-untested invariant; mark this in the
      commit message body.
- [ ] Run `npm --prefix core run typecheck` → expect clean.
- [ ] Commit:
      `test(core): pin apply_manifest dry_run → planned regression sentinel (1.2)`

**Done (F1) =** apply path fans out per-scope; dry_run shape pinned by
test; entire `tools.test.ts` suite green; typecheck clean.

---

# Fase 2 (F2) — Mudança 2 (reconcile observed partitioning, Opção A3)

**Phase goal:** When `reconcile()` runs with `scope === "manifest"`, the
observed snapshot is written to `observed_state` per-kind rows (one
`putState` call per non-empty kind present), instead of one row keyed by
`"manifest"`.
**Deliverable:** 1 commit on top of F1.
**Exit criteria:** new partition test green; legacy reconcile tests
green; idempotency property tests untouched.

### Task 2.1 — Partition observed per-kind when `scope === "manifest"`

- Files: `core/src/reconciler/reconcile.ts`,
  `core/src/reconciler/reconcile.test.ts`.
- [ ] Familiarise (read first):
  - `core/src/reconciler/reconcile.ts:301-395` — main `reconcile()`
    builder; the OBSERVE phase calls
    `await putObservedState(pool, scope, observed)` at line 390.
  - `core/src/reconciler/reconcile.ts:769-820` — `runDriftSweep`
    parallel OBSERVE block (line 794 mirrors the apply-path write).
    **This task ONLY changes the on-demand `reconcile()` builder
    (line 301-395 region).** The drift sweep is invoked per-native-scope
    by the periodic timer (`entrypoint-wiring.ts:239-242` filters
    scopes), so it never visits `"manifest"` in production. Out of
    scope for this task — leave line 794 untouched.
  - `core/src/store/observed-store.ts` — `putState(pool, scope, state)`
    is the only API used; it's full-replace per scope (do NOT
    refactor).
  - `core/src/reconciler/composite-provider.ts:152-223` — composite
    `observe("manifest")` already returns a union slice rotulado por
    kind (`server:<name>`, `network:<name>`, …). The `observedAdapter`
    injected in `ReconcileDeps` (e.g.
    `core/src/agent/tools.test.ts:146-169`) regroups those entity keys
    into the 6 `State` collections. **Partitioning happens AFTER the
    adapter runs — at the `State` level, by `State` field — not at the
    entity-string level.**
  - `core/src/domain/entities.ts` — `State` type carries the 6 fields
    we will partition into (servers, networks, volumes, services, dns,
    backups). The shape mirrors `DesiredStateSchema` from F1.1.
  - `docs/specs/2026-05-26-apply-manifest-silo-fanout.md` §4.2 (Opção
    A3 — the recommended design).
- [ ] Failing test — append to
      `core/src/reconciler/reconcile.test.ts` a new describe block.
      The test needs a `putObservedState` spy/observer. Two reasonable
      shapes:
      1. Use a real fake pool from `core/test/fakes/pg-harness.ts` and
         then query `observed_state` for rows keyed by each scope.
      2. Wrap the pool with a thin recording proxy that captures the
         SQL parameters and asserts the scope value(s) on each upsert.
      The plan recommends shape **1** — consistent with the rest of
      `reconcile.test.ts`. Snippet:
      ```ts
      // Spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.2 (A3):
      // when reconcile() runs with scope="manifest", observed_state rows
      // must be written under each native kind (server/network/…) — NOT
      // under the synthetic "manifest" scope.
      describe("reconcile: scope='manifest' partitions observed per-kind (A3)", () => {
        it("writes observed_state rows under native kinds, not under 'manifest'", async () => {
          // Build a composite-like provider that reports a manifest union
          // slice: one server + one network entity. The observedAdapter
          // regroups them into State.servers / State.networks.
          const provider: Provider = {
            name: "fake-manifest-union",
            async observe(scope) {
              expect(scope).toBe("manifest");
              return {
                scope: "manifest",
                entities: ["server:app-1", "network:net-a"],
              };
            },
            async apply() { return { entity: "", op: "noop", changed: false }; },
            async verify() { return true; },
          };
          // Mirror the production adapter pattern (tools.test.ts:146-169).
          const adapter = (slice: ObservedSlice): State => ({
            servers: slice.entities
              .filter((k) => k.startsWith("server:"))
              .map((k) => ({
                name: k.slice("server:".length),
                type: "cx22",
                location: "nbg1",
                network: "net-a",
                image: "ubuntu-24.04",
                status: "healthy" as const,
              })),
            networks: slice.entities
              .filter((k) => k.startsWith("network:"))
              .map((k) => ({ name: k.slice("network:".length), ip_range: "10.0.0.0/16" })),
            volumes: [], services: [], dns: [], backups: [],
          });

          const run = reconcile({
            pool, provider, gate: passThroughGate(), observedAdapter: adapter,
            loadDesired: async () => ({}),
          });
          const result = await run({ scope: "manifest", actor: "agent:test" });
          expect(result).toBeDefined();

          // Native-kind rows present.
          const serverRows = await pool.query(
            "SELECT entity FROM observed_state WHERE scope = $1",
            ["server"],
          );
          expect(serverRows.rows.map((r) => r.entity)).toContain("app-1");
          const networkRows = await pool.query(
            "SELECT entity FROM observed_state WHERE scope = $1",
            ["network"],
          );
          expect(networkRows.rows.map((r) => r.entity)).toContain("net-a");

          // The synthetic "manifest" scope row MUST NOT be written.
          const manifestRows = await pool.query(
            "SELECT entity FROM observed_state WHERE scope = $1",
            ["manifest"],
          );
          expect(manifestRows.rows).toHaveLength(0);
        });
      });
      ```
      Reuse the existing test-suite imports (`pool`, `passThroughGate`,
      `reconcile`, `ObservedSlice`, `Provider`, `State`); copy whatever
      `describe` block already at the top of the file uses for setup
      (e.g. `beforeEach(() => resetSchema(pool))`).
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- core/src/reconciler/reconcile.test.ts
      ```
      → expect **FAIL** with `manifestRows.rows` having length 1 and
      `serverRows` / `networkRows` having length 0.
- [ ] Minimal impl — in `core/src/reconciler/reconcile.ts` around
      line 388-394 (the OBSERVE phase `putObservedState` call), branch
      on `scope === "manifest"`:
      ```ts
      // SPEC docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.2 (A3):
      // when reconcile runs for the synthetic meta-scope "manifest",
      // partition the State produced by the adapter into per-kind rows so
      // that get_state(scope=<kind>) and the periodic drift sweep see the
      // entities apply_manifest declared. The synthetic "manifest" scope
      // is NOT a valid observed_state.scope value going forward — its
      // rows are silently never written.
      if (scope === "manifest") {
        // Empty collections still call putState — that lets the full-replace
        // semantics drain rows from a prior cycle where the manifest had
        // entities of that kind and now does not (still fail-safe: a row in
        // observed_state is a *snapshot of reality*; ausência reflects reality).
        await putObservedState(pool, "server",  { ...EMPTY_STATE, servers:  observed.servers  });
        await putObservedState(pool, "network", { ...EMPTY_STATE, networks: observed.networks });
        await putObservedState(pool, "volume",  { ...EMPTY_STATE, volumes:  observed.volumes  });
        await putObservedState(pool, "service", { ...EMPTY_STATE, services: observed.services });
        await putObservedState(pool, "dns",     { ...EMPTY_STATE, dns:      observed.dns      });
        await putObservedState(pool, "backup",  { ...EMPTY_STATE, backups:  observed.backups  });
      } else {
        await putObservedState(pool, scope, observed);
      }
      ```
      `EMPTY_STATE` is the zero-value State helper already used in the
      file (or define inline as
      `{ servers: [], networks: [], volumes: [], services: [], dns: [], backups: [] }`
      — match the local convention; do not export a new helper).
      **Caveat on shrinkage detection (lines 391-394).** The existing
      `detectObservedShrinkage(previousObserved, observed)` call
      compares prior vs new snapshot for THIS scope. Under the new
      partition branch, the comparison still uses the union `observed`
      State and the union `previousObserved` State read at line 377
      from `scope="manifest"` — which is now consistently `EMPTY` (we
      stopped writing that row). The detector returns `[]` for the
      manifest scope. That's the desired outcome: shrinkage per-kind is
      detected by the periodic drift sweep on the native scopes (where
      it already runs), not synthetically across the meta-scope. Leave
      `detectObservedShrinkage` unchanged.
- [ ] Run the same test command → expect **PASS** on the new test AND
      every existing `reconcile.test.ts` test.
- [ ] Run the full suite to ensure no collateral damage:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test
      ```
      → expect 944/945 green (1 @live skipped), i.e. baseline + 3 new
      tests from F1.1+F1.2 + 1 from F2.1.
- [ ] Run `npm --prefix core run typecheck` → expect clean.
- [ ] Commit:
      `fix(core): reconcile partitions observed_state per-kind on scope=manifest (2.1)`

**Done (F2) =** observed-state rows for a manifest reconcile land under
native kinds; `get_state(scope=server)` returns the apply_manifest'd
servers; idempotency property tests untouched.

---

# Fase 3 (F3) — REST integration capstone

**Phase goal:** Pin the end-to-end behavior at the REST layer: a single
POST to `/api/apply` with a multi-kind manifest, followed by
`GET /api/state?scope=server`, must reflect the servers. This is the
exact `bevox-meta-api` caminho A described in spec §1.3.
**Deliverable:** 1 commit on top of F2.
**Exit criteria:** new REST integration test green; entire suite green.

### Task 2.2 — Cross-scope read union + write strip-to-own in entrypoint-wiring

> Added in spec revision 2026-05-26-b (§4.5). Closes the gap exposed by Task 3.1
> capstone: cross-scope reference validation in `plan()` was failing after fan-out
> because `loadDesired("server")` returned only `{servers}` without `networks`.

- Files: `core/src/entrypoint-wiring.ts`,
  `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise (read first):
  - `core/src/entrypoint-wiring.ts:213-226` — current `loadDesired` /
    `writeDesired` (in-process Map seam).
  - `core/src/domain/desired-state.ts:116-127` — `DesiredStateSchema`
    (the 6 slices that map 1:1 to scope ownership).
  - `core/src/reconciler/plan.ts:208-224` — the cross-reference validation
    that throws `precondition: "X" references "Y" which is not declared`
    (this is what we're unblocking).
  - `docs/specs/2026-05-26-apply-manifest-silo-fanout.md` §4.5 — design
    (slice-to-scope-to-deps table + pseudocode).
- [ ] Failing tests — append to
      `core/src/entrypoint-wiring.test.ts`. Two new tests:

      ```ts
      // Spec §4.5: loadDesired("server") returns own slice + network upstream.
      it("loadDesired performs cross-scope union for scopes with upstream deps", async () => {
        const deps = await buildBootDeps(/* same config the file already uses */);
        await deps.writeDesired("network", {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        });
        await deps.writeDesired("server", {
          servers: [
            { name: "app-1", type: "cx22", location: "nbg1",
              network: "net-a", image: "ubuntu-24.04" },
          ],
        });
        const merged = await deps.loadDesired("server");
        // own slice present
        expect(merged.servers?.[0]?.name).toBe("app-1");
        // upstream dep merged in (the fix)
        expect(merged.networks?.[0]?.name).toBe("net-a");
      });

      // Spec §4.5: writeDesired strips to own-slice. Calling
      // writeDesired("server", { servers, networks }) persists ONLY
      // servers; networks remain in scope=network silo.
      it("writeDesired persists only the scope's own slice (strip-to-own)", async () => {
        const deps = await buildBootDeps(/* same config */);
        await deps.writeDesired("network", {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        });
        // Simulate provision_server's mergeDesired writing back a union.
        await deps.writeDesired("server", {
          servers: [
            { name: "app-1", type: "cx22", location: "nbg1",
              network: "net-a", image: "ubuntu-24.04" },
          ],
          networks: [
            { name: "net-a", ip_range: "10.0.0.0/16" },
            { name: "WRONG-PLACE", ip_range: "10.99.0.0/16" }, // sentinel
          ],
        });
        // Cross-read: loadDesired("network") MUST NOT contain the sentinel
        // (strip kept only servers in the server silo; network silo intact).
        const networkView = await deps.loadDesired("network");
        expect(networkView.networks?.map((n) => n.name)).toEqual(["net-a"]);
        expect(networkView.networks?.map((n) => n.name)).not.toContain(
          "WRONG-PLACE",
        );
      });
      ```

      If `buildBootDeps` requires test env vars (Postgres URL, dummy
      tokens), reuse the convention already in
      `entrypoint-wiring.test.ts`. The point of these tests is the seam,
      not the boot pipeline — feel free to factor out a smaller harness
      that constructs just the loadDesired/writeDesired pair from the
      same factory function, if the existing test file's convention
      makes a full `buildBootDeps` call heavy. Keep the assertions
      identical; harness shape is flexible.
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- src/entrypoint-wiring.test.ts
      ```
      → expect **FAIL** on both new tests (current loadDesired returns
      own-scope only; current writeDesired persists everything).
- [ ] Minimal impl — in `core/src/entrypoint-wiring.ts:213-226` replace
      the simple Map seam with the slice/deps-aware variant from
      spec §4.5:

      ```ts
      const OWN_SLICE: Readonly<Record<string, keyof DesiredState>> = {
        backup: "backups",
        dns: "dns",
        network: "networks",
        server: "servers",
        service: "services",
        volume: "volumes",
      };
      const UPSTREAM_DEPS: Readonly<Record<string, readonly string[]>> = {
        server: ["network"],
        service: ["server", "network"],
        volume: ["server"],
      };
      const desiredByScope = new Map<string, DesiredState>();

      const loadDesired = async (scope: string): Promise<DesiredState> => {
        if (scope === "manifest") {
          // Synthetic meta-scope: union of every per-kind silo.
          // Mirrors the pre-fan-out "manifest" silo contents for
          // reconcile/dry_run loadDesired("manifest") callers.
          return Object.assign({}, ...desiredByScope.values());
        }
        const own = desiredByScope.get(scope) ?? {};
        const deps = UPSTREAM_DEPS[scope] ?? [];
        if (deps.length === 0) return own;
        // Cross-scope union: own slice + upstream deps (read-only context
        // so plan() validates server.network / volume.server etc.).
        const merged: DesiredState = { ...own };
        for (const dep of deps) {
          Object.assign(merged, desiredByScope.get(dep) ?? {});
        }
        return merged;
      };

      const writeDesired = async (
        scope: string, desired: DesiredState,
      ): Promise<void> => {
        const ownKey = OWN_SLICE[scope];
        if (ownKey === undefined) {
          // Defensive: unknown scope (e.g., legacy "manifest") — persist
          // as-is to avoid silent data loss. Not load-bearing post-fan-out.
          desiredByScope.set(scope, desired);
          return;
        }
        // Strip-to-own: persist ONLY the slice this scope owns. Cross-
        // scope deps that were unioned at read time are intentionally
        // discarded on write — they live in their own silo.
        const stripped: DesiredState =
          desired[ownKey] !== undefined
            ? ({ [ownKey]: desired[ownKey] } as DesiredState)
            : {};
        desiredByScope.set(scope, stripped);
      };
      ```

      Note the **`import type { DesiredState }`** is already present in
      the file (line 28-ish). No new imports needed.
- [ ] Run the test command above → expect **PASS**.
- [ ] Run the F1.1 test file too — the fan-out tests assert
      `desiredByScope.get("server")` equals exactly `{servers: [...]}`.
      With strip-to-own those assertions stay green (fan-out already
      writes the right slice; strip is idempotent on already-stripped
      input):
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- src/agent/tools.test.ts
      ```
- [ ] Full suite:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test
      ```
      → expect **947/948 green** (was 945/946 + 2 new tests). Zero
      regressions.
- [ ] Typecheck:
      ```
      npm --prefix core run typecheck
      ```
      → expect clean (modulo pre-existing out-of-scope errors).
- [ ] Commit:
      ```
      fix(core): cross-scope read union + write strip-to-own in desired seam (2.2)

      Closes the gap exposed by §4.5 of the spec revision (b): after the
      fan-out (§4.1), loadDesired("server") returned {servers} only and
      plan() lança precondition on server.network → network refs (network
      lived in a sibling silo). Now loadDesired unions own slice + upstream
      deps; writeDesired strips to own. plan() validates cross-scope refs
      naturally.

      Spec: docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.5
      Plan: docs/superpowers/plans/2026-05-26-apply-manifest-silo-fanout.md (Task 2.2)

      Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
      ```

**Done (F2.2) =** cross-scope union active; provision_server /
deploy_service / scale_service / diff(scope=server) / periodic reconcile
all see upstream deps for plan() validation. Capstone in Task 3.1 (which
was held off in the first pass) becomes green.

### Task 3.1 — REST integration: `/api/apply` → `/api/state?scope=server`

- Files: `core/src/agent/rest.test.ts` (only).
- [ ] Familiarise (read first):
  - `core/src/agent/rest.test.ts:602-660` — the existing `POST /api/apply`
    test blocks, including the meta-scope regression at line 627 (uses
    composite provider; the most similar shape to the new test).
  - `core/src/agent/rest.test.ts:418-440` — the `GET /api/state` test
    block confirms the route exists and how to call it.
  - `core/src/agent/rest.test.ts:320-365` — `observedAdapter` and the
    `reconcile(...)` wiring used by `makeRest` (or equivalent). Confirm
    which scope the GET endpoint queries against.
  - Spec §9 acceptance criterion #1: after a manifest apply,
    `getObservedState(pool, "server")` reflects the server(s).
- [ ] Failing test — append a new `it(...)` block near line 660:
      ```ts
      // Spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §9 #1:
      // end-to-end REST capstone. A multi-kind apply must populate
      // observed_state under each native kind so that GET /api/state?scope=server
      // returns the server(s) the manifest declared.
      it("POST /api/apply (multi-kind manifest) → GET /api/state?scope=server returns the servers", async () => {
        const rest = makeRest(/* same setup as the line-627 test */);
        const applyRes = await call(rest, {
          method: "POST",
          url: "/api/apply",
          payload: {
            manifest: {
              networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
              servers: [
                {
                  name: "app-1",
                  type: "cx22",
                  location: "nbg1",
                  network: "net-a",
                  image: "ubuntu-24.04",
                },
              ],
            },
            dry_run: false,
          },
        });
        expect(["applied", "pending_approval"]).toContain(applyRes.json().status);

        const stateRes = await call(rest, {
          method: "GET",
          url: "/api/state?scope=server",
        });
        expect(stateRes.statusCode).toBe(200);
        const body = stateRes.json();
        // Acceptance: the server declared in the manifest appears under scope=server.
        const serverNames = (body.state?.servers ?? body.servers ?? [])
          .map((s: { name: string }) => s.name);
        expect(serverNames).toContain("app-1");
      });
      ```
      Adjust `body.state?.servers ?? body.servers` to match whichever
      shape `/api/state` actually returns — confirm via reading line
      418-440 of the same file. Do not change the REST contract; only
      assert against whatever shape is already returned today.
- [ ] Run:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test -- core/src/agent/rest.test.ts
      ```
      → expect **PASS** (F1.1 + F2.1 already in place make this
      green). If it FAILS with `serverNames` empty, re-verify the
      composite provider used in `makeRest` correctly observes
      `server:<name>` for the manifest the test posted.
- [ ] Run the full suite:
      ```
      DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
        npm --prefix core test
      ```
      → expect 945/946 green (1 @live skipped) — baseline (941) + 4
      new tests (F1.1 two, F1.2 one, F2.1 one) + this F3.1 test = 946
      total, 945 passed.
- [ ] Run `npm --prefix core run typecheck` → expect clean.
- [ ] Commit:
      `test(core): REST capstone — apply_manifest then get_state(scope=server) sees the server (3.1)`

**Done (F3) =** end-to-end capstone green. The `bevox-meta-api` caminho A
is unblocked: same call sequence in production will succeed.

---

## Fora de escopo (intentional non-goals)

These are explicit non-objectives carried from spec §3:

- **Do NOT introduce a `set_network` standalone tool.** The spec
  preserves the owner's rule: Network is declared via `apply_manifest`
  only.
- **Do NOT change the `apply_manifest` wire shape or response
  envelope.** `WriteEnvelope` (`applied` / `pending_approval` /
  `planned` / `error`) stays byte-identical.
- **Do NOT migrate `desiredByScope` to a persistent store.** It stays
  an in-process `Map` (CLAUDE.md: durable persistence is the
  manifest-repo's concern).
- **Do NOT clean up legacy `observed_state` rows with
  `scope='manifest'`.** They're inert residue; spec §7 explicitly
  leaves them.
- **Do NOT change `observed_state` schema.** Only the scope value
  written changes; row shape, indexes, and constraints are untouched.
- **Do NOT propagate fan-out to the `dry_run` branch.** It already has
  no silo (no `writeDesired` call); spec §4.3.
- **Do NOT modify `runDriftSweep` (reconcile.ts:769-820).** The
  periodic timer in production filters scopes to native kinds
  (`entrypoint-wiring.ts:239-242`), so the sweep never receives
  `scope="manifest"`. Touching it here is YAGNI.

## Done = (per phase, summary)

- **Task 0:** baseline 941/942 verified; on branch
  `fix/apply-manifest-silo-fanout`; typecheck clean.
- **F1.1:** `doApplyManifest` apply branch fans out per-scope; 2 new
  tests in `tools.test.ts` green.
- **F1.2:** dry_run regression sentinel green; 1 new test in
  `tools.test.ts`.
- **F2.1:** `reconcile()` partitions observed per-kind on
  `scope === "manifest"`; 1 new test in `reconcile.test.ts`; legacy
  reconcile tests + idempotency property tests untouched.
- **F3.1:** REST integration capstone — `/api/apply` →
  `/api/state?scope=server` sees the server; 1 new test in
  `rest.test.ts`.
- **Final:** PR vs `main`, 945/946 green (1 @live skipped), typecheck
  clean, ready to merge + restart daemon.

## After all tasks

- `git log --oneline <baseline>..HEAD` shows 4 commits in order
  `1.1 → 1.2 → 2.1 → 3.1`.
- Open PR vs `main` from `fix/apply-manifest-silo-fanout`. After
  merge: rebuild + `sudo systemctl restart bevox-daemon.service`.
- `bevox-meta-api` caminho A retomes immediately; no action required
  on the consumer side (wire shape unchanged).

## Rollback

Trivial revert of the 4 commits restores the silo behavior (`Map`
in-process resets on daemon boot; no persisted state to migrate back).
No schema change, no wire contract change, no env knob to flip.
