# Hetzner volume bind + automount (service persistence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Goal:** A declared Hetzner volume is persisted by the container that
uses it, end-to-end. After this plan, `service.volumes: ["<name>:<container_path>"]`
(1) passes the planner's cross-kind validation against the declared
volume `<name>` (Bug 9), (2) the volume create sends `automount: true`
so Hetzner formats the NEW volume once and mounts it at
`/mnt/HC_Volume_<id>` (never reformats — data-safe), and (3) the
DockerProvider resolves `<name>:<container_path>` to the real Hetzner
mount `/mnt/HC_Volume_<hcloud_id>:<container_path>` at apply, with
`isConverged` resolving the bind the SAME way so re-apply is a no-op.
Back-compat is total: `["data"]` and explicit absolute host-path binds
pass AS-IS.

**Architecture:** Three additive, independent surfaces. The planner
(`reconciler/plan.ts`) derives the cross-kind dep from the volume NAME
(segment before the first `:`). The Hetzner provider
(`providers/hetzner-cloud.ts` `volumeBody`) adds `automount: true` to the
`POST /volumes` body. The DockerProvider gains an OPTIONAL additive seam
`resolveVolumeMount?(name) => Promise<string | undefined>` on
`DockerProviderOptions`; both `createBody` and `isConverged` consult it
to resolve a `<name>:<container_path>` bind to the real mount, falling
back AS-IS when there is no resolver, no match, or the left segment is
already an absolute path. The composition root (`entrypoint-wiring.ts`)
wires `resolveVolumeMount` to the observed-state store
(`getState(pool, "volume")` → find by name → `/mnt/HC_Volume_<hcloud_id>`).
Cross-provider coupling is avoided: Docker reads the observed volume
state, it does not call the Hetzner provider. First cycle (volume not yet
observed) binds AS-IS and converges on the next cycle — accepted per
spec §7.4, NOT atomic.

