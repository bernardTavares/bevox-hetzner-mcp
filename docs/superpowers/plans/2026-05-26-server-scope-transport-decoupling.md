# Server-scope transport decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Goal:** Land the additive A+B+E package from the accepted
spec-filha so that (1) every mutating tool honours `input.dry_run` as
strictly side-effect-free (zero live network), (2) v1 dry_run branches
read from the cached observed-store instead of `provider.observe()`,
(3) v2 write tools gate `provider.observe()` behind `!dryRun`, (4)
`doGatedOp` short-circuits before `gate.evaluate` in dry_run, and (5) a
`MANAGED_MESH` config knob (default `on`) decouples `routes.server`
from the WireGuard provider so k3s/CNI deploys can boot without SSH.
The default is fully backwards-compatible; the existing test suite
remains green without modification.

**Architecture:** Three orthogonal changes layered onto the existing
Agent Interface. Mudança E adds one Zod field on `ConfigSchema`
(`core/src/config.ts`) and conditionalises the `routes.server` array
in `buildBootDeps` (`core/src/entrypoint-wiring.ts`). Mudança A adds a
`dry_run` branch to each v1 mutating handler (`doProvisionServer`,
`doScaleService`, `doSetDns`, `doApplyManifest`, `doGatedOp`) in
`core/src/agent/tools.ts`. Mudança B replaces `provider.observe(scope)`
with `getState(pool, scope)` in every v1 dry_run branch and moves
`provider.observe(desired)` behind `if (!dryRun)` in each v2 write tool
under `core/src/agent/v2/`. No new file, no new dependency, no schema
migration, no wire-contract change. State Store, Reconciler, Providers,
StateEvent writer untouched.

**Tech Stack:** Inherits the ratified v1 + v2 Bloco A stack
unchanged — Node.js 20+, TypeScript 5.x ESM/NodeNext strict, Zod,
Pino, Vitest + in-memory fakes, PostgreSQL 16 via `pg`. **Zero new
dependencies, zero new files in `core/src/`.** All work is additive
edits to existing modules.

