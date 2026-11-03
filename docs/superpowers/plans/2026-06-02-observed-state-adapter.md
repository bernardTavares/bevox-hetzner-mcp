# Observed-state adapter (get_state/diff reflect reality) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Goal:** `GET /api/state` returns the REAL cluster — the running servers,
networks, volumes and services — and `GET /api/diff` proposes `create`
ONLY for entities that genuinely do not exist. After this plan the
reconciler's Observe step turns the live probe (`HetznerCloudProvider.observe`
listing all servers/networks/volumes, `DockerProvider.observe` listing all
`bevox.managed` containers) into a typed, Zod-validated `State` snapshot,
persists it every cycle, and `buildBootDeps` wires the REAL adapter so
production never again falls into the empty-stub fallback. This is
**observe-only, non-destructive, idempotent** (spec Part 1): re-observing
unchanged reality yields a byte-identical `State` ⇒ cycle 2 is a strict
no-op. The known volume-model divergence (manifest declares Hetzner volumes;
reality uses Docker named volumes) now surfaces as `result:"drift"` —
REPORTED, never corrected (resolution deferred to Part 2). No resolved
secret value ever enters the persisted snapshot or the `get_state` response.

**Architecture:** Two coordinated surfaces plus the wiring that connects
them. (1) The `ObservedSlice` contract (`providers/provider.ts`) is enriched
from `entities: readonly string[]` to
`entities: ReadonlyArray<{ key: string; payload: unknown }>` (Q1) — the key
survives, a validatable payload rides alongside. Every `observe()` impl and
every consumer of `slice.entities` migrates in lockstep (the type change is
compile-breaking by nature, so the shape and its three production consumers
move atomically). (2) A new PURE module
`core/src/reconciler/observed-adapter.ts` (Q2) maps a slice to a `State`:
derive the kind from the key prefix, `safeParse` the payload against the
`entities.ts` Zod schema, push valid objects into the matching collection,
and SKIP (never throw — Q3) any payload that fails validation. (3)
`buildBootDeps` (`entrypoint-wiring.ts`) sets `BootDeps.observedAdapter` to
this real adapter — the field it NEVER set, which is the root-cause
regression (same class as the "Bug 10" wiring miss). The `server.ts:420-429`
empty-stub fallback stays as a TEST-ONLY default (Q6); production always
threads the real adapter. The composite union dedups by `key`, first-wins
(Q4). HetznerCloud and Docker carry rich observed objects; the
desired-derived providers (DNS / WireGuard / Backup / v2-wrap) emit minimal
`{ name }`-shaped payloads that either validate or are degrade-safe-skipped.