**Tech Stack:** Inherits the v1 ratified stack unchanged (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`,
PostgreSQL 16 via `pg`, Docker Engine API via SSH, Zod, Pino, Vitest +
HTTP fakes). **Zero new dependencies.** No new contract field, no new
tool, no new migration — additive behaviour over existing schemas.

**Specs:**
- This spec: `docs/specs/2026-06-01-volume-hetzner-bind-automount.md` (Status: Aceita)
- v2 contract (FROZEN): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- v1 base (FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`

---

## How this plan is executed

Single plan, four phases, executed in order. The phases are deliberately
ordered so the two INDEPENDENT, low-risk surfaces land first (F1 planner
split + F2 automount), then the IDEMPOTENCY-CRITICAL core (F3 resolver
seam + `isConverged`), then composition-root wiring (F4), then the
idempotency property + docs capstone (F5). Do not start `Fase N+1` until
`Fase N`'s "Done =" holds and `npm --prefix core test` is green.

All paths are repo-root-relative under ``.
Every file this plan touches already exists — there are NO new
production source files (the seam is added to existing
`DockerProviderOptions`). New test cases are added to existing colocated
`*.test.ts` files.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail for the RIGHT
  reason (assertion mismatch, not import/type error) → minimal
  implementation → run, see it pass → commit. Reference
  @superpowers:test-driven-development and `.claude/rules/tdd-required.md`.
- **DRY / YAGNI / minimal change**: build only what each task needs; no
  speculative abstraction. Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Conventional Commits.
  Mandatory trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  spec: 2026-06-01-volume-hetzner-bind-automount.md (task N)
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: Docker Engine via `core/test/fakes/docker-http.ts`;
  Hetzner Cloud via the `core/test/fakes/hetzner-http*.ts` fake; DB-backed
  property test via `core/test/fakes/pg-harness.ts` (Postgres on port
  5546, `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`).
  No `@live` surface is needed for this plan.
- **Fail-safe, never fail-deleting**: automount is HETZNER'S format of the
  NEW volume only; this plan emits NO `mkfs`, no delete, no detach, no
  reformat. Re-attach/re-create never reformats (Hetzner semantics).
  Reference `.claude/rules/fail-safe.md`.
- **No silent drift correction.**
- **Secret golden byte-identical**: `core/src/reconciler/secret-apply.test.ts`
  must remain byte-identical — the bind resolver never touches the env /
  secret channel. Reference `.claude/rules/secrets-resolution.md`.
- **ESM/NodeNext hygiene**: `.js` import extensions, `import type` for
  type-only imports, narrow indexed access (`noUncheckedIndexedAccess`),
  no `console.*` in `core/src/`, `_`-prefix any test-only export.
  Reference `.claude/rules/esm-nodenext.md`.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — no contract change

This plan is **additive and contract-neutral**:

- No new wire field on any console contract (`contract.ts` / `contract-v2.ts`).
- No new MCP tool, no new REST endpoint, no new migration.
- `mount_path` on `VolumeSchema` (`core/src/domain/entities.ts:70`) stays
  **advisory** — NOT sent to Hetzner (automount fixes the path to
  `/mnt/HC_Volume_<id>`). Documented as doc-only in F5.
- `service.volumes` accepts the existing forms unchanged: bare name
  (`["data"]`), absolute host path (`["/srv/x:/data"]`), AND the
  newly-resolved `["<name>:<container_path>"]`.

---

## Non-negotiable principles (this plan)

All v1/v2 invariants apply unchanged. The load-bearing ones here:

1. **Idempotency of the RESOLVED bind (risk #1).** `isConverged` MUST
   resolve a `<name>:<container_path>` bind through the SAME
   `resolveVolumeMount` path that `createBody` uses, BEFORE comparing
   `HostConfig.Binds`. If the two diverge, re-apply flaps into infinite
   container re-create. Locked by an explicit re-apply-no-op test (F3) and
   the DB-backed idempotency property (F5).
2. **Fail-safe / data-safety.** Automount formats only the NEW volume,
   once, by Hetzner. This plan never issues `mkfs`, delete, detach, or
   reformat. Re-attach is data-preserving by Hetzner contract.
3. **Back-compat.** Every existing `service.volumes` form keeps its
   current behaviour. The seam is OPTIONAL — when absent (isolation
   tests), behaviour is byte-identical to today (AS-IS bind).
4. **Stable observed key.** The resolved mount derives from a fixed
   `hcloud_id`, so it is stable across cycles once the volume is observed.

---

## Testing strategy

| Layer | How | Covers |
|---|---|---|
| Planner (Bug 9) | `core/src/reconciler/plan.test.ts` | dep derived from volume NAME (`split(":")[0]`); `["data"]` retro-compat; `["pg-data:/var/lib/pg"]` validates against declared `pg-data`; undeclared name → precondition |
| automount | `core/src/providers/hetzner-cloud.test.ts` + hetzner fake | `POST /volumes` body includes `automount: true` alongside `format`; `mount_path` NOT sent |
| bind resolve + isConverged | `core/src/providers/docker.test.ts` + `core/test/fakes/docker-http.ts` | resolver-present → `["/mnt/HC_Volume_42:/var/lib/pg"]`; no resolver → AS-IS; absolute host-path → AS-IS; bare name → AS-IS; **re-apply no-op (isConverged resolves identically)** |
| resolver wiring | `core/src/entrypoint-wiring.test.ts` | name → `/mnt/HC_Volume_<hcloud_id>` via observed store; absent name → `undefined` (bind AS-IS); first cycle non-atomic |
| idempotency property | `core/src/reconciler/idempotency.property.test.ts` (DB-backed) | manifest with volume + service(resolved bind) converges; cycle 2 = zero mutating actions |
| secret golden | `core/src/reconciler/secret-apply.test.ts` | UNCHANGED, byte-identical — resolver never touches the secret/env channel |

CI runs unit + property with fakes on every commit. No real infra. No
`@live` surface added by this plan.

---

## File structure (touched files — all exist; no new prod files)

```
core/
  src/
    reconciler/
      plan.ts                          MODIFIED  Bug 9: dep = key("volume", vol.split(":")[0] ?? vol)   (~:162)
      plan.test.ts                     MODIFIED  Bug 9 cases
      idempotency.property.test.ts     MODIFIED  resolved-bind convergence path (F5)
      secret-apply.test.ts             UNCHANGED  (assert byte-identical — guard, do not edit)
    providers/
      hetzner-cloud.ts                 MODIFIED  volumeBody adds automount: true                        (~:384)
      hetzner-cloud.test.ts            MODIFIED  automount-body case
      docker.ts                        MODIFIED  resolveVolumeMount seam on DockerProviderOptions (~:142);
                                                 createBody (~:391) + isConverged (~:485) resolve binds
      docker.test.ts                   MODIFIED  resolve/AS-IS/no-op cases
    entrypoint-wiring.ts               MODIFIED  wire resolveVolumeMount via getState(pool,"volume") (~:237)
    entrypoint-wiring.test.ts          MODIFIED  wiring + first-cycle cases
  test/
    fakes/
      docker-http.ts                   MODIFIED if needed  (inspect HostConfig.Binds round-trip)
      hetzner-http*.ts                 MODIFIED if needed  (capture POST /volumes body)
CHANGELOG.md                           MODIFIED  feature entry (F5)
docs/manifest-schema-cheatsheet.md     MODIFIED  service.volumes format + mount_path advisory (F5)
```

---

# Fase 1 (F1) — Bug 9: planner validates the volume NAME (INDEPENDENT)

**Phase goal:** The planner derives the cross-kind dependency from the
volume NAME segment, not the whole `service.volumes` string.
**Deliverable:** `plan.ts:162` splits on `:`; `["pg-data:/var/lib/pg"]`
validates against a declared volume `pg-data`; `["data"]` stays valid.
**Exit criteria:** F1 tests green; `npm --prefix core run typecheck` clean;
no other behaviour changed.

### Task 1.1 — planner dep from volume name (`split(":")[0]`)

- Files: `core/src/reconciler/plan.test.ts` (modify), `core/src/reconciler/plan.ts` (modify, line ~162).
- [ ] Familiarise: read `core/src/reconciler/plan.ts:155-171` (the
  `for (const svc of services)` block; `key("volume", vol)` at :162) and
  the existing volume-dep test cases in `plan.test.ts` (grep `svc.volumes`
  / `key("volume"` / existing `["data"]` fixture).
- [ ] Failing test (add to `plan.test.ts`):
  - a manifest with volume `pg-data` declared AND service
    `volumes: ["pg-data:/var/lib/postgresql/data"]` builds a graph whose
    service node `deps` contains `key("volume", "pg-data")` (NOT the full
    string) and topo-sorts without a precondition error;
  - retro-compat: a service with `volumes: ["data"]` against declared
    volume `data` still validates (dep === `key("volume", "data")`);
  - an undeclared name `volumes: ["nope:/x"]` raises the existing
    dangling-ref `precondition` (proves the NAME is what's validated).
- [ ] Run `npm --prefix core test -- plan.test.ts` → expect FAIL (current
  code keys the whole `"pg-data:/var/lib/postgresql/data"` string, so it
  is treated as a missing volume name → wrong dep / wrong precondition).
- [ ] Minimal impl: change `plan.ts:162` to
  `...(svc.volumes ?? []).map((vol) => key("volume", vol.split(":")[0] ?? vol))`.
  The `?? vol` preserves a string with no `:` (`"data".split(":")[0] === "data"`,
  so the fallback is belt-and-suspenders for `noUncheckedIndexedAccess`).
  No other line changes.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `fix(core): planner validates volume name not full bind string (1.1)`

**Done (F1) =** planner derives the cross-kind volume dep from the NAME
segment; `name:container_path` accepted; `["data"]` retro-compatible;
undeclared name still a precondition.

---

# Fase 2 (F2) — automount on volume create (INDEPENDENT)

**Phase goal:** The volume `POST /volumes` body carries `automount: true`,
so Hetzner formats the new volume once and mounts it at
`/mnt/HC_Volume_<id>`. **Deliverable:** `volumeBody` adds the field.
**Exit criteria:** F2 tests green; `mount_path` still NOT sent; existing
volume-create tests unchanged (additive field only).

### Task 2.1 — `volumeBody` sends `automount: true`

- Files: `core/src/providers/hetzner-cloud.test.ts` (modify),
  `core/src/providers/hetzner-cloud.ts` (modify `volumeBody`, ~:384-409);
  `core/test/fakes/hetzner-http*.ts` (modify ONLY if the fake does not
  already capture the `POST /volumes` request body).
- [ ] Familiarise: read `hetzner-cloud.ts:384-409` (`volumeBody` builds
  `{ name, size, format, server|location }`) and the existing volume
  apply/create test in `hetzner-cloud.test.ts` (grep `volumeBody` /
  `POST` `/volumes` / `format`). Confirm how the fake records the create
  body (`core/test/fakes/hetzner-http*.ts`).
- [ ] Failing test (add to `hetzner-cloud.test.ts`): applying a desired
  standalone volume (with `location`) issues a `POST /volumes` whose
  captured body has `automount === true` AND still carries
  `format === <fs>`; assert the body does NOT contain a `mount_path` key
  (advisory, never sent).
- [ ] Run `npm --prefix core test -- hetzner-cloud.test.ts` → expect FAIL
  (body has no `automount`).
- [ ] Minimal impl: in `volumeBody`, add `automount: true` to the base
  `body` object (alongside `name`/`size`/`format`). Do NOT add
  `mount_path`. Conditional `server`/`location` branches unchanged.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): send automount:true on Hetzner volume create (2.1)`

**Done (F2) =** new-volume create requests `automount: true` (Hetzner
formats once, mounts at `/mnt/HC_Volume_<id>`, never reformats);
`mount_path` remains advisory and unsent; format still sent.

---

# Fase 3 (F3) — bind resolution seam + isConverged (IDEMPOTENCY-CRITICAL CORE)

**Phase goal:** The DockerProvider resolves `<name>:<container_path>`
binds to the real Hetzner mount via an OPTIONAL `resolveVolumeMount` seam,
in BOTH `createBody` and `isConverged`, so apply is correct AND re-apply
is a no-op. **Deliverable:** the seam + symmetric resolution.
**Exit criteria:** F3 tests green; explicit re-apply-no-op test green;
absent-seam / absolute-path / bare-name all AS-IS; `npm --prefix core run
typecheck` clean.

> **This is the highest-risk phase.** The single failure mode is asymmetry
> between `createBody` and `isConverged`: if one resolves a bind and the
> other compares the unresolved string, `isConverged` returns false
> forever and the reconciler re-creates the container every cycle. Tasks
> 3.2 and 3.3 are ordered so resolution and the convergence check are
> implemented and tested against the SAME helper.

### Task 3.1 — add the optional `resolveVolumeMount` seam to options

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `DockerProviderOptions` ~:89-142).
- [ ] Familiarise: read `docker.ts:89-142` (`DockerProviderOptions`,
  noting the existing OPTIONAL additive seam pattern of `secretResolver` /
  `now` / `sleep` — same convention) and the provider factory signature.
- [ ] Failing test (add to `docker.test.ts`): `createDockerProvider`
  accepts an options object that includes
  `resolveVolumeMount: async (name) => ...` and constructs without error
  (type-level + runtime smoke). This is the smallest red that fails on a
  missing option key being rejected by the (current) interface — assert by
  exercising a behaviour the next tasks will define, or scope this task
  into 3.2 if a standalone red is not meaningful. Prefer folding into 3.2
  if the seam alone has no observable behaviour (split is healthy, not
  mandatory).
- [ ] Minimal impl: add
  `readonly resolveVolumeMount?: (volumeName: string) => Promise<string | undefined>;`
  to `DockerProviderOptions`, documented as OPTIONAL/additive/back-compat
  (mirror the `secretResolver` doc-comment tone). Capture it in the
  factory closure so `createBody`/`isConverged` can call it.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): optional resolveVolumeMount seam on DockerProviderOptions (3.1)`

> If 3.1 has no standalone observable behaviour, MERGE it into 3.2 and
> commit once as `feat(core): resolveVolumeMount seam + bind resolution in createBody (3.2)`.

### Task 3.2 — `createBody` resolves `<name>:<container_path>` binds

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `createBody` ~:437-448; extract a
  shared `_resolveBind` helper).
- [ ] Familiarise: read `docker.ts:437-448` (where
  `body.HostConfig = { Binds: [...svc.volumes!] }` is built, AND the gap-4
  `RestartPolicy` MERGE at :449-456 that must not clobber `Binds`).
- [ ] Failing test (add to `docker.test.ts`): with the provider built
  WITH `resolveVolumeMount = async (n) => n === "pg-data" ? "/mnt/HC_Volume_42" : undefined`,
  applying a service `volumes: ["pg-data:/var/lib/postgresql/data"]`
  produces a create body with
  `HostConfig.Binds === ["/mnt/HC_Volume_42:/var/lib/postgresql/data"]`.
  Add three AS-IS cases:
  - no resolver supplied → `["pg-data:/var/lib/postgresql/data"]` AS-IS;
  - resolver returns `undefined` for the name → AS-IS;
  - absolute host path `["/srv/data:/data"]` → AS-IS (left segment starts
    with `/`, resolver NOT consulted);
  - bare name `["data"]` (no `:`) → AS-IS.
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (current code copies `svc.volumes` verbatim).
- [ ] Minimal impl: introduce a single shared async helper (test-reachable
  only if needed via `_`-prefix; otherwise a private closure) that maps one
  `svc.volumes` entry to its effective bind:
  - split on the FIRST `:` into `[left, ...rest]`; `containerPath = rest.join(":")`;
  - if `rest.length === 0` (bare name) → return entry AS-IS;
  - if `left` starts with `/` (absolute host path) → return entry AS-IS;
  - if no `resolveVolumeMount` → return entry AS-IS;
  - `const mount = await resolveVolumeMount(left)`; if `mount === undefined`
    → AS-IS; else return `` `${mount}:${containerPath}` ``.
  Make `createBody` async-map `svc.volumes` through this helper before
  setting `HostConfig.Binds`. Preserve the conditional `RestartPolicy`
  MERGE so it does not clobber resolved `Binds`. Narrow indexed access per
  `noUncheckedIndexedAccess`.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): resolve volume-name binds to Hetzner mount in createBody (3.2)`

### Task 3.3 — `isConverged` resolves binds the SAME way (no-op lock)

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `isConverged` ~:533-538 Binds
  comparison; reuse the F3.2 helper).
- [ ] Familiarise: re-read `docker.ts:533-538` (`wantBinds = [...(svc.volumes ?? [])]`
  vs `haveBinds = inspect HostConfig.Binds`). Confirm `isConverged` is
  already `async`.
- [ ] Failing test (add to `docker.test.ts`) — the IDEMPOTENCY LOCK:
  - seed the docker fake so the existing container's inspect reports
    `HostConfig.Binds = ["/mnt/HC_Volume_42:/var/lib/postgresql/data"]`
    (the RESOLVED form, i.e. what create wrote);
  - with `resolveVolumeMount = async (n) => n === "pg-data" ? "/mnt/HC_Volume_42" : undefined`
    and desired `volumes: ["pg-data:/var/lib/postgresql/data"]`,
    assert a full re-apply is a NO-OP (no container re-create — assert via
    the fake's create-call counter staying flat / `isConverged` truthy).
  - regression: with NO resolver, desired `["data"]` and inspect
    `Binds = ["data"]` still converges (AS-IS path unchanged).
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (`wantBinds` holds the unresolved `"pg-data:..."`, `haveBinds` holds the
  resolved `"/mnt/HC_Volume_42:..."`, so they mismatch → re-create flap).
- [ ] Minimal impl: in `isConverged`, build `wantBinds` by mapping
  `svc.volumes` through the SAME helper from 3.2 (await it) BEFORE the
  length/element comparison against `haveBinds`. No change to the
  comparison logic itself.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Sanity: run the full provider suite `npm --prefix core test -- docker`
  to confirm no existing bind/secret test flapped.
- [ ] Commit: `fix(core): isConverged resolves binds symmetrically — re-apply no-op (3.3)`

**Done (F3) =** `createBody` and `isConverged` resolve
`<name>:<container_path>` binds through one shared helper; resolver-present
→ `/mnt/HC_Volume_<id>:<path>`; absent/undefined/absolute/bare → AS-IS;
explicit re-apply-no-op test green; secret golden untouched.

---

# Fase 4 (F4) — composition-root wiring (observed-store resolver)

**Phase goal:** `entrypoint-wiring.ts` supplies a real
`resolveVolumeMount` backed by the observed-state store, so the running
daemon resolves Hetzner mounts; isolation tests that omit it keep AS-IS
behaviour. **Deliverable:** wired resolver + first-cycle semantics.
**Exit criteria:** F4 tests green; absent observed volume → `undefined`
(bind AS-IS, converges next cycle); typecheck clean.

### Task 4.1 — wire `resolveVolumeMount` to `getState(pool, "volume")`

- Files: `core/src/entrypoint-wiring.test.ts` (modify),
  `core/src/entrypoint-wiring.ts` (modify the `createDockerProvider({ ... })`
  call ~:237).
- [ ] Familiarise: read `entrypoint-wiring.ts:232-239` (where
  `dockerTransport` is built and `createDockerProvider({ transport })` is
  called) and `core/src/store/observed-store.ts` (`getState(pool, scope)`
  returns a `State`; the volume scope is `"volume"`, confirmed by
  `reconcile.ts:406` `putObservedState(pool, "volume", ...)`). Confirm the
  `pg.Pool` available in the wiring scope.
- [ ] Failing test (add to `entrypoint-wiring.test.ts`): build the wired
  deps against a fake/seeded observed store where volume `pg-data` has
  `hcloud_id = 42`; assert the `resolveVolumeMount("pg-data")` passed into
  the docker provider returns `/mnt/HC_Volume_42`; assert
  `resolveVolumeMount("absent")` returns `undefined`; assert a volume row
  present but WITHOUT `hcloud_id` (first cycle, not yet assigned) returns
  `undefined`.
  - Use the existing wiring-test harness pattern (grep
    `entrypoint-wiring.test.ts` for how it stubs `pool` / observed reads).
    If the test needs a seam to inject observed reads, inject the
    observed-read function rather than a live pool (keep it fakes-only).
- [ ] Run `npm --prefix core test -- entrypoint-wiring.test.ts` → expect
  FAIL (no `resolveVolumeMount` wired).
- [ ] Minimal impl: pass `resolveVolumeMount` into `createDockerProvider`:
  ```
  resolveVolumeMount: async (name) => {
    const { volumes } = await getState(pool, "volume");
    const v = volumes.find((x) => x.name === name);
    if (v?.hcloud_id === undefined) return undefined;
    return `/mnt/HC_Volume_${v.hcloud_id}`;
  }
  ```
  Import `getState` from `./store/observed-store.js`. Narrow `v` and
  `v.hcloud_id` per `noUncheckedIndexedAccess`. No `console.*`.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): wire resolveVolumeMount to observed volume store (4.1)`