**Specs:**
- Spec-filha (this plan): `docs/specs/2026-05-26-server-scope-transport-decoupling.md`
- Spec-mãe v1 (FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Spec irmã v2 (FROZEN): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- Investigation: `docs/investigations/2026-05-26-provision-server-ssh-coupling.md`

---

## How this plan is executed

Six phases. Phase 0 sets up the branch and confirms baseline green.
Phase 1 (Mudança E) lands first because the default `on` is a strict
no-op for every existing test and unblocks the opt-out documentation
path. Phases 2–4 implement Mudanças A and B per the three sub-padrões
(§4.2.a v1 via `getState`, §4.2.b v2 via `observe` gated by `!dryRun`,
§4.2.c `doGatedOp` via skip-gate). Phase 5 documents the spec's Q4
("flip on→off reports drift, never deletes peers") with an integration
test even if the existing drift detector already covers it. Phase 6
updates the three operator-facing docs called out in spec §10.

Phases 1–4 are commit-orderable in any order (each commit lands green
in isolation), but the suggested execution order is E → A → B because A
without B leaves the dry_run branches calling live `observe()`, which
adds a regression window. B before A is a no-op for handlers that ignore
`dry_run`. Phase 5 depends on Phase 1 only. Phase 6 has no code
dependency.

`Task 0` is the blocking foundation: branch + baseline. F1..F6 may
begin once Task 0 is green.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail (red) →
  minimal implementation → run, see it pass (green) → commit.
  Reference @superpowers:test-driven-development.
- **DRY / YAGNI / minimal change**: build only what the phase needs. No
  speculative abstraction beyond what is already in the spec. Reference
  @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Commit message trailer
  mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: every change is covered by fakes in
  `core/test/fakes/`; the v2 dry_run sentinel — a fake provider whose
  `observe()` throws — must remain a passing regression guard.
- **No silent drift correction**: spec invariant I3 — the `on → off`
  flip of `MANAGED_MESH` reports peers as drift, never deletes them.
- **No `StateEvent` writer changes**: spec invariant I5 — actors,
  payload shapes, and the `state_events` columns are untouched.
- **No secret resolution surface added**: spec invariant I4 — Mudança B
  *reduces* leak surface (no SSH spawn in dry_run); every new test for
  Mudança B includes an explicit assertion that no temp keyfile is
  materialized during dry_run.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## Non-negotiable principles (inherits v1 + v2)

All v1 and v2 invariants apply unchanged. This spec preserves them per
spec §5 mapping:

1. **Specs come first.** Spec-filha aceita 2026-05-26 precedes every
   code change in this plan.
2. **Idempotency by design.** Existing
   `core/src/reconciler/idempotency*.property.test.ts` suite remains
   green untouched. Every new dry_run branch is idempotent (re-call
   with the same input is a no-op).
3. **Fail-safe, never fail-deleting.** Mudança E flip `on → off` does
   NOT delete WireGuard peers; the reconciler emits drift events
   (validated in Phase 5).
4. **Secrets resolved at apply only.** Mudança B *removes* a leak
   surface — dry_run no longer spawns `ssh-exec` and no temp keyfile is
   ever materialized. Plan tasks include explicit "no SSH spawn in
   dry_run" sentinels.
5. **StateEvent actor.** Unchanged. No task in this plan touches the
   `state_events` writer or schema.

---

## Testing strategy

| Layer | How | Covers |
|---|---|---|
| Tool unit (`core/src/agent/tools.test.ts`) | Composite provider fake whose `observe()` throws `Error("observe must not be called in dry_run")`. Each v1 mutating handler under `dry_run:true` must not trigger it. | Mudança A + Mudança B sub-padrão §4.2.a; regression guard against future handlers forgetting the branch |
| v2 tool unit (`core/src/agent/v2/*.test.ts`) | Per-entity provider fake whose `observe()` throws. Each v2 write tool under `dry_run:true` must not trigger it. | Mudança B sub-padrão §4.2.b for all 6 v2 write tools |
| Gated-op unit (`core/src/agent/tools.test.ts`) | `doGatedOp` with `dry_run:true` for `destroy`/`snapshot`/`restore`. Assert `gate.evaluate` is not invoked and the `approvals` table has no new pending row. | Mudança B sub-padrão §4.2.c |
| Config unit (`core/src/config.test.ts`) | `ConfigSchema.parse({})` / `{MANAGED_MESH:"off"}` / `{MANAGED_MESH:""}` / invalid value | Mudança E default + validation |
| Wiring unit (`core/src/entrypoint-wiring.test.ts`) | `MANAGED_MESH="on"` → `routes.server.length === 2`; `MANAGED_MESH="off"` → `routes.server.length === 1` and `wireguard` not present. Capture pino logs and assert the boot-time warn for `off`. | Mudança E mechanical correctness + Q2 (warn) |
| Drift integration (`core/src/reconciler/reconcile.services.test.ts` or sibling) | Seed observed-store with WG peers; flip `MANAGED_MESH` from `on` to `off`; run one reconcile cycle; assert peers reported as drift StateEvent and NOT removed | Q4 (drift on flip), spec §4.3 |
| Idempotency property (existing, herdado v1+v2) | Re-run apply N×; second cycle = no-op | Invariant I2 preserved unchanged |
| `@live` opt-in | None — this plan adds no live test | — |

CI runs unit + integration with fakes on every commit. The pre-existing
`@live` suite is unaffected.

---

## File structure (one responsibility per file)

```
core/
  src/
    config.ts                                MODIFIED: add MANAGED_MESH knob (E)
    config.test.ts                           MODIFIED: parse cases for MANAGED_MESH
    entrypoint-wiring.ts                     MODIFIED: routes.server conditional on MANAGED_MESH + boot warn
    entrypoint-wiring.test.ts                MODIFIED: routes.server.length cases + warn assertion
    agent/
      tools.ts                               MODIFIED: dry_run branches for provision/scale/setDns/applyManifest + doGatedOp; v1 dry_run reads via getObservedState
      tools.test.ts                          MODIFIED: tool-unit cases for A + B §4.2.a + §4.2.c
      v2/
        set-firewall.ts                      MODIFIED: gate provider.observe() behind !dryRun
        set-firewall.test.ts                 MODIFIED: dry_run sentinel test
        set-load-balancer.ts                 MODIFIED: same
        set-load-balancer.test.ts            MODIFIED: dry_run sentinel test
        set-certificate.ts                   MODIFIED: same
        set-certificate.test.ts              MODIFIED: dry_run sentinel test
        set-primary-ip.ts                    MODIFIED: same
        set-primary-ip.test.ts               MODIFIED: dry_run sentinel test
        set-ingress.ts                       MODIFIED: same
        set-ingress.test.ts                  MODIFIED: dry_run sentinel test
        expose-service.ts                    MODIFIED: same
        expose-service.test.ts               MODIFIED: dry_run sentinel test
    reconciler/
      reconcile.services.test.ts             MODIFIED (or new sibling): Q4 drift-on-flip integration test
  .env.example                               MODIFIED: document MANAGED_MESH
docs/
  specs/2026-05-25-go-live-cloudflare-tunnel.md   MODIFIED: §9 SSH_* now conditional
  superpowers/plans/2026-05-26-server-scope-transport-decoupling.md  (this file)
CLAUDE.md                                    MODIFIED: §Stack note about MANAGED_MESH
deploy/README.md                             MODIFIED: MANAGED_MESH=off example for k3s
```

> No new files in `core/src/`. The entire spec is implemented via
> additive edits to seven existing source modules + their colocated
> tests.

---

# Task 0 — Branch + baseline (BLOCKING GATE)

**Goal/deliverable:** A `feat/server-scope-transport-decoupling` branch
off `main` with the baseline test suite green and clean typecheck.
**Exit criteria:** `npm --prefix core run typecheck` clean,
`npm --prefix core test` green (expected 897/898 — 1 `@live` skipped,
matching pre-task baseline).

### Task 0.1 — Create branch + verify baseline

- Files: none (branch only).
- [ ] Familiarise: read the spec end-to-end
  (`docs/specs/2026-05-26-server-scope-transport-decoupling.md`),
  re-read CLAUDE.md §"Como trabalhar neste projeto", and
  `.claude/rules/tdd-required.md`.
- [ ] Create branch:
  ```bash
  cd ~/bevox-hetzner-mcp
  git checkout main && git pull
  git checkout -b feat/server-scope-transport-decoupling
  ```
- [ ] Baseline verification (no test changes yet):
  ```bash
  npm --prefix core run typecheck
  npm --prefix core test
  ```
  Expect clean typecheck and the full unit suite green. If anything is
  red on `main`, STOP and surface — this plan does not adopt pre-existing
  failures.
- [ ] No commit (branch creation only).

**Done (Task 0) =** branch exists; baseline green; F1 may begin.

---

# Fase 1 (F1) — Mudança E: `MANAGED_MESH` knob (default `on`)

**Phase goal:** Add a `MANAGED_MESH` field to `ConfigSchema` and
conditionalise `routes.server` in `buildBootDeps`. Default `on`
preserves 100% of existing behaviour; `off` removes `wireguard` from
the server route and emits a boot-time warn.

**Deliverable:** Config parses `MANAGED_MESH`; `buildBootDeps`
respects it; boot warns on `off`.

**Exit criteria:** `core/src/config.test.ts` covers default + explicit
on/off + empty + invalid; `core/src/entrypoint-wiring.test.ts` covers
both routes shapes + warn assertion; full suite green; typecheck clean.

### Task 1.1 — `ConfigSchema` learns `MANAGED_MESH` (default `on`)

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Familiarise: re-read `SSH_HOST_KEY_POLICY` in `core/src/config.ts`
  (lines 129-134) — same `preprocess → enum → transform` pattern.
- [ ] Failing tests (append to `config.test.ts`):
  ```ts
  it("ConfigSchema parses MANAGED_MESH default to 'on' when absent", () => {
    const cfg = loadConfig(validEnvWithout("MANAGED_MESH"));
    expect(cfg.MANAGED_MESH).toBe("on");
  });
  it("ConfigSchema parses MANAGED_MESH='off' verbatim", () => {
    const cfg = loadConfig({ ...validEnv(), MANAGED_MESH: "off" });
    expect(cfg.MANAGED_MESH).toBe("off");
  });
  it("ConfigSchema treats MANAGED_MESH empty string as default 'on'", () => {
    const cfg = loadConfig({ ...validEnv(), MANAGED_MESH: "" });
    expect(cfg.MANAGED_MESH).toBe("on");
  });
  it("ConfigSchema rejects MANAGED_MESH invalid value", () => {
    expect(() => loadConfig({ ...validEnv(), MANAGED_MESH: "maybe" }))
      .toThrow(/MANAGED_MESH/);
  });
  ```
- [ ] Run `npm --prefix core test -- config.test` → expect FAIL
  (`MANAGED_MESH` not yet on `Config`).
- [ ] Minimal impl in `core/src/config.ts`:
  - Add to `ConfigSchema` object literal, mirroring `SSH_HOST_KEY_POLICY`:
    `MANAGED_MESH: z.preprocess((v) => v === undefined || v === "" ? undefined : v, z.enum(["on","off"]).optional()).transform((v) => v ?? "on")`
  - Comment: cite spec §4.3 "Mudança E knob".
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): MANAGED_MESH knob in ConfigSchema (default on) (1.1)`

### Task 1.2 — `routes.server` conditional on `MANAGED_MESH`

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: re-read `buildBootDeps` lines 137-205 of
  `entrypoint-wiring.ts`. `wireguard` is constructed unconditionally
  via `createWireGuardProvider`; only `routes.server` composition is
  the target.
- [ ] Failing tests (append to `entrypoint-wiring.test.ts`):
  ```ts
  it("MANAGED_MESH='on' (default) wires routes.server as [hetznerCloud, wireguard]", () => {
    const deps = buildBootDeps(cfgWith({ MANAGED_MESH: "on" }), fakeTransports);
    const route = deps.providers.server;
    expect(Array.isArray(route) ? route.length : 1).toBe(2);
  });
  it("MANAGED_MESH='off' wires routes.server with only hetznerCloud", () => {
    const deps = buildBootDeps(cfgWith({ MANAGED_MESH: "off" }), fakeTransports);
    const route = deps.providers.server;
    expect(Array.isArray(route) ? route.length : 1).toBe(1);
    // assert wireguard NOT present via a tag check (compare by reference to the
    // wireguard provider returned by createWireGuardProvider or a known label)
  });
  ```
- [ ] Run → expect FAIL (current wiring is unconditional `[hetznerCloud, wireguard]`).
- [ ] Minimal impl in `core/src/entrypoint-wiring.ts`:
  - Replace lines ~197-204 `server: [hetznerCloud, wireguard]` with a
    ternary conditioned on `config.MANAGED_MESH === "on"`. WireGuard
    provider continues to be constructed (preserves spec audit and
    future-proofing) — only the route changes.
  - Comment: cite spec §4.3.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): routes.server conditional on MANAGED_MESH (1.2)`

