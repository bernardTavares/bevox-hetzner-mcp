# Docker provider: pull, start, verify + provision user_data — Plan

**Spec:** `docs/specs/2026-06-01-docker-provider-bootstrap-and-verify.md` (Aceita).

**Goal:** Fix the 4 deploy bugs: container never started (5), verify false on running (6), no image pull (4), no Docker on fresh host (3 — `user_data` carve-out). Each fix pairs the provider change with making the relevant fake faithful to the real Engine/Hetzner API (the fakes masked bugs 5 & 6). TDD, fakes-only. Commit trailer + `spec: 2026-06-01-docker-provider-bootstrap-and-verify.md (task N)`.

**Working agreement:** `.claude/rules/tdd-required.md` + `esm-nodenext` + `fakes-author`. Typecheck clean + suite green before each commit. DB-backed tests run with `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`.

**Ordering:** Bugs 5/6/4 unblock `apply_manifest` services on a host with Docker (what's being tested now) → land first. Bug 3 is the `provision_server` flow → last. Tasks 1 and 2 are *coupled* changes (making a fake honest turns existing apply/observe tests red for the right reason — that IS the Bug-5/6 exposure — then the provider fix greens them).

---

### Task 1 — Bug 5: fake run-state honesty + `listManaged` `all=true`

- Files: `core/test/fakes/docker-http.ts`, `core/src/providers/docker.ts`, `core/src/providers/docker.test.ts`.
- [ ] Familiarise: fake `/containers/json` handler (returns all regardless of state); `listManaged` (`docker.ts:290`), `replicasOf` (`:301`), the apply create+start loop (start loop skips when `replicasOf` empty).
- [ ] Red: (a) make the fake `/containers/json` return ONLY `State==="running"` unless `?all=true`. This turns existing apply/observe tests red (create→exited container no longer listed → start loop skips → verify false) — Bug 5 exposed. Add an explicit test: apply a 1-replica service, assert the container ends **running** (started) and a re-apply is a no-op.
- [ ] Run `npm --prefix core test docker` → FAIL (start never reached; container stays created).
- [ ] Green: `listManaged` → `/containers/json?all=true&filters=…`. Now `replicasOf` finds the `Created` container and the start loop starts it. Update any test that asserted the running-only-without-all behaviour of the fake.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `fix(core): list managed containers with all=true so created ones get started (1)`

### Task 2 — Bug 6: fake image-default ports + `isConverged` port subset

- Files: `core/test/fakes/docker-http.ts`, `core/src/providers/docker.ts`, `core/src/providers/docker.test.ts`.
- [ ] Familiarise: `isConverged` ports block (`docker.ts:456-458`, the `havePorts.size !== wantPorts.size` exact check); fake inspect `Config.ExposedPorts` (only what create set).
- [ ] Red: add a fake seam so a container's inspect carries image-default exposed ports beyond the create body (e.g. `fake.setImageExposedPorts(image, ["80/tcp"])` applied on create, or create merges image defaults). Test: a service with NO declared `ports` on an image that exposes `80/tcp` → `isConverged` currently returns false (size 1 ≠ 0).
- [ ] Run `npm --prefix core test docker` → FAIL.
- [ ] Green: drop the exact-size check; keep the subset loop (`for (const p of wantPorts) if (!havePorts.has(p)) return false`). Add the converse test: a DECLARED port absent from the container ⇒ still false.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `fix(core): isConverged tolerates image-default exposed ports (subset, not equality) (2)`

### Task 3 — Bug 4: image pull before create (fail-closed, tag+digest)

- Files: `core/test/fakes/docker-http.ts`, `core/src/providers/docker.ts`, `core/src/providers/docker.test.ts` (+ a small `parseImageRef` unit).
- [ ] Familiarise: the apply create loop; the Docker `POST /images/create?fromImage=&tag=` + NDJSON stream contract.
- [ ] Red:
  - Fake: `ContainerCreate` returns **404** (`No such image`) if the image was not "pulled"/registered; add `POST /images/create` that registers the image and returns success NDJSON; seams `fake.setRegistryImage(ref)` (pullable) and a not-found default + `fake.failPull(ref)`.
  - Tests: (i) a service whose image isn't present ⇒ provider pulls then creates (assert `/images/create` called before `/containers/create`); (ii) `@sha256:` digest form parsed (`fromImage=repo@sha256:…`, no tag); (iii) pull failure (404/registry) ⇒ action throws `ReconcileError`, **no container created**; (iv) idempotent: re-apply doesn't duplicate.
- [ ] Run `npm --prefix core test docker` → FAIL (no pull; 404 on create).
- [ ] Green: `parseImageRef(image)` helper + `ensureImage(svc.image)` (POST /images/create, drain NDJSON, throw on `{"error"}`) called once before the create loop; pull does NOT set `changed`.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `feat(core): docker pull (POST /images/create) before container create, fail-closed (3)`

### Task 4 — Bug 3: `user_data` passthrough on provision

- Files: `core/src/domain/desired-state.ts`, `core/src/domain/entities.ts`, `core/src/providers/hetzner-cloud.ts`, `core/test/fakes/hetzner-http*.ts`, `desired-state.test.ts`, `entities.test.ts`, `hetzner-cloud.test.ts`.
- [ ] Familiarise: `ManifestServerSchema`, `entities.ServerSchema`, `hetzner-cloud.ts:149` (`ServerSchema.safeParse(action.desired)` strips unknowns), `serverBody` (`:336`), the hetzner-http fake server-create handler.
- [ ] Red: schema tests — `user_data` parsed in `ManifestServerSchema` and RETAINED by `entities.ServerSchema.safeParse`; provider test — `POST /servers` body includes `user_data` iff declared, byte-identical when omitted.
- [ ] Run → FAIL.
- [ ] Green: add `user_data: z.string().optional()` to both schemas; `serverBody` destructures and conditionally adds `user_data`; fake echoes it.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `feat(core): servers[].user_data passthrough to Hetzner provision (cloud-init) (4)`

### Task 5 — Idempotency property + docs + CHANGELOG

- Files: `core/src/reconciler/idempotency.property.test.ts`, `core/.env.example`, `deploy/README.md`, `core/CHANGELOG.md` (or root `CHANGELOG.md`).
- [ ] Extend the property's service sample so it exercises the pull+start path against the now-faithful fake; assert converge + cycle-2 strict no-op (pull doesn't flip `changed`); secret golden byte-identical (run-only).
- [ ] Docs: `.env.example`/`deploy/README.md` document `servers[].user_data` + the canonical docker-install cloud-config + an example manifest; CHANGELOG `[Unreleased]` entry citing the spec.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `test+docs: idempotency for pull/start; user_data workflow + CHANGELOG (5)`

---

## Risks
- **Fake-honesty cascade (tasks 1/2):** making the fake faithful will turn several existing docker tests red simultaneously — that is expected and is the Bug exposure; the provider fix in the same task greens them. Audit each newly-red test to confirm it fails for the run-state/port reason, not an unrelated one.
- **observe() semantics (task 1):** `all=true` makes observe report stopped containers. That is more correct (a stopped managed container is reconcilable), but check no test asserted observe hides stopped ones.
- **Pull idempotency (task 3):** pull must not set `changed`, or the idempotency property breaks (cycle 2 would look mutating). Asserted in task 5.
- **Digest parsing (task 3):** `@sha256:` must go in `fromImage`, never `tag`. Covered by a dedicated test.

## Rollback
Additive/correctness fixes; revert the commit range. No migration, no contract change, no destructive op introduced (pull-fail and verify-false both abort without deleting).

## Done =
A `nginx:alpine` service applies end-to-end on a host with Docker: image pulled, container created AND started, verify converges, re-apply is a no-op; `servers[].user_data` lets a fresh server come up with Docker via cloud-init. Fakes faithful to the real Engine/Hetzner API. Suite green; typecheck clean.