**Tech Stack:** Inherits the v1 ratified stack unchanged (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`,
PostgreSQL 16 via `pg`, Hetzner Cloud HTTP over `fetch`, Docker Engine API
over SSH, Zod, Pino, Vitest + HTTP fakes). **Zero new dependencies.** No new
console contract field, no new MCP tool, no new REST endpoint, no new
migration, no new `StateEvent` write-site — additive enrichment of the
internal `ObservedSlice` over existing `entities.ts` schemas and FROZEN
invariants.

**Specs:**
- This spec: `docs/specs/2026-06-02-observed-state-adapter.md` (Status: Aceita)
- Sibling cause-of-bug class (wiring regression precedent — "Bug 10"):
  `docs/specs/2026-06-01-docker-provider-bootstrap-and-verify.md`
- v2 contract (FROZEN): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- v1 base (FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Apply-manifest meta-scope fan-out (the `scope === "manifest"` partition
  the adapter feeds): `docs/specs/2026-05-26-apply-manifest-silo-fanout.md`

---

## How this plan is executed

Single plan, one ordered task list (no multi-phase split — the surfaces are
tightly coupled by the `ObservedSlice` type change, and the ORDER is
load-bearing). Each task's red test fails for the RIGHT reason and the suite
stays green between commits. The order front-loads the FAKE FIDELITY (Task 1)
so subsequent provider tests fail because production discards the rich fields,
NOT because the fake never served them; then the contract shape change with
ALL its consumers in one atomic compile-clean commit (Task 2); then each
provider's `observe()` enrichment (Tasks 3–4); then the pure adapter
(Task 5); then the composite union (Task 6); then the wiring fix (Task 7);
then the hygiene / DB-backed integration / idempotency / fail-safe / docs
capstones (Tasks 8–12).

All paths are repo-root-relative under ``.
The ONLY new production source file is
`core/src/reconciler/observed-adapter.ts` (+ its colocated `*.test.ts`);
everything else is a modification of an existing file. Do not start a task
until the previous task's commit is in and `npm --prefix core test` is green.

> **Typecheck baseline.** Two PRE-EXISTING typecheck errors live in
> `core/src/agent/v2/contract-v2-conformance.test.ts` and
> `core/src/reconciler/idempotency-load-balancer.property.test.ts`. Every
> "typecheck clean" check below means "no NEW errors beyond those two". This
> plan neither introduces nor resolves them.

> **DB-backed tests.** Tasks 10 and 11 require the disposable Postgres on
> port 5546:
> `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`
> (CONTRIBUTING §"First-time setup"). Schema reset is owned by
> `core/test/fakes/pg-harness.ts`; do not bypass it.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail for the RIGHT
  reason (assertion mismatch, not import/type error) → minimal
  implementation → run, see it pass → commit. Reference
  @superpowers:test-driven-development and `.claude/rules/tdd-required.md`.
- **DRY / YAGNI / minimal change**: build only what each task needs; no
  speculative abstraction (no `import_state`/adopt path, no volume
  source-of-truth migration, no new wire field — all explicitly out of
  scope, Part 2). Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Conventional Commits.
  Mandatory trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  spec: 2026-06-02-observed-state-adapter.md (task N)
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: Hetzner Cloud via
  `core/test/fakes/hetzner-http.ts`; Docker Engine via
  `core/test/fakes/docker-http.ts`; DB-backed tests via
  `core/test/fakes/pg-harness.ts` (Postgres on port 5546). No `@live`
  surface is added by this plan.
- **Secret hygiene (load-bearing — new leak surface)**: the persisted
  observed snapshot and the `get_state` response are now NON-EMPTY, so they
  become a NEW leak surface. A Docker service env bound to a secret stays a
  `secret:<ref>` reference / `bevox.secret.<k>` label — NEVER a resolved
  value. The adapter is pure and carries no `ApplyContext` token, so it is
  STRUCTURALLY incapable of resolving a secret. Reference
  `.claude/rules/secrets-resolution.md` ("observed-state storage … references
  only").
- **Secret golden byte-identical**: `core/src/reconciler/secret-apply.test.ts`
  and `core/src/store/secrets.ts` are NOT touched by this plan (the observe /
  adapter path never reaches the apply / env-injection channel). Guarded in
  the capstone.
- **Fail-safe, never fail-deleting**: the observe / adapter path adds NO
  `delete`/`destroy`/`remove`/`detach` call and cannot drive a terminate. A
  truer observed state only changes what `plan` / drift SEE;
  `apply(op:"destroy")` stays a no-op; an observed-but-not-desired resource
  yields `result:"drift"`, never a destruction. Reference
  `.claude/rules/fail-safe.md`.
- **Degrade-safe per-entity (Q3)**: a payload that fails Zod is SKIPPED, not
  fatal — one malformed resource never drops the cycle. The resulting `State`
  always satisfies `StateSchema.parse`. Mirrors the degrade-safe read at
  `reconcile.ts:366-387`.
- **No silent drift correction** — drift is reported, never corrected.
- **ESM/NodeNext hygiene**: `.js` import extensions, `import type` for
  type-only imports, narrow indexed access (`noUncheckedIndexedAccess`), Zod
  on every payload (no `as` on a wire-ish object), no `console.*` in
  `core/src/`, `_`-prefix any test-only export (Rule 8). Reference
  `.claude/rules/esm-nodenext.md`.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — no contract change

This plan is **additive and console-contract-neutral**:

- No new wire field on any console contract (`contract.ts` / `contract-v2.ts`).
  `get_state` keeps returning `Server[]` / `Network[]` / `Volume[]` /
  `Service[]` / `DnsRecord[]` / `BackupPolicy[]` exactly as today; the
  adapter produces objects valid per `core/src/domain/entities.ts`, which
  mirrors the console contract field-for-field (`entities.ts:5-9`). **Flag
  for contract-oracle review; goal: ZERO new wire field** (spec §3 C1).
- `ObservedSlice` is an INTERNAL type (`providers/provider.ts`), NOT the
  console contract — safe to change shape.
- No new MCP tool, no new REST endpoint, no new migration.
- No change to any `StateEvent` write-site (`core/src/reconciler/**` and
  `core/src/store/**` write-sites untouched); the `actor` channel is
  unchanged. The reconcile persistence path (`reconcile.ts:388-411`) gains
  no new line — it simply receives a non-empty `observed` because the adapter
  is now real.
- The `server.ts:420-429` empty-stub fallback STAYS (Q6) — it remains the
  TEST-ONLY default for isolation tests that pass no adapter. Production is
  always cabled via `buildBootDeps`, so the `?? (() => EMPTY)` branch is
  never taken in the daemon.

---

## Non-negotiable principles (this plan)

All v1/v2 invariants apply unchanged. The load-bearing ones here (spec §3):

1. **L1 — observed snapshot carries refs, never values.** The Docker
   observe → Service payload maps a secret-bound env to its
   `secret:<ref>` / `bevox.secret.<k>` label (the 3.2 channel), never a
   resolved value. The adapter is pure and token-free ⇒ structurally cannot
   resolve. Locked by Task 8's sentinel.
2. **L2 — no destroy path added.** The adapter is pure `(slice) => State`;
   observe is read-only; a truer observed state only changes what
   `plan` / drift SEE. `apply(op:"destroy")` stays a no-op
   (`provider.ts:159-168`); drift is `result:"drift"`
   (`reconcile.ts:360-374`), never a delete. Locked by Task 11.
3. **L3 — secret golden + `secrets.ts` byte-identical.** This plan does not
   touch the env-injection / apply path. Guarded in Task 12.
4. **L4 — persisted snapshot satisfies `StateSchema.parse` (degrade-safe).**
   The adapter validates each payload by Zod and SKIPS the invalid one
   (Q3); a malformed resource never drops the cycle (mirrors the
   degrade-safe read at `reconcile.ts:366-387`). Locked by Task 5.
5. **I2 — idempotency.** Pure adapter + `putObservedState` full-replace ⇒
   re-observing unchanged reality = byte-identical `State` ⇒ cycle 2 is a
   strict no-op. Locked by Task 10.

---

## Testing strategy

| Layer | How | Covers |
|---|---|---|
| Fake fidelity (Hetzner) | `core/test/fakes/hetzner-http.ts` + sibling `hetzner-http.test.ts` | `GET /v1/{servers,networks,volumes}` list serves the RICH wire fields (server_type / public_net / status; network ip_range / subnets; volume size / linux_device / server / status), via a seed seam — the thin fake masked the discard |
| Fake fidelity (Docker) | `core/test/fakes/docker-http.ts` + sibling test | container list (`all=true`) exposes the labels/env needed to build a Service payload incl. the `bevox.secret.<k>` channel; confirm or extend |
| `ObservedSlice` shape + consumers | `provider.test.ts`, `composite-provider.test.ts`, the 7 inline test adapters | shape is `{ key, payload }[]`; `conformanceHarness` (`provider.ts:245`) checks `e.key`; composite dedup (`:186`/`:229`) keys by `e.key`; all `observe()` fakes emit `{ key, payload }` |
| HetznerCloud observe enriched | `hetzner-cloud.test.ts` + hetzner fake | `observe()` returns entries whose `payload` is an `entities.ts`-shaped server/network/volume object (`listAll` deserialization widened via a wire Zod schema) |
| Docker observe enriched | `docker.test.ts` + docker fake | `observe()` returns a Service `payload`; a secret-bound env is a ref/label, NEVER a resolved value |
| Adapter unit (happy + degrade) | `observed-adapter.test.ts` (NEW) | multi-kind slice → Zod-validated `State`; malformed/unknown payload SKIPPED (degrade-safe, never throws); result satisfies `StateSchema.parse` |
| Composite union enriched | `composite-provider.test.ts` | union of enriched slices across backends; dedup by `key`, first-wins; per-backend value-free fault tolerance preserved byte-identical |
| Wiring regression guard | `entrypoint-wiring.test.ts` | `buildBootDeps` sets `observedAdapter` to the REAL adapter; a probe with live fakes flows through to a NON-EMPTY `State` (mirrors the Bug 10 regression guard) |
| Secret hygiene sentinel | `docker.test.ts` (+ adapter test) | persisted snapshot + `get_state` response contain ZERO resolved secret value (sentinel string) |
| Reconcile integration (DB-backed, :5546) | `reconcile.test.ts` (extend) | observe persists a NON-EMPTY snapshot; `get_state` returns it; with desired matching observed, `diff` is empty / noop |
| Idempotency property (DB-backed, :5546) | `idempotency.property.test.ts` (extend) | non-empty observed reality converges; cycle 2 strict no-op; snapshot byte-stable |
| Fail-safe guard | `drift.test.ts` or `reconcile.test.ts` (extend) | observed-but-not-desired resource ⇒ `result:"drift"`, never a destroy; `apply(op:"destroy")` no-op |
| Secret golden | `secret-apply.test.ts` + `secrets.ts` | UNCHANGED, byte-identical (assert; do not edit) |

CI runs unit + property with fakes on every commit. No real infra. No
`@live` surface added.

---

## File structure (touched files — only the adapter is new)

```
core/
  src/
    providers/
      provider.ts                      MODIFIED  ObservedSlice → { key, payload }[]; ObservedEntity iface; conformanceHarness :245 checks e.key
      provider.test.ts                 MODIFIED  inline observe() fakes emit { key, payload }
      hetzner-cloud.ts                 MODIFIED  observe() :189-196 emits { key, payload }; listAll :126-133 widened via wire Zod schema → entities.ts-shaped payload
      hetzner-cloud.test.ts            MODIFIED  observe payload assertion
      docker.ts                        MODIFIED  observe() :750-759 emits { key, payload } Service (secret env = ref/label only)
      docker.test.ts                   MODIFIED  observe payload + secret-hygiene cases
      wireguard.ts                     MODIFIED  observe() :304 emits { key, payload } ({ name })
      backup-restic.ts                 MODIFIED  observe() :281 emits { key, payload }
      hetzner-dns.ts                   MODIFIED  observe() :220 emits { key, payload }
    reconciler/
      observed-adapter.ts              NEW       pure (slice) => State; Zod-validate per kind; SKIP invalid (degrade-safe)
      observed-adapter.test.ts         NEW       happy multi-kind + malformed-skipped
      composite-provider.ts            MODIFIED  union dedup by e.key, first-wins (:186, :229)
      composite-provider.test.ts       MODIFIED  enriched-union case
      v2-wrap.ts                       MODIFIED  observe() :120-129 emits { key, payload } ({ name })
      reconcile.test.ts                MODIFIED  DB-backed non-empty snapshot + diff-noop; fail-safe drift guard
      idempotency.property.test.ts     MODIFIED  non-empty observed convergence; lift makeObservedAdapter (:183) → import real adapter
      secret-apply.test.ts             UNCHANGED (assert byte-identical — guard, do not edit)
    entrypoint-wiring.ts               MODIFIED  buildBootDeps return :421-431 sets observedAdapter to the real adapter
    entrypoint-wiring.test.ts          MODIFIED  wiring regression guard
    server.ts                          UNCHANGED stub-fallback :420-429 stays test-only (Q6 — verify, do not edit)
    store/secrets.ts                   UNCHANGED (FROZEN — assert untouched)
    agent/
      rest.test.ts                     MODIFIED  inline observedAdapter + observe fakes → { key, payload }
      mcp.test.ts                      MODIFIED  same
      tools.test.ts                    MODIFIED  same
      contract-conformance.test.ts     MODIFIED  same
      approval-gate.test.ts            MODIFIED  same
      apply-manifest-silo-fanout.bug5.test.ts  MODIFIED  same
      v2/resolve-selector.test.ts      MODIFIED  same
      (+ remaining inline observe() fakes across agent/ + reconciler/ tests)
CHANGELOG.md                           MODIFIED  [Unreleased] entry
```

---

# Task 1 — Fake fidelity: Hetzner list serves the rich wire fields

- Files: `core/test/fakes/hetzner-http.ts` (modify),
  `core/test/fakes/hetzner-http.test.ts` (modify); confirm
  `core/test/fakes/docker-http.ts` already exposes container labels/env
  (modify ONLY if a gap is found, with a sibling `docker-http.test.ts` case).
- [ ] Familiarise: read the fake's collection store + POST-create handler
  (`hetzner-http.ts:452-503`, which stores `{ ...payload, id, name }` and
  returns it verbatim on list/get), the `list()` route (`:189`), the
  `COLLECTIONS` map (`:112-114`), and the returned seam object (`:506-535`).
  Read `hetzner-cloud.ts:126-133` (`listAll` typed `{ id; name }` — the
  rich fields the real API returns ARE on the wire but discarded) and the
  `KINDS` map (`hetzner-cloud.ts:83-86`: `server`/`network`/`volume` →
  `{ collection, schema }`). The real API returns `server_type.name`,
  `public_net.ipv4.ip`, `status`, `image.name` for a server; `ip_range`,
  `subnets[].ip_range` for a network; `size`, `linux_device`, `server`,
  `status` for a volume — these are what observe must eventually carry.
- [ ] Failing test (add to `hetzner-http.test.ts`): seed a server / network /
  volume via a new `seed{Server,Network,Volume}(...)` seam (or extend the
  create body the existing tests POST) and assert that
  `GET /v1/servers` (resp. `/networks`, `/volumes`) returns each resource
  WITH the rich wire fields (e.g. a server with
  `server_type: { name: "cpx22" }`, `public_net: { ipv4: { ip: "1.2.3.4" } }`,
  `status: "running"`, `image: { name: "ubuntu-24.04" }`), not just
  `{ id, name }`. This is RED today only if the fake currently strips them —
  if the verbatim echo already surfaces seeded fields, make the seam
  explicit so later provider tests can rely on it (the load-bearing
  assertion is "list returns the rich fields for a seeded resource").
- [ ] Run `npm --prefix core test -- hetzner-http.test.ts` → expect FAIL
  (no seed seam / list does not expose the rich fields the provider will
  need).
- [ ] Minimal impl: add a typed `seed{Server,Network,Volume}` seam to the
  returned fake object that stores a resource with the rich wire fields, and
  ensure `list()` returns them verbatim. Clear seeded rows in `fresh()`.
  Keep the existing create/get/delete byte-identical for resources that do
  not use the new fields (back-compat).
- [ ] Docker check: grep `docker-http.ts` for the container-list handler;
  confirm `Labels` (incl. `bevox.secret.<k>`) and env are exposed on the
  `all=true` list. If a field needed for the Service payload is missing, add
  it with a red `docker-http.test.ts` case in THIS task.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): faithful hetzner fake — list serves rich server/network/volume fields (1)`

# Task 2 — Enrich `ObservedSlice` to `{ key, payload }` + migrate ALL consumers (atomic)

> **This is the big mechanical task and it is INTENTIONALLY one commit.** The
> `ObservedSlice` type change is compile-breaking by nature: the moment
> `entities` stops being `string[]`, every `observe()` impl and every
> `slice.entities` consumer fails to typecheck. They MUST move together so
> the suite compiles and stays green. Do NOT introduce a transitional
> parallel `payloads` accessor — Q1 locked the single-object form; a
> transitional shim would be dead code by the end of this task.

- Files (production): `core/src/providers/provider.ts` (shape +
  `conformanceHarness` `:245`),
  `core/src/reconciler/composite-provider.ts` (dedup `:186`, `:229`),
  `core/src/reconciler/v2-wrap.ts` (`observe()` `:120-129`),
  `core/src/providers/{hetzner-cloud,docker,wireguard,backup-restic,hetzner-dns}.ts`
  (each `observe()` wraps its existing key as `{ key, payload }` — payload
  starts MINIMAL: `{ name }`-shaped for now; the RICH payloads land in
  Tasks 3–4).
- Files (test): every file with an inline `observe()` fake or `observedAdapter`
  (grep `async observe(` and `slice.entities` / `function observedAdapter`):
  `provider.test.ts`, `composite-provider.test.ts`,
  `idempotency.property.test.ts` (its `makeObservedAdapter` at `:183-211`),
  and the 7 inline `observedAdapter` functions (`rest.test.ts:321`,
  `mcp.test.ts:207`, `tools.test.ts:182`, `contract-conformance.test.ts:213`,
  `approval-gate.test.ts:388`, `apply-manifest-silo-fanout.bug5.test.ts:93`,
  `v2/resolve-selector.test.ts:234`), plus the many inline `observe()` fakes
  across `agent/**` and `reconciler/**` tests enumerated by the grep.
- [ ] Familiarise: read `provider.ts:125-134` (current
  `ObservedSlice { scope; entities: readonly string[] }`) and `:243-254`
  (`conformanceHarness` `obs.entities.includes(action.entity)`); read the
  composite union (`composite-provider.ts:173-231`) — both `seen` Sets and
  the per-backend value-free `console.warn` (`:199-213`) must stay
  byte-identical except for keying; read `idempotency.property.test.ts:183`
  (`makeObservedAdapter` is the prototype — note it reads `slice.entities`
  as strings today). Build the exhaustive consumer list with
  `Grep "slice\.entities" / "\.entities\b" / "async observe\(" / "function observedAdapter"`.
- [ ] Failing test: pick the SMALLEST load-bearing red — extend
  `provider.test.ts` so a fake provider's `observe()` returns
  `entities: [{ key: "server:web", payload: { ... } }]` and
  `conformanceHarness(..., scope)` accepts it (the harness must match by
  `e.key === action.entity`). This fails to TYPECHECK against the current
  `string[]` shape — that compile break IS the red across the suite.
- [ ] Run `npm --prefix core test -- provider.test.ts` → expect FAIL
  (type mismatch: `{ key, payload }` not assignable to `string`).
- [ ] Minimal impl:
  - `provider.ts`: add
    `export interface ObservedEntity { readonly key: string; readonly payload: unknown; }`
    and change `ObservedSlice.entities` to `ReadonlyArray<ObservedEntity>`;
    update the doc-comment (`:125-130`). In `conformanceHarness` change
    `obs.entities.includes(action.entity)` (`:245`) to
    `obs.entities.some((e) => e.key === action.entity)`.
  - `composite-provider.ts`: change both `seen: Set<string>`
    (`:173`, `:226`) to `Map<string, ObservedEntity>` keyed by `e.key`;
    dedup FIRST-WINS (Q4 — `if (!seen.has(e.key)) seen.set(e.key, e)`); the
    final `[...seen]` becomes `[...seen.values()]`. Keep the value-free
    `console.warn` fault path (`:199-213`) byte-identical.
  - Every production `observe()` (`hetzner-cloud.ts:193-196`,
    `docker.ts:754-759`, `wireguard.ts:313-318`, `hetzner-dns.ts:228-238`,
    `backup-restic.ts:296-300`, `v2-wrap.ts:124-128`): wrap each existing
    key string into `{ key, payload }`. For THIS task the payload is the
    MINIMAL object the provider already has (e.g. `{ name }` derived from the
    key, or the desired-derived name); rich payloads come in Tasks 3–4. Keep
    each key string byte-identical to today.
  - Every inline test `observe()` fake and every `observedAdapter` function:
    emit / read `{ key, payload }`. For the inline `observedAdapter`s,
    `.filter((e) => e.key.startsWith("server:"))` and read fields from
    `e.payload` (or keep their synthesised fixtures, deriving `name` from
    `e.key`). For `makeObservedAdapter` in `idempotency.property.test.ts`,
    iterate `slice.entities` as `{ key, payload }` and prefer `e.payload`
    over the external `payloadOf` map (it can fall back to `payloadOf(e.key)`
    while the migration settles).
- [ ] Run → expect PASS. Run the FULL suite `npm --prefix core test` (this
  task touches ~40 sites — the whole suite is the regression gate).
  `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `refactor(core): ObservedSlice carries { key, payload }; migrate all consumers (2)`

# Task 3 — HetznerCloud observe emits the rich payload (wire Zod schema)

- Files: `core/src/providers/hetzner-cloud.test.ts` (modify),
  `core/src/providers/hetzner-cloud.ts` (modify `listAll` `:126-133` and
  `observe()` `:189-196`).
- [ ] Familiarise: re-read `listAll` (`:126-133`, typed
  `Array<{ id; name }>` via `getAllPages<{ id; name }>`) and `observe()`
  (`:189-196`, mapping to `${kind}:${r.name}` strings). Read the `entities.ts`
  target shapes: `ServerSchema` (`entities.ts:31-50` — `type`, `location`,
  `image`, `network`, `status`, optional `hcloud_id`), `NetworkSchema`
  (`:53-59` — `ip_range`, `subnets`), `VolumeSchema` (`:62-71` — `size`,
  `fs`, optional `server`/`status`/`hcloud_id`). Note the WIRE field names
  differ (`server_type.name`, `public_net`, `linux_device`, …) — observe
  must MAP wire → `entities.ts` shape.
- [ ] Failing test (add to `hetzner-cloud.test.ts`): seed the fake (Task 1)
  with a server / network / volume carrying rich fields; assert that
  `observe("server")` (resp. network, volume) returns an entry whose
  `payload` is an `entities.ts`-shaped object (e.g. server payload has
  `type` from `server_type.name`, `image` from `image.name`,
  `hcloud_id` from `id`), and that `ServerSchema.safeParse(payload).success`
  is `true`. The `key` stays `${kind}:${name}` (byte-identical to Task 2).
- [ ] Run `npm --prefix core test -- hetzner-cloud.test.ts` → expect FAIL
  (payload is still the minimal `{ name }` from Task 2; the rich fields are
  not mapped).
- [ ] Minimal impl:
  - Add a per-kind WIRE Zod schema near `KINDS` (a `z.object` capturing only
    the fields observe needs — `server_type`, `public_net`, `status`,
    `image`, `ip_range`, `subnets`, `size`, `linux_device`, `server` — each
    `.optional()` / lenient so a partial real response degrades, never
    crashes). Widen `listAll` to `getAllPages<unknown>` then `safeParse`
    each row through the wire schema; on parse failure, fall back to the
    minimal `{ id, name }` row (degrade-safe — observe never throws on a
    surprising wire shape). KEEP `findByName` working (it only needs
    `id`/`name`).
  - In `observe()`, map each wire row → an `entities.ts`-shaped payload for
    its `kind` (server: `{ name, type, location?, image, network?, status, hcloud_id }`;
    network: `{ name, ip_range, subnets, hcloud_id }`; volume:
    `{ name, size, fs, server?, status?, hcloud_id }`). Emit
    `{ key: ${kind}:${name}, payload }`. No `as` on the wire — Zod only.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): hetzner observe carries rich server/network/volume payload (3)`

# Task 4 — Docker observe emits the Service payload (secret as ref/label only)

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `observe()` `:750-759`).
- [ ] Familiarise: re-read `observe()` (`:750-759`, `listManaged()` with
  `all=true`, dedupes replicas by the `L_SERVICE` label) and the
  `resolveSecretEnv` neighbourhood (`:740-744`) to see how a secret env is
  modelled as `secret:<ref>` and the `bevox.secret.<k>` label channel — the
  observe path must surface the REF/label, NEVER call `secretResolver`.
  Read `ServiceSchema` (`entities.ts:74-127` — `name`, `image`, `replicas`,
  optional `command`/`env`/`ports`/`volumes`).
- [ ] Failing test (add to `docker.test.ts`): seed the docker fake with a
  managed container whose labels/env include a secret-bound env via the
  `bevox.secret.<k>` channel; assert `observe("service")` returns an entry
  whose `payload` is a `ServiceSchema`-valid object (`name`, `image`,
  `replicas` derived from the observed replica count), AND that the
  secret-bound env value in the payload is the `secret:<ref>` reference /
  label — NOT a resolved value (use a sentinel value seeded ONLY behind the
  resolver to prove observe never touches it).
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (payload is the minimal `{ name }` from Task 2; no Service shape; no env
  channel surfaced).
- [ ] Minimal impl: in `observe()`, for each distinct service build a
  `ServiceSchema`-shaped payload from the observed containers (name from
  `L_SERVICE`, image from the container `Image`, `replicas` from the deduped
  count, env reconstructed with secret-bound keys as their `secret:<ref>` /
  label value). Emit `{ key: ${SCOPE}:${service}, payload }`. NEVER call
  `secretResolver` here — observe carries no `ApplyContext`.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): docker observe carries Service payload (secret stays a ref) (4)`

> **Note on the desired-derived providers.** DNS (`hetzner-dns.ts:220`),
> WireGuard (`wireguard.ts:304`), Backup (`backup-restic.ts:281`) and
> `v2-wrap.ts:120` derive their entity keys from declared / desired sources,
> NOT from a rich observed object. They keep emitting a MINIMAL
> `{ name }`-shaped payload (from Task 2). When the adapter (Task 5)
> `safeParse`s a `{ name }` against e.g. `DnsRecordSchema` and it fails the
> richer required fields, the entity is degrade-safe-SKIPPED (Q3) — correct
> and expected; those scopes are reconciled per-entity via `verify()`, not
> via the observed snapshot. Do NOT fabricate fields to force them through.

# Task 5 — The pure adapter `observed-adapter.ts`

- Files: `core/src/reconciler/observed-adapter.ts` (NEW),
  `core/src/reconciler/observed-adapter.test.ts` (NEW).
- [ ] Familiarise: read the prototype `makeObservedAdapter`
  (`idempotency.property.test.ts:183-211`) — it is the EXACT shape of the
  production adapter (kind from key prefix, push into the matching
  collection). Read `entities.ts:31-180` (`ServerSchema` / `NetworkSchema` /
  `VolumeSchema` / `ServiceSchema` / `DnsRecordSchema` / `BackupPolicySchema`
  and `StateSchema`). Read the degrade-safe read fallback EMPTY State at
  `reconcile.ts:379-386` for the canonical empty shape.
- [ ] Failing test (add to `observed-adapter.test.ts`):
  - happy multi-kind: a slice with valid server + network + volume + service
    payloads (and a dns + backup if convenient) → `observedAdapter(slice)`
    returns a `State` whose collections contain those validated objects, and
    `StateSchema.parse(result)` succeeds;
  - degrade-safe: a slice containing one malformed payload (e.g. a server
    payload missing `image`, or an `unknown`/`null` payload) ⇒ that entity
    is ABSENT from the result, the VALID siblings are present, the call does
    NOT throw, and `StateSchema.parse(result)` still succeeds;
  - kind routing: an entry whose key has an UNKNOWN prefix (e.g.
    `firewall:x` — no `entities.ts` collection) is skipped, not fatal;
  - determinism: the same slice ⇒ a deeply-equal `State` (idempotency
    precondition).
- [ ] Run `npm --prefix core test -- observed-adapter.test.ts` → expect FAIL
  (module does not exist).
- [ ] Minimal impl: `export function observedAdapter(slice: ObservedSlice): State`.
  Start from the EMPTY State; for each `entity` of `slice.entities`: derive
  `kind = entity.key.slice(0, entity.key.indexOf(":"))`; pick the matching
  Zod schema + target collection by `kind`; `schema.safeParse(entity.payload)`;
  on success push `parsed.data`; on failure SKIP (optionally a value-free
  structured log of `{ kind, key }` — NEVER the payload, which could carry a
  `secret:<ref>` or sensitive material). Unknown kind ⇒ skip. Pure, total,
  no I/O, no throw on the normal path. No `as` on `entity.payload` — Zod only.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): pure observed-adapter — Zod-validated, degrade-safe per entity (5)`

# Task 6 — Composite union over enriched slices (dedup by key, first-wins)

- Files: `core/src/reconciler/composite-provider.test.ts` (modify),
  `core/src/reconciler/composite-provider.ts` (verify/strengthen the Task-2
  dedup).
- [ ] Familiarise: re-read the union (post-Task-2): the meta-scope
  `Map<string, ObservedEntity>` (`:173-222`) and the per-scope union
  (`:226-231`), plus the value-free per-backend `console.warn` fault path
  (`:199-213`).
- [ ] Failing test (add to `composite-provider.test.ts`): two fake backends
  whose `observe(scope)` each return an enriched entry with the SAME `key`
  but DIFFERENT payloads ⇒ the composite union returns ONE entry for that
  key carrying the FIRST backend's payload (first-wins, Q4); distinct keys
  ⇒ both present; a backend that THROWS during the meta-scope union is
  tolerated (the surviving backend's entries are returned, the value-free
  warn fires, no payload echoed). If Task 2 already produced first-wins, make
  these assertions LOAD-BEARING (assert the exact payload identity) and add
  the multi-backend collision case if absent.
- [ ] Run `npm --prefix core test -- composite-provider.test.ts` → expect
  FAIL (or PASS-by-construction — if PASS, the test still locks first-wins +
  fault tolerance as a regression guard; confirm red→green by temporarily
  flipping the dedup to last-wins locally, do NOT commit).
- [ ] Minimal impl: only if a gap surfaces — keep the
  `if (!seen.has(e.key)) seen.set(e.key, e)` first-wins dedup and the
  byte-identical value-free warn.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): composite observe union dedups enriched slices first-wins (6)`

# Task 7 — Wire the real adapter in `buildBootDeps` (the root-cause fix)

- Files: `core/src/entrypoint-wiring.test.ts` (modify),
  `core/src/entrypoint-wiring.ts` (modify the `buildBootDeps` return at
  `:421-431`). Verify `server.ts:420-429` stays AS-IS (Q6 — do NOT edit).
- [ ] Familiarise: read `entrypoint-wiring.ts:421-431` (the `BootDeps`
  return object — it sets `providers`, `loadDesired`, `writeDesired`,
  `logger`, `secretResolver`, … but NEVER `observedAdapter` — THE BUG); read
  `server.ts:171-172` (`BootDeps.observedAdapter?: (slice) => State`) and
  `:420-429` (the `deps.observedAdapter ?? (() => EMPTY)` stub). Read how
  `entrypoint-wiring.test.ts` asserts the built `BootDeps` (grep for how it
  inspects the returned object / uses fakes).
- [ ] Failing test (add to `entrypoint-wiring.test.ts`): build `BootDeps`
  via `buildBootDeps` with live fakes (hetzner + docker fakes seeded with a
  server + a service); assert `deps.observedAdapter` is DEFINED and that
  running it over a probe slice (or, end-to-end, over the composite
  `observe("server")` result) yields a NON-EMPTY `State` (the seeded server
  appears). This mirrors the Bug 10 wiring regression guard — the stub
  would return EMPTY and fail this assertion.
- [ ] Run `npm --prefix core test -- entrypoint-wiring.test.ts` → expect
  FAIL (`deps.observedAdapter` is `undefined`).
- [ ] Minimal impl: import the real `observedAdapter` from
  `./reconciler/observed-adapter.js`; add `observedAdapter` to the
  `buildBootDeps` return object (`:421-431`). No other change. The
  `server.ts:420-429` `??` fallback now never triggers in production (Q6)
  but stays for isolation tests.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `fix(core): buildBootDeps wires the real observedAdapter (7)`

# Task 8 — Secret-hygiene sentinel: no resolved value in the snapshot / get_state

- Files: `core/src/providers/docker.test.ts` (modify) and/or
  `core/src/reconciler/observed-adapter.test.ts` (modify).
- [ ] Familiarise: read how `docker.test.ts` already captures observe output
  and how the secret tests assert no-leak (grep for an existing sentinel /
  no-secret assertion pattern). Re-confirm the Task-4 secret env channel.
- [ ] Failing test: drive the Docker observe (Task 4) → adapter (Task 5)
  with a service whose env is bound to a SENTINEL secret value (e.g.
  `"S3CR3T-observed-must-never-leak"`) seeded ONLY behind a resolver the
  observe path never calls. Assert the resulting `State` (the persisted
  snapshot surface) and any captured `get_state`-equivalent payload contain
  the `secret:<ref>` / label but DO NOT contain the sentinel value anywhere.
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect PASS if
  Tasks 4/5 are correct (this is a GUARD/lock, not new behaviour). If it
  FAILS, a leak exists — fix the leaking surface (the observe path must
  surface the ref, never resolve), do NOT weaken the assertion.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): sentinel — observed snapshot carries secret refs, never values (8)`

# Task 9 — (folded) reserved

> Task 8 covers hygiene; the DB-backed integration is Task 10. This slot is
> intentionally empty to keep the capstone numbers aligned with the spec §4
> testing rows. Skip — do NOT create an empty commit.

# Task 10 — Reconcile integration (DB-backed): non-empty snapshot + diff-noop

- Files: `core/src/reconciler/reconcile.test.ts` (modify).
- [ ] Familiarise: read `reconcile.test.ts` (DB-backed via
  `core/test/fakes/pg-harness.ts`, `DATABASE_URL_TEST=…:5546`); read how it
  builds `ReconcileDeps` (the `observedAdapter` it currently injects — see
  the inline fakes) and runs a cycle. Re-read the persistence path
  (`reconcile.ts:388-411`: `slice = provider.observe(scope)` →
  `observed = observedAdapter(slice)` → `putObservedState`).
- [ ] Failing test (extend / add a scenario): wire the REAL `observedAdapter`
  (import from `observed-adapter.js`) with a composite provider over seeded
  hetzner + docker fakes (a server + a service that genuinely EXIST). Run one
  reconcile cycle; assert `getObservedState(pool, scope)` (or `get_state`)
  returns a NON-EMPTY snapshot containing the seeded server / service; then
  with desired matching observed, assert the planned `diff` is empty / all
  `noop` (no spurious `create`). This is the regression the spec's motivation
  describes — empty observed ⇒ create-everything.
- [ ] Run `npm --prefix core test -- reconcile.test.ts` (Postgres on 5546 up)
  → expect FAIL until the real adapter + enriched observe are exercised
  end-to-end (the current inline empty-ish adapter persists nothing rich).
- [ ] Minimal impl: no production change expected (Tasks 3–7 implement it);
  this task LOCKS the guarantee at the reconcile layer. Fix test-first here
  if a gap surfaces.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): reconcile persists non-empty observed; diff noop when converged (10)`

# Task 11 — Idempotency property + fail-safe drift guard (DB-backed)

- Files: `core/src/reconciler/idempotency.property.test.ts` (modify),
  `core/src/reconciler/reconcile.test.ts` or
  `core/src/reconciler/drift.test.ts` (modify for the fail-safe guard).
- [ ] Familiarise: re-read `idempotency.property.test.ts` (its
  `makeObservedAdapter` at `:183` now migrated by Task 2). Read the drift /
  fail-safe path (`reconcile.ts:350-416` shrinkage detection;
  `provider.ts:159-168` `apply(op:"destroy")` no-op contract).
- [ ] Failing test (idempotency): widen the property so the observed reality
  is NON-EMPTY (a converged manifest whose servers/services genuinely exist),
  adapted through the REAL `observed-adapter.js`. Assert cycle 1 converges
  and cycle 2 emits ZERO mutating actions, and that the persisted snapshot is
  byte-stable across cycles (deep-equal). If it PASSES by construction,
  widen the generator so the non-empty path is exercised and confirm
  red→green by temporarily reverting Task 5 locally (do NOT commit the
  revert).
- [ ] Failing test (fail-safe guard): seed an observed resource that is NOT
  in desired (the volume-model divergence, Q5 — e.g. an observed volume the
  manifest does not declare). Assert the cycle emits a `result:"drift"`
  StateEvent for it and issues NO destroy, AND that `apply(op:"destroy")`
  stays a no-op. If it passes by construction, confirm red→green by a
  temporary local change (do NOT commit).
- [ ] Run `npm --prefix core test -- idempotency.property.test.ts`
  (Postgres on 5546 up) → expect PASS (after the widen/guard above).
- [ ] Guard: `npm --prefix core test -- secret-apply.test.ts` is GREEN and
  the file is byte-identical (no edit); confirm `core/src/store/secrets.ts`
  is untouched.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): idempotency over non-empty observed + fail-safe drift guard (11)`

# Task 12 — Docs: CHANGELOG `[Unreleased]`

- Files: `CHANGELOG.md` (modify).
- [ ] Familiarise: read the top `[Unreleased]` entry of `CHANGELOG.md`.
- [ ] No test (docs-only; exempt per `.claude/rules/specs-first.md`
  "trivial / docs" and `tdd-required.md` out-of-scope).
- [ ] Edit `CHANGELOG.md` `[Unreleased]`: a fix entry citing
  `2026-06-02-observed-state-adapter.md` — `get_state` / `diff` now reflect
  the real cluster (the observed-state adapter is wired; the empty-stub
  fallback is test-only); note that the known volume-model divergence is now
  VISIBLE as drift and its resolution is deferred to Part 2.
- [ ] Run `npm --prefix core run typecheck` (no-op sanity) and full
  `npm --prefix core test` → expected green (no NEW typecheck errors; 1
  `@live` skipped). Assert `secret-apply.test.ts` and
  `core/src/store/secrets.ts` remain byte-identical.
- [ ] Commit: `docs: observed-state adapter fix + known volume drift now visible (12)`

---

## Acceptance criteria (spec §5)

- [ ] `npm --prefix core run typecheck` introduces NO new errors beyond the
      two pre-existing baseline errors; `npm --prefix core test` green.
- [ ] `ObservedSlice` carries `{ key, payload }` (Q1); every `observe()`
      impl and the `conformanceHarness` migrated; no `slice.entities`-as-string
      consumer remains (Task 2).
- [ ] HetznerCloud + Docker observe carry rich `entities.ts`-shaped payloads;
      `listAll` deserialization widened via a wire Zod schema; the fake
      serves the rich fields (Tasks 1, 3, 4).
- [ ] Pure adapter `(slice) => State` Zod-validates each payload and SKIPS
      the invalid one (degrade-safe, Q3); the result satisfies
      `StateSchema.parse` (Task 5).
- [ ] Composite union dedups by `key`, first-wins (Q4); per-backend
      value-free fault tolerance preserved (Task 6).
- [ ] `buildBootDeps` wires the REAL adapter; production never falls into
      the empty-stub fallback (Q6 — fallback stays test-only); regression
      guard proves a NON-EMPTY `State` (Task 7).
- [ ] Reconcile DB-backed: NON-EMPTY observed snapshot persisted; `get_state`
      returns it; `diff` empty when desired == observed (Task 10).
- [ ] Secret hygiene: no resolved value in the snapshot or `get_state`
      response; `secret-apply.test.ts` + `secrets.ts` byte-identical
      (Tasks 8, 11, 12).
- [ ] Idempotency property covers non-empty observed (cycle 2 no-op,
      snapshot byte-stable); fail-safe — observed-but-not-desired ⇒
      `result:"drift"`, never a destroy (Task 11).
- [ ] Contract-oracle review: ZERO new wire field in `get_state`; shape
      `Server[]` / `Service[]` / … per `contract.ts` / `contract-v2.ts`.
- [ ] `CHANGELOG.md` `[Unreleased]` (Task 12).

---

## Riscos (spec §6)

1. **Real drift becomes visible (HIGH).** A truer observed makes `diff`
   surface observed-but-not-desired resources (the volume-model divergence,
   Q5). Mitigation: drift is `result:"drift"` (`reconcile.ts:360-374`),
   reported never corrected; the observe / adapter path adds no delete;
   documented as an EXPECTED divergence whose resolution is Part 2
   (Tasks 11, 12).
2. **Wide migration surface (MEDIUM).** ~40 sites consume `slice.entities`
   as `string[]`. Mitigation: only 3 are production
   (`composite-provider.ts:186/:229`, `provider.ts:245`); the rest are test
   fakes / inline adapters; Task 2 moves them ALL in one compile-clean
   atomic commit gated by the full suite; the `idempotency.property.test.ts`
   `makeObservedAdapter` is the working prototype.
3. **Secret leak in the now-non-empty snapshot (HIGH).** Mitigation: Docker
   observe surfaces `secret:<ref>` / label, never resolves (no `ApplyContext`
   in observe); the adapter is pure and token-free; sentinel test (Task 8).
4. **Malformed payload drops the cycle (MEDIUM).** Mitigation: degrade-safe
   per-entity `safeParse` + skip (Q3, Task 5); the `State` always validates;
   mirrors the existing degrade-safe read.
5. **Thin fake masks the real (MEDIUM).** A fake that does not serve the rich
   fields would let provider tests pass while production breaks. Mitigation:
   fake fidelity FIRST (Task 1, `fakes-author` discipline); a wire Zod schema
   on the parsed fields (Task 3).
6. **Console contract break (HIGH if it happens).** A non-empty observed that
   does not match the oracle. Mitigation: the adapter emits objects valid per
   `entities.ts` (which mirrors the contract); flag for contract-oracle
   review; goal ZERO new wire field.

## Rollback

Each task is one commit; rollback is `git revert` of the offending commit(s):

- **Task 7 alone** un-wires the real adapter ⇒ production falls back to the
  empty-stub (Q6) — the pre-fix behaviour — while every other change stays
  dormant and AS-IS. This is the fastest neutraliser.
- **Tasks 3–6** (rich payloads, adapter, union) are inert without Task 7's
  wiring; reverting them is safe and isolated.
- **Task 2** (the shape change) is the only widely-coupled commit; reverting
  it requires reverting Tasks 3–7 first (they depend on the `{ key, payload }`
  shape). Because it is one atomic commit, the revert is also atomic.
- **Task 1** (fake fidelity) is test-only and inert without later tasks.
- **Tasks 8, 10–12** are tests + docs — reverting drops coverage / docs only.

No migration, no console contract change ⇒ no data or wire rollback concern.
No destructive operation is ever issued (observe / adapter add no delete;
drift is reported, never corrected), so there is nothing to clean up on
revert.

---

## Fora de escopo / depende de Part 2

- **Volume source-of-truth migration** — the manifest declares Hetzner
  volumes; reality uses Docker named volumes. Part 1 picks NO winner and
  migrates NOTHING (Q5); the divergence surfaces as reported drift only.
  Part 2 (separate spec) decides the source of truth.
- **Desired-state durability** (follow-up #70) — `promote_manifest` stays
  in-process / non-durable.
- **Any `import_state` / adopt path** that would SEED desired from reality
  or from the manifest YAML.
- **Cleanup / correction of any discovered drift** (fail-safe: reported,
  never corrected).
- **Console wire-contract change** — `get_state` keeps the
  `Server[]` / `Service[]` / … shape.
- **EXPLICITLY untouched**: `core/src/reconciler/secret-apply.test.ts`
  (golden, byte-identical), `core/src/store/secrets.ts`
  (`SecretResolver` / `ApplyContext` FROZEN), `core/src/server.ts:420-429`
  (stub-fallback stays test-only, Q6), and any new `StateEvent` write-site
  (none added).
- **Any `@live` test** — not added by this plan.

## Done = (per task, summary)

- **1:** the hetzner fake list serves the rich server/network/volume wire
  fields (no longer masks the discard); docker fake exposes the Service
  channel.
- **2:** `ObservedSlice.entities` is `{ key, payload }[]`; the
  `conformanceHarness`, the composite dedup, every `observe()` impl, and all
  inline test adapters migrate in one atomic compile-clean commit.
- **3:** HetznerCloud `observe()` carries `entities.ts`-shaped
  server/network/volume payloads (`listAll` widened via a wire Zod schema).
- **4:** Docker `observe()` carries the `ServiceSchema`-valid payload; a
  secret-bound env stays a `secret:<ref>` / label, never resolved.
- **5:** the pure `observed-adapter.ts` maps a slice to a Zod-validated
  `State`, SKIPPING any invalid payload (degrade-safe, never throws).
- **6:** the composite observe union dedups enriched slices by `key`,
  first-wins, with byte-identical per-backend fault tolerance.
- **7:** `buildBootDeps` wires the REAL adapter — the root-cause regression
  fix; production never hits the empty-stub (which stays test-only).
- **8:** sentinel — the persisted observed snapshot + `get_state` carry
  secret REFS, never resolved values.
- **10:** reconcile persists a NON-EMPTY observed snapshot; `get_state`
  returns it; `diff` is empty when desired matches observed.
- **11:** idempotency property covers non-empty observed (cycle 2 no-op,
  snapshot byte-stable); fail-safe — observed-but-not-desired ⇒
  `result:"drift"`, never a destroy; secret golden + `secrets.ts`
  byte-identical.
- **12:** `CHANGELOG.md` `[Unreleased]` records the fix and the now-visible
  volume drift (resolution deferred to Part 2).