### Task 1.3 — Boot-time warn when `MANAGED_MESH='off'` (Q2)

- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: re-read `warnDesiredStateInProcess` lines 242-255 of
  `entrypoint-wiring.ts` — same shape, structured Pino warn,
  value-free.
- [ ] Failing test: with a capturing logger, build deps with
  `MANAGED_MESH="off"`, assert exactly one `warn` entry whose fields
  include `subsystem: "managed-mesh"`, `managedMesh: "off"`, and an
  actionable message string. With `MANAGED_MESH="on"`, assert no such
  warn is emitted.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: add a new module-private `warnManagedMeshOff(logger)`
  mirroring `warnDesiredStateInProcess`. Call it from `buildBootDeps`
  (or `runMain` — choose whichever already has a logger handle at boot)
  exactly once when `config.MANAGED_MESH === "off"`. Value-free: log
  the literal string `"off"`, never any secret.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): boot-time warn when MANAGED_MESH=off (1.3)`

### Task 1.4 — Document `MANAGED_MESH` in `core/.env.example`

- Files: `core/.env.example`.
- [ ] No code test (env.example is documentation). The behavioural test
  for default + parsing already lives in 1.1.
- [ ] Edit: append a new "Optional — managed mesh" block after the
  `SSH_KNOWN_HOSTS` block (~line 97), explaining:
  - default `on` preserves 100% v1 behaviour;
  - `off` removes WireGuard from `routes.server`, making `SSH_*`
    optional for the server scope (still required when a `Service` is
    declared — Docker via SSH is orthogonal);
  - cite spec `docs/specs/2026-05-26-server-scope-transport-decoupling.md`.
- [ ] No commit-required test run; rely on the next full-suite green at
  Task 1.5 wrap.
- [ ] Commit: `docs(core): document MANAGED_MESH in .env.example (1.4)`

**Done (F1) =** `MANAGED_MESH` parses; `routes.server` length flips
between 2 and 1; boot warns on `off`; `.env.example` documents the
knob; existing tests untouched and green.

---

# Fase 2 (F2) — Mudança A: v1 handlers honour `input.dry_run`

**Phase goal:** Every v1 mutating handler in
`core/src/agent/tools.ts` that currently ignores `dry_run`
(`doProvisionServer`, `doScaleService`, `doSetDns`, `doApplyManifest`)
grows a dedicated dry_run branch returning a `planned` envelope **without
calling `mergeDesired`, without calling `reconcileToEnvelope`, and
without calling `gate.evaluate`**. The branch mirrors the canonical
shape already established in `doDeployService:456-472`.

**Deliverable:** Four v1 handlers honour `dry_run`. (Mudança B for
these same branches lands in F3 — F2 still calls
`provider.observe(scope)` in the dry_run branch; F3 swaps to
`getObservedState`.)

**Exit criteria:** Each handler under `dry_run:true` returns
`{ status: "planned", plan: [...] }` and never writes desired-state.
Tested via the existing `tools.test.ts` colocated suite.

> **Sub-padrão §4.2.c (`doGatedOp`) is also Mudança A**, but lands in
> F4 alongside Mudança B for `doGatedOp` because the change is one
> atomic edit (add `dryRun` param + short-circuit before
> `gate.evaluate`). Keeping the two halves together avoids a partial
> commit window where `doGatedOp` honours `dry_run` but still writes
> approvals.

### Task 2.1 — `doProvisionServer` honours `dry_run`

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Familiarise: re-read `doDeployService` lines 434-488 of
  `tools.ts` — that is the canonical dry_run shape to mirror.
- [ ] Failing test (append to `tools.test.ts`): with a composite
  provider fake whose `observe()` throws
  `Error("observe must not be called in dry_run")`, call
  `provision_server({ name: "s1", type: "cx22", location: "fsn1",
  network: "n1", dry_run: true }, scope, actor)`; assert the result is
  `{ status: "planned", plan: [...] }`, no desired-state write occurred
  (`loadDesired(scope)` returns `{}`), and `observe()` was NOT invoked.
  - NB: for F2 the test uses an observe fake that throws **only when
    the caller is `doProvisionServer`'s dry_run path**. F3 will replace
    the live observe with `getObservedState`; updating this test in F3
    is acceptable.
  - **Simpler alternative**: have the F2 dry_run branch read via
    `provider.observe(scope)` for now (mirrors `doDeployService` as it
    stands today); F3 swaps to `getObservedState` in a separate commit.
    Pick this if it keeps the per-task diff small.
- [ ] Run → expect FAIL (`doProvisionServer` currently ignores
  `dry_run`).
- [ ] Minimal impl in `core/src/agent/tools.ts`:
  - Add `const dryRun = input.dry_run === true` at the top of
    `doProvisionServer`.
  - If `dryRun`: compute the hypothetical desired (current +
    appended server entry), parse via `DesiredStateSchema.parse`, call
    `provider.observe(scope)` + `observedAdapter(slice)` (same as
    `doDeployService` today), return `planned(plan(desired, observed))`.
    Do NOT call `mergeDesired`. Do NOT call `reconcileToEnvelope`.
  - Apply branch unchanged.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): doProvisionServer honours dry_run (2.1)`