**Done (F4) =** production daemon resolves `/mnt/HC_Volume_<hcloud_id>`
from observed state; missing volume / missing `hcloud_id` → `undefined`
(bind AS-IS, converges next cycle — non-atomic, per spec §7.4); isolation
tests that omit the seam stay AS-IS.

---

# Fase 5 (F5) — idempotency property + docs (CAPSTONE)

**Phase goal:** Prove end-to-end convergence + no-op stability over the
resolved-bind path under the DB-backed property harness, confirm the
secret golden is byte-identical, and document the operator-facing format.
**Deliverable:** extended idempotency property + CHANGELOG + cheatsheet.
**Exit criteria:** full suite green (expected count + 1 `@live` skipped);
property holds; secret golden unchanged; docs updated.

### Task 5.1 — idempotency property covers the resolved bind

- Files: `core/src/reconciler/idempotency.property.test.ts` (modify).
- [ ] Familiarise: read `idempotency.property.test.ts` (DB-backed; uses
  `core/test/fakes/pg-harness.ts`, `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`).
  Identify how it builds providers with fakes and how it seeds desired +
  observed state across two reconcile cycles.
- [ ] Failing test (extend the property / add a scenario): a manifest with
  a volume `pg-data` (observed with `hcloud_id`) and a service
  `volumes: ["pg-data:/var/lib/postgresql/data"]`, wired with a
  `resolveVolumeMount` returning `/mnt/HC_Volume_<id>`, converges on cycle
  1 and emits ZERO mutating actions on cycle 2 (re-apply no-op). Assert the
  observed container bind is the RESOLVED form.