### Task 2.2 — `doScaleService` honours `dry_run`

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: same shape as 2.1 — `scale_service({name:"svc",
  replicas:3, dry_run:true}, ...)` returns `planned`, no desired write,
  no apply.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: add `dryRun` branch in `doScaleService`. Hypothetical
  desired = mapped services with `s.name === name ? { ...s, replicas }
  : s`. Return `planned(plan(desired, observed))`. Apply branch unchanged.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doScaleService honours dry_run (2.2)`

### Task 2.3 — `doSetDns` honours `dry_run`

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: `set_dns({zone, name, type, value, dry_run:true})`
  returns `planned`, no desired write.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: dry_run branch composes the hypothetical
  `dns: [...filtered, newRecord]` shape (mirrors apply branch).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doSetDns honours dry_run (2.3)`

### Task 2.4 — `doApplyManifest` honours `dry_run`

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: `apply_manifest({manifest:{...}, dry_run:true})`
  returns `planned`, no desired write (working store still empty
  afterwards).
- [ ] Run → expect FAIL.
- [ ] Minimal impl: dry_run branch parses the manifest through
  `DesiredStateSchema.parse(asRecord(input.manifest))` and returns
  `planned(plan(manifest, observed))` directly — manifest IS the
  desired in this handler.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doApplyManifest honours dry_run (2.4)`

**Done (F2) =** `provision_server`, `scale_service`, `set_dns`,
`apply_manifest` honour `dry_run`. (`doGatedOp` is F4.)

---

# Fase 3 (F3) — Mudança B §4.2.a: v1 dry_run reads from observed-store

**Phase goal:** Every v1 dry_run branch (the one in `doDeployService`
that exists today + the four added in F2) replaces
`provider.observe(scope)` with
`getObservedState(pool, scope)`. The composite provider fake whose
`observe()` throws is the regression sentinel.

**Deliverable:** No v1 dry_run branch invokes `provider.observe()`.

**Exit criteria:** Composite-provider-throws-on-observe test passes
for all 5 v1 dry_run paths; full suite green.

### Task 3.1 — `doDeployService` dry_run reads from observed-store

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Familiarise: line 470 of `tools.ts` is the live offender —
  `const slice = await provider.observe(scope)`. The import
  `getState as getObservedState` is already present at line 94.
- [ ] Failing test (append): composite provider fake whose `observe()`
  throws; seed observed-store via `putObservedState(pool, scope,
  someState)`; call `deploy_service({name, image, dry_run:true})`;
  assert (a) result is `planned`, (b) the returned plan reflects the
  seeded observed state, (c) `provider.observe` was NEVER invoked.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: replace lines ~470-471 of `doDeployService` with
  `const observed = await getObservedState(pool, scope);`. Drop the
  `observedAdapter(slice)` call in the dry_run branch (the
  observed-store already returns a `State`).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): doDeployService dry_run reads from observed-store (3.1)`

### Task 3.2 — `doProvisionServer` dry_run reads from observed-store

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: tighten the F2.1 test — the composite provider's
  `observe()` now throws unconditionally and the assertion is "throw
  never occurred".
- [ ] Run → expect FAIL (F2.1 path still calls `provider.observe`).
- [ ] Minimal impl: replace the `provider.observe(scope)` call inside
  the dry_run branch added in F2.1 with `getObservedState(pool, scope)`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doProvisionServer dry_run reads from observed-store (3.2)`

### Task 3.3 — `doScaleService` dry_run reads from observed-store

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: same shape as 3.2 for `scale_service`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: swap the source of `observed` in the F2.2 dry_run
  branch.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doScaleService dry_run reads from observed-store (3.3)`

### Task 3.4 — `doSetDns` dry_run reads from observed-store

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: same shape for `set_dns`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: swap the source in the F2.3 dry_run branch.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doSetDns dry_run reads from observed-store (3.4)`

### Task 3.5 — `doApplyManifest` dry_run reads from observed-store

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Failing test: same shape for `apply_manifest`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: swap the source in the F2.4 dry_run branch.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): doApplyManifest dry_run reads from observed-store (3.5)`

### Task 3.6 — No-SSH-spawn-in-dry_run sentinel test

- Files: `core/src/agent/tools.test.ts`.
- [ ] Failing test (single integration test): wire the composite
  provider with a real `WireGuardProvider` fake whose `observe()` would
  invoke a controller seam that **throws if invoked** with a "ssh spawn
  attempted" sentinel string. Run each of the 5 v1 mutating tools with
  `dry_run:true`. Assert no controller invocation occurred (i.e. no SSH
  spawn, no temp keyfile materialized — invariant I4).