- [ ] Run `npm --prefix core test -- idempotency.property.test.ts`
  (Postgres on 5546 up) → expect FAIL until the F3 symmetry is exercised
  end-to-end (or PASS-by-construction if F3 already covers it — in that
  case widen the property's volume generator to include `<name>:<path>`
  forms so the assertion is load-bearing, then confirm red→green by
  temporarily reverting F3.3 locally; do NOT commit the revert).
- [ ] Minimal impl: no production change expected (F3 already implements
  it); this task LOCKS the guarantee at the reconciler property layer. If a
  gap surfaces, fix it test-first here.
- [ ] Run → expect PASS.
- [ ] Guard: run `npm --prefix core test -- secret-apply.test.ts` and
  confirm it is GREEN and the file is byte-identical (no edit).
- [ ] Commit: `test(core): idempotency property over resolved volume bind (5.1)`

### Task 5.2 — CHANGELOG + cheatsheet (format + advisory mount_path)

- Files: `CHANGELOG.md` (modify), `docs/manifest-schema-cheatsheet.md` (modify).
- [ ] Familiarise: read the top entry of `CHANGELOG.md` and the
  `service.volumes` section of `docs/manifest-schema-cheatsheet.md`.
- [ ] No test (docs-only; exempt per `.claude/rules/specs-first.md`
  "trivial / docs" and `tdd-required.md` out-of-scope).