- [ ] Run → expect PASS already (F3.1..3.5 fixed the underlying issue);
  if it accidentally fails, the regression is in a handler missed by
  F2/F3 — repair, don't weaken the test.
- [ ] Commit: `test(core): sentinel — no SSH spawn from v1 dry_run (3.6)`

**Done (F3) =** Every v1 mutating tool's dry_run branch reads from the
cached observed-store; no live `provider.observe()` call survives in
any dry_run path; sentinel test guards the invariant.

---

# Fase 4 (F4) — Mudança B §4.2.b + §4.2.c: v2 write tools + `doGatedOp`

**Phase goal:** Move `provider.observe(desired)` behind `if (!dryRun)`
in each of the 6 v2 write tools, and add a `dryRun` short-circuit
**before** `gate.evaluate` in `doGatedOp`. Both halves rely on the
same per-tool fake provider whose `observe()` throws.

**Deliverable:** All 6 v2 write tools + `doGatedOp` honour dry_run as
strictly side-effect-free.

**Exit criteria:** Per-tool sentinel tests pass; `doGatedOp` dry_run
does not write to `approvals`; full suite green.

### Task 4.1 — `set-firewall` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/set-firewall.ts`,
  `core/src/agent/v2/set-firewall.test.ts`.
- [ ] Familiarise: locate `await deps.provider.observe(...)` in
  `set-firewall.ts` (mirrors the pattern in `set-ingress.ts:169-194`).
- [ ] Failing test (append to `set-firewall.test.ts`): per-entity v2
  provider fake whose `observe()` throws `Error("observe must not be
  called in dry_run")`. Call `setFirewall({ firewall, dry_run: true },
  ctx, deps)`. Assert (a) returned envelope `status: "planned"`,
  (b) `plan.ops` reflects the create-from-empty path
  (`plan(desired, null)`), (c) no working-store write, (d) no
  StateEvent, (e) `observe` NEVER invoked.
- [ ] Run → expect FAIL (current code calls `observe` before the
  `dryRun` check).
- [ ] Minimal impl:
  - Hoist `const dryRun = input.dry_run === true` (already present).
  - Initialise `let observed: ObservedFirewall | null = null` before
    the `try/observe` block.
  - Wrap the `try { observed = await deps.provider.observe(...) }`
    block in `if (!dryRun) { ... }`.
  - Continue to call `await deps.provider.plan(desired, observed)`
    unchanged — when `dryRun`, `observed` is `null` and `plan()`
    returns the create-from-empty plan (semantically equivalent to v1
    with empty observed).
  - The dry_run branch later in the function (returns `planned`
    envelope) is unchanged.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): set_firewall gates observe() behind !dryRun (4.1)`

### Task 4.2 — `set-load-balancer` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/set-load-balancer.ts`,
  `core/src/agent/v2/set-load-balancer.test.ts`.
- [ ] Failing test: same sentinel pattern as 4.1, scoped to
  `setLoadBalancer`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: same edit shape as 4.1, in
  `set-load-balancer.ts`.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): set_load_balancer gates observe() behind !dryRun (4.2)`

### Task 4.3 — `set-certificate` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/set-certificate.ts`,
  `core/src/agent/v2/set-certificate.test.ts`.
- [ ] Failing test: same sentinel pattern. Cover both `managed` and
  `uploaded` discriminator cases.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: same edit shape as 4.1.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): set_certificate gates observe() behind !dryRun (4.3)`

### Task 4.4 — `set-primary-ip` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/set-primary-ip.ts`,
  `core/src/agent/v2/set-primary-ip.test.ts`.
- [ ] Failing test: same sentinel pattern. NB:
  `set-primary-ip.ts:208-210` is the offending call site.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: same edit shape.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): set_primary_ip gates observe() behind !dryRun (4.4)`

### Task 4.5 — `set-ingress` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/set-ingress.ts`,
  `core/src/agent/v2/set-ingress.test.ts`.
- [ ] Failing test: same sentinel pattern. The current code path
  is at `set-ingress.ts:169-174`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: wrap the `try { observed = await
  deps.provider.observe(desired) }` block in `if (!dryRun)`. Initialise
  `observed = null` before. The downstream
  `await deps.provider.plan(desired, observed)` is unchanged.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): set_ingress gates observe() behind !dryRun (4.5)`

### Task 4.6 — `expose-service` gates `provider.observe()` behind `!dryRun`

- Files: `core/src/agent/v2/expose-service.ts`,
  `core/src/agent/v2/expose-service.test.ts`.
- [ ] Familiarise: `expose-service` composes three sub-writes (Cert + LB
  + Ingress) — verify whether it calls `observe` itself or only
  composes the per-tool primitives. If it composes, the fix is
  automatic from 4.1/4.2/4.3/4.5; in that case the task is only the
  sentinel test (covering "expose_service dry_run does not transitively
  call any observe").
- [ ] Failing test: integration — composite fake provider where every
  per-entity `observe()` throws; call `expose_service({service,
  hostname, tls, dry_run:true})`; assert `status: "planned"` and no
  `observe` invocation.
- [ ] Run → expect FAIL if `expose-service` calls `observe` directly,
  PASS if it composes (in which case commit the test as a regression
  guard only).
- [ ] Minimal impl (if needed): same edit shape as 4.1.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): expose_service dry_run does not call observe (4.6)`

### Task 4.7 — `doGatedOp` honours `dry_run` (skip `gate.evaluate`)

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] Familiarise: re-read `doGatedOp` lines 559-601 of `tools.ts`. The
  three call sites are in the `executeTool` dispatch for `destroy`,
  `snapshot`, `restore` (search for `doGatedOp(` in the same file).
- [ ] Failing test (append to `tools.test.ts`): for each of `destroy`,
  `snapshot`, `restore`, call the tool with `dry_run:true`. Assert
  (a) returned envelope `status: "planned"` with the synthetic
  `PlanItem` for the op+entity, (b) `gate.evaluate` was NEVER invoked
  (use a `makeGate` spy), (c) the `approvals` table has zero new rows
  for this `(scope, op, entity)`.
- [ ] Run → expect FAIL (current code invokes `gate.evaluate`
  unconditionally).
- [ ] Minimal impl in `core/src/agent/tools.ts`:
  - Extend `doGatedOp` signature with `dryRun: boolean` as the last
    param.
  - Immediately after constructing `item: PlanItem`, branch
    `if (dryRun) return planned([item]);` (BEFORE `gate.evaluate`).
  - Update all 3 call sites (in the `executeTool` switch for
    `destroy`/`snapshot`/`restore`) to thread the `input.dry_run === true`
    flag through.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): doGatedOp honours dry_run, skips gate.evaluate (4.7)`

**Done (F4) =** Every v2 write tool's dry_run path is observe-free;
`doGatedOp` dry_run does not persist an approval. Mudanças A and B are
complete for both v1 and v2.

---

# Fase 5 (F5) — Q4 validation: drift on `MANAGED_MESH` flip on→off

**Phase goal:** Confirm that flipping `MANAGED_MESH` from `on` to `off`
in a deploy where peers exist results in **drift StateEvents**, NOT
peer deletion. This validates spec invariant I3 (fail-safe, never
fail-deleting) and resolves spec Q4.

**Deliverable:** A single integration test that demonstrates the
behaviour end-to-end with fakes. If the existing drift detector already
covers it, the test is a regression guard; if not, a minimal
extension to the reconciler/drift detector lands here.

**Exit criteria:** Test green; no WG peer deletion observed in the
test; StateEvent of `kind: "drift"` (or equivalent) emitted for each
orphaned peer.

### Task 5.1 — Drift-on-flip integration test

- Files: `core/src/reconciler/reconcile.services.test.ts` (or a new
  sibling `reconcile.managed-mesh-flip.test.ts` if the existing file is
  near the 600-line soft limit).
- [ ] Familiarise: locate the existing drift detection test pattern
  under `core/src/reconciler/`; identify the StateEvent assertion
  pattern (search `kind: "drift"` or `result: "drift"` per the
  `state_events` writer convention).
- [ ] Failing test: (a) build BootDeps with `MANAGED_MESH="on"`, seed
  desired state with a Server, run one reconcile cycle so WG peers
  appear in observed-store; (b) tear down, rebuild BootDeps with
  `MANAGED_MESH="off"` (same Postgres, same desired); (c) run a
  reconcile cycle; (d) assert the observed-store reflects the new
  (no-WG) server scope; (e) assert StateEvent of drift kind exists
  naming the orphaned peer; (f) assert the WG controller fake recorded
  ZERO `wg-quick down` / `wg set ... remove` invocations.
- [ ] Run → expect FAIL or PASS depending on whether the existing drift
  detector already covers this case.
- [ ] Minimal impl (only if test fails): extend the drift detector to
  emit the drift event for the case where a previously-routed kind is
  no longer in `routes.server`. Do NOT add a code path that deletes —
  the invariant is fail-safe.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): drift on MANAGED_MESH on→off, never deletes peers (5.1)`