- [ ] Edit: document the `service.volumes: ["<volume-name>:<container_path>"]`
  format; that the named volume is a declared Hetzner volume persisted at
  `/mnt/HC_Volume_<id>` via Hetzner automount; that `mount_path` is
  ADVISORY/doc-only (not honoured — automount fixes the path); that bare
  names and absolute host-path binds still work AS-IS; cite spec
  `2026-06-01-volume-hetzner-bind-automount.md`.
- [ ] Run `npm --prefix core run typecheck` (no-op sanity) and full
  `npm --prefix core test` → expected green.
- [ ] Commit: `docs: volume bind format + advisory mount_path (5.2)`

**Done (F5) =** reconciler idempotency property covers the resolved-bind
path (cycle 2 no-op); secret golden byte-identical; CHANGELOG +
cheatsheet document the format and the advisory `mount_path`.

---

## Acceptance criteria (spec §5)

- [ ] `npm --prefix core run typecheck` clean; full suite green (expected
      count + 1 `@live` skipped).
- [ ] Bug 9: planner validates the volume NAME; `name:container_path`
      accepted; `["data"]` retro-compatible (F1).
- [ ] Volume create sends `automount: true`; never reformats; `mount_path`
      unsent (F2).
- [ ] Bind resolved to `/mnt/HC_Volume_<id>:<path>` when the volume is
      declared/observed; AS-IS otherwise; `isConverged` stable (re-apply
      no-op) (F3, F4).