**Done (F5) =** Q4 explicitly covered. Flipping the knob does not
remove resources.

---

# Fase 6 (F6) — Documentation updates (spec §10)

**Phase goal:** Apply the doc updates the spec explicitly delegates to
the implementation. No code changes here.

**Deliverable:** Three operator-facing documents reflect the new knob
and its SSH-conditional implications.

**Exit criteria:** Docs reviewed; no test changes; full suite still
green.

### Task 6.1 — Update `2026-05-25-go-live-cloudflare-tunnel.md` §9

- Files: `docs/specs/2026-05-25-go-live-cloudflare-tunnel.md`.
- [ ] Familiarise: read §9 of the cloudflare-tunnel spec.
- [ ] Edit §9: clarify that `SSH_HOST` / `SSH_USER` / `SSH_PRIVATE_KEY`
  are required only when (a) `MANAGED_MESH=on` (default), or (b) at
  least one `Service` is declared (Docker still uses SSH transport).
  Cite this spec by date+slug.
- [ ] Commit: `docs(specs): go-live SSH_* requirement now conditional on MANAGED_MESH (6.1)`

### Task 6.2 — Update `CLAUDE.md` §"Stack"

- Files: `CLAUDE.md`.
- [ ] Edit: under §"Stack (definitiva — em produção)" add one bullet
  citing `MANAGED_MESH` knob with one-line semantic ("default `on`
  preserves v1 mesh routing; `off` decouples `routes.server` from
  WireGuard for k3s/CNI deploys"). Cite spec
  `2026-05-26-server-scope-transport-decoupling.md`.
- [ ] Commit: `docs(claude): note MANAGED_MESH knob in §Stack (6.2)`

### Task 6.3 — Update `deploy/README.md`

- Files: `deploy/README.md`.
- [ ] Edit: add a short operator-facing section (or sub-bullet to an
  existing section) showing the `MANAGED_MESH=off` posture with a
  k3s-style deploy example. Reiterate that `SSH_*` becomes optional
  for the server scope but remains required if any `Service` is
  declared.
- [ ] Commit: `docs(deploy): add MANAGED_MESH=off example for k3s-style deploys (6.3)`

**Done (F6) =** Three docs aligned with the new knob.

---

## Fora de escopo / depende de credenciais reais

Per spec §3 non-goals, this plan deliberately does NOT:

- Implement a declarative `requires_transports[]` DSL per provider
  (Option D from the investigation) — over-engineered for v1.
- Make `routes.service` configurable — Docker continues via SSH, fully
  orthogonal to the mesh.
- Modify any v2 wire-contract or Zod schema in
  `console/src/api/contract-v2.ts`.
- Edit any FROZEN v1 or v2 spec in place (only the go-live operational
  spec §9 receives a clarification — that spec is not under FROZEN
  protection).
- Add automatic destructive rollback (forbidden by invariant I3).
- Add automatic peer cleanup on `MANAGED_MESH=off` flip — drift is
  reported, never corrected.
- Rename or restructure `routes` v1 — only a knob is added at the
  composition site.
- Add a real `@live` smoke for this change — opt-in lives manually
  pre-release, untouched.

## Done = (per phase, summary)

- **Task 0:** branch + baseline green.
- **F1 (Mudança E):** `MANAGED_MESH` knob in `ConfigSchema` (default
  `on`); `routes.server` conditional in `buildBootDeps`; boot-time warn
  on `off`; `.env.example` documents the knob; full suite green
  untouched.
- **F2 (Mudança A v1):** `doProvisionServer`, `doScaleService`,
  `doSetDns`, `doApplyManifest` honour `input.dry_run`; no
  desired-state writes in dry_run.
- **F3 (Mudança B §4.2.a):** all v1 dry_run branches (5 handlers —
  `doDeployService` + the four above) read from `getObservedState`,
  never `provider.observe()`; no SSH spawn from v1 dry_run (sentinel
  test).
- **F4 (Mudança B §4.2.b + §4.2.c):** all 6 v2 write tools gate
  `provider.observe()` behind `!dryRun`; `doGatedOp` honours `dry_run`,
  skipping `gate.evaluate` and never persisting an approval row.
- **F5 (Q4):** flipping `MANAGED_MESH` on→off in a deploy with peers
  produces drift StateEvents and ZERO peer deletions.
- **F6 (docs):** go-live spec §9, CLAUDE.md §Stack, deploy/README.md
  aligned with the new knob.