- [ ] Idempotency property covers the path; secret golden byte-identical (F5).
- [ ] CHANGELOG + cheatsheet updated (F5).

---

## Riscos (spec §6)

1. **Idempotency of the resolved bind (HIGH — #1).** `isConverged` MUST
   resolve binds identically to `createBody`; asymmetry → infinite
   re-create. Mitigation: single shared helper (F3.2), explicit
   re-apply-no-op test (F3.3), DB-backed property (F5.1).
2. **First-cycle non-atomic (MEDIUM).** If the volume is not yet observed,
   the bind goes AS-IS and converges on the NEXT cycle (accepted, spec
   §7.4). The volume→service dep ordering (F1) ensures the volume is
   created first; the mount resolves once the volume row carries
   `hcloud_id`. Surfaced in F4.1 tests.
3. **Data-safety (LOW, by design).** Automount formats only the NEW
   volume, once, by Hetzner; re-attach never reformats. This plan emits no
   `mkfs`/delete/detach. Documented in F5.2. This is precisely why
   automount was chosen over mkfs-via-SSH.
4. **Cross-provider coupling (LOW).** Docker reads the observed VOLUME
   state via the wiring seam — it does NOT call the Hetzner provider. The
   seam is observed-store-backed (F4), keeping providers decoupled.
5. **`mount_path` expectation (LOW).** Operators may expect `mount_path`
   honoured; it is advisory under automount. Documented in F5.2.

## Rollback

Each task is one commit; rollback is `git revert` of the offending
commit(s), independently per phase:

- **F1 / F2 are independent and additive** — reverting either restores
  prior behaviour with no cross-dependency.
- **F3 is the only behaviourally-coupled phase**: revert 3.3 then 3.2
  (then 3.1 if split) to remove bind resolution entirely; `isConverged`
  and `createBody` fall back to verbatim `svc.volumes` (today's
  behaviour). Because the seam is OPTIONAL, reverting F4 alone (un-wiring
  `resolveVolumeMount`) also fully neutralises the feature in production
  while leaving the code dormant and AS-IS.
- **F5** is property + docs — reverting drops the extra coverage/docs only.

No migration, no contract change ⇒ no data or wire rollback concerns. No
destructive operation is ever issued, so there is nothing to clean up on
revert.

---

## Fora de escopo / depende de credenciais reais

- Honouring a literal `mount_path` (symlink via `user_data` is a possible
  follow-up; out of scope here — `mount_path` is advisory under automount).
- Volume binds for `server` or other kinds; Docker named (non-Hetzner)
  volumes.
- Atomic first-cycle resolution within a single apply (spec §7.4 accepts
  next-cycle convergence).
- Any `@live` Hetzner volume test — not added by this plan.

## Done = (per phase, summary)

- **F1:** planner validates the volume NAME (`split(":")[0]`);
  `name:container_path` accepted; `["data"]` retro-compatible.
- **F2:** volume create sends `automount: true`; `mount_path` unsent;
  never reformats.
- **F3:** `createBody` + `isConverged` resolve binds symmetrically via one
  helper; resolver-present → real mount; absent/undefined/absolute/bare →
  AS-IS; re-apply no-op locked.
- **F4:** composition root wires `resolveVolumeMount` to the observed
  volume store; missing volume/`hcloud_id` → AS-IS; first-cycle non-atomic.
- **F5:** idempotency property covers the resolved bind; secret golden
  byte-identical; CHANGELOG + cheatsheet document the format.
