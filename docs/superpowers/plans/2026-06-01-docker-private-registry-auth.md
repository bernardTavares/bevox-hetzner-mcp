# Docker private registry auth + skip-pull-if-present Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Goal:** A `service` whose image lives in a PRIVATE registry pulls and
starts end-to-end. After this plan, `ensureImage` (1) skips the pull when
the image is already present locally (`GET /images/<ref>/json` → 200), and
(2) when the image is absent AND the registry host has a configured
`secret:<ref>` credential, sends `POST /images/create` with an
`X-Registry-Auth` header carrying `base64url({username,password,serveraddress})`
resolved AT APPLY behind the unforgeable `ApplyContext`. Public pulls
(`redis:7-alpine`, `postgres:16-alpine`, host = `docker.io`, no configured
ref) stay byte-identical. The resolved password and the base64 header value
NEVER appear in any plan / dry_run / log / StateEvent / observed state /
error message / argv. Idempotency holds: a converged re-apply never
re-pulls and never flips `changed`.

**Architecture:** Four additive, layered surfaces. (1) The fake
(`core/test/fakes/docker-http.ts`) gains image-presence fidelity
(`GET /images/<ref>/json` 200/404 with a presence seam) and captures the
`X-Registry-Auth` header on `POST /images/create` (the fakes masked the
bug — same `.claude/skills/fakes-author` discipline as the
`2026-06-01-docker-provider-bootstrap-and-verify` spec). (2) A pure
`_registryHostOf(image)` helper derives the registry host (qualified →
host, unqualified → `docker.io`, `host:port`, `localhost`). (3) The
transport seam (`docker-transport.ts` `request`) gains an OPTIONAL 4th
`headers?` param routed by the SSH impl (`ssh-transports.ts`) through
`curl --config -` on STDIN so the sensitive value never lands on an argv
token (`ps aux`), guarded against the unsupported body+header combination.
(4) `config.ts` + `entrypoint-wiring.ts` parse a JSON `REGISTRY_AUTH_REFS`
host→secret-ref map (fail-closed at boot, value-free), passed as an
OPTIONAL `registryAuthRefs` opt into `createDockerProvider`. `ensureImage`
gains an `applyContext` param, resolves+validates the `{username,password}`
credential (Zod, fail-closed → `ReconcileError("fatal")` naming only the
host), builds the header, and threads it through `call` →
`tx.request(method, path, body, headers)`. The pull-error throw stays
byte-identical (`transient`, names only the image).

**Tech Stack:** Inherits the v1 ratified stack unchanged (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`,
PostgreSQL 16 via `pg`, Docker Engine API over SSH `curl --unix-socket`,
Zod, Pino, Vitest + HTTP fakes). **Zero new dependencies.** Node 20's
`Buffer.from(...).toString("base64url")` is used for the header. No new
contract field, no new MCP tool, no new REST endpoint, no new migration —
additive behaviour over existing schemas and FROZEN invariants.

**Specs:**
- This spec: `docs/specs/2026-06-01-docker-private-registry-auth.md` (Status: Aceita)
- Direct predecessor (Docker bootstrap, `ensureImage`/`_parseImageRef`):
  `docs/specs/2026-06-01-docker-provider-bootstrap-and-verify.md`
- Secret resolver real (the apply-only `secretResolver` seam reused as-is):
  `docs/specs/2026-05-28-secret-resolver-real-v1.md`
- v2 contract (FROZEN): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- v1 base (FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`

---

## How this plan is executed

Single plan, one ordered task list (no multi-phase split — the surfaces
are small but the ORDER is load-bearing). Each task's red test fails for
the RIGHT reason and the suite stays green between commits. The order
front-loads the FAKE FIDELITY (so subsequent provider tests fail because
production lacks the behaviour, not because the fake masks it), then the
pure host helper, then skip-if-exists, then the transport plumbing, then
boot wiring, then the auth header that ties them together, then the
hygiene/idempotency/docs capstone.

All paths are repo-root-relative under ``.
Every production file this plan touches already exists — there are NO new
production source files (new exports are added to existing modules; new
test cases land in existing colocated `*.test.ts` files). Do not start a
task until the previous task's commit is in and `npm --prefix core test`
is green.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail for the RIGHT
  reason (assertion mismatch, not import/type error) → minimal
  implementation → run, see it pass → commit. Reference
  @superpowers:test-driven-development and `.claude/rules/tdd-required.md`.
- **DRY / YAGNI / minimal change**: build only what each task needs; no
  speculative abstraction (no per-image creds, no token-refresh dance, no
  host `~/.docker/config.json` reuse — all explicitly out of scope).
  Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Conventional Commits.
  Mandatory trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  spec: 2026-06-01-docker-private-registry-auth.md (task N)
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: Docker Engine via
  `core/test/fakes/docker-http.ts`; SSH transport routing tested directly
  against `core/src/providers/ssh-transports.test.ts` with a fake
  `SshRunner`; DB-backed property test via `core/test/fakes/pg-harness.ts`
  (Postgres on port 5546,
  `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`).
  No `@live` surface is added by this plan.
- **Secret hygiene (load-bearing)**: the resolved password AND the base64
  `X-Registry-Auth` value (base64 ≠ encryption — whoever sees it sees the
  cred) NEVER reach `logger.*` / `console.*`, `StateEvent.payload`,
  `Plan`, `dry_run`, an error `.message`/`.cause`, or any argv token. The
  header value travels ONLY on STDIN via `curl --config -`. Reference
  `.claude/rules/secrets-resolution.md`.
- **Secret golden byte-identical**: `core/src/reconciler/secret-apply.test.ts`
  must remain byte-identical — this plan does NOT touch the env-injection
  path (`resolveSecretEnv`). Guarded in the capstone task.
- **Fail-safe, never fail-deleting**: a failed/unauthorized pull or a
  malformed credential ABORTS the action (`transient` / `fatal`) WITHOUT
  creating a container and WITHOUT removing anything. Reference
  `.claude/rules/fail-safe.md`.
- **ESM/NodeNext hygiene**: `.js` import extensions, `import type` for
  type-only imports, narrow indexed access (`noUncheckedIndexedAccess`),
  Zod for the resolved-credential JSON (no `as` on parsed wire), no
  `console.*` in `core/src/`, `_`-prefix any test-only export (per Rule 8;
  `_parseImageRef` is the established sibling). Reference
  `.claude/rules/esm-nodenext.md`.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — no contract change

This plan is **additive and contract-neutral**:

- No new wire field on any console contract (`contract.ts` / `contract-v2.ts`).
- No new MCP tool, no new REST endpoint, no new migration.
- No change to any `StateEvent` write-site (`core/src/reconciler/**`
  untouched); the `actor` channel is unchanged; `applyContext` is already
  threaded onto `PlanAction` by `applyPlan` and reaches the create-path at
  `docker.ts:726` (`needsCreate` branch).
- The `SecretResolver` interface (`core/src/store/secrets.ts`) is FROZEN
  and reused AS-IS (Bug 10 wired it already at `docker.ts:261`).
- The pull-error throw (`docker.ts:402-407`) stays byte-identical
  (`transient`, names only the image, never echoes the registry stream).
- New env knob `REGISTRY_AUTH_REFS` is OPTIONAL: absent / `""` / `{}` ⇒
  empty map ⇒ no auth wired ⇒ current behaviour byte-identical.

---

## Non-negotiable principles (this plan)

All v1/v2 invariants apply unchanged. The load-bearing ones here (spec §3):

1. **L1 — apply-only resolution.** `ensureImage` resolves the credential
   ONLY behind the `applyContext` token; the create-path call site
   (`docker.ts:726`) passes `action.applyContext`. plan / dry_run /
   observe / verify carry no token, so resolution is structurally
   unreachable there (same guarantee as `resolveSecretEnv`).
2. **L2 — password never leaks.** Resolved `password` never reaches a
   logger, `StateEvent.payload`, or an error message; a malformed-cred
   error cites only `<host>`.
3. **L3 — base64 header never leaks** (base64 ≠ encryption). The header
   value travels via `curl --config -` STDIN, never an argv token; the
   transport secret-boundary contract forbids it in any diagnostic; the
   SSH impl additionally adds the value to the per-call `scrub` secrets
   set as defense-in-depth.
4. **L4 — pull-error path names only the image** (`docker.ts:402-407`
   preserved byte-identical).
5. **L5 — fail-closed on malformed cred.** A resolved value that is not
   `{username,password}` ⇒ `ReconcileError("fatal")` BEFORE any pull or
   container create.
6. **L6 — secret golden byte-identical** (`secret-apply.test.ts`).
7. **L7 — fail-safe unchanged.** Pull/auth failure throws (`transient` /
   `fatal`) ⇒ NO container created, NOTHING deleted.

---

## Testing strategy

| Layer | How | Covers |
|---|---|---|
| Fake fidelity (image present) | `core/test/fakes/docker-http.ts` + sibling `docker-http.test.ts` | `GET /images/<ref>/json` → 200 if seeded present, 404 otherwise; `setImagePresent(ref)` seam; `POST /images/create` marks the image present afterward |
| Fake fidelity (auth capture) | `core/test/fakes/docker-http.ts` | `POST /images/create` captures the `X-Registry-Auth` header (4th `headers` arg) so a test can assert the base64url; capture exposed via a `.captured…` seam |
| Host derivation | `core/src/providers/docker.test.ts` | `_registryHostOf`: `ghcr.io/…@sha256:…`→`ghcr.io`; `redis:7-alpine`→`docker.io`; `r:5000/img`→`r:5000`; `localhost/img`→`localhost`; `library/redis`→`docker.io` |
| Peça B — skip-if-exists | `core/src/providers/docker.test.ts` | image present (`GET …/json`→200) ⇒ NO `POST /images/create`; absent ⇒ pull emitted; skip never sets `changed` |
| Transport — sensitive header | `core/src/providers/ssh-transports.test.ts` | `request(...,headers)` with no body ⇒ argv contains `--config -`, header line on STDIN, value ABSENT from argv; body+headers together ⇒ `ReconcileError("precondition")` guard |
| Boot — Zod fail-closed | `core/src/entrypoint-wiring.test.ts` (+ `config.test.ts`) | `REGISTRY_AUTH_REFS` malformed JSON ⇒ boot `fatal` value-free; non-`{host:ref}` shape ⇒ `fatal`; absent ⇒ ok, empty map |
| Peça A — auth header | `core/src/providers/docker.test.ts` | `registryAuthRefs={"ghcr.io":"ghcr-pat"}` + resolver `{username,password}` ⇒ pull carries `X-Registry-Auth` = base64url(`{username,password,serveraddress:"ghcr.io"}`); public host (no ref) ⇒ NO header |
| Peça A — fail-closed | `core/src/providers/docker.test.ts` | resolver returns non-`{username,password}` ⇒ `ReconcileError("fatal")`, NO pull, NO container |
| Secret hygiene | `core/src/providers/docker.test.ts` (+ ssh-transports) | password + base64 header AUSENTE de todo log/plan/event/argv capturado |
| Idempotency property | `core/src/reconciler/idempotency.property.test.ts` (DB-backed, port 5546) | manifest with a private service (skip+pull) converges; cycle 2 = zero mutating actions, no re-pull |
| Secret golden | `core/src/reconciler/secret-apply.test.ts` | UNCHANGED, byte-identical |

CI runs unit + property with fakes on every commit. No real infra. No
`@live` surface added.

> **Typecheck baseline.** Two PRE-EXISTING typecheck errors live in
> `core/src/api/contract-v2-conformance.test.ts` and
> `core/src/reconciler/idempotency-load-balancer.property.test.ts`. Every
> "typecheck clean" check below means "no NEW errors beyond those two".

---

## File structure (touched files — all exist; no new prod files)

```
core/
  src/
    config.ts                          MODIFIED  REGISTRY_AUTH_REFS: z.string().optional()  (~:159, near SECRETS knobs)
    config.test.ts                     MODIFIED  optional present/absent case
    entrypoint-wiring.ts               MODIFIED  parse+Zod-validate REGISTRY_AUTH_REFS (fail-closed) → registryAuthRefs opt on createDockerProvider (~:305)
    entrypoint-wiring.test.ts          MODIFIED  malformed→fatal value-free; absent→empty
    providers/
      docker.ts                        MODIFIED  _registryHostOf; ensureImage gains applyContext + skip-if-exists (GET …/json) + resolve/validate cred + X-Registry-Auth; call() 5th headers param; call site :726 passes action.applyContext; DockerProviderOptions registryAuthRefs (~:160)
      docker.test.ts                   MODIFIED  host derivation, skip, auth, fail-closed, hygiene cases
      docker-transport.ts              MODIFIED  request() 4th headers? param + secret-boundary doc extension  (:56)
      ssh-transports.ts                MODIFIED  makeDocker.request routes headers via curl --config - (stdin) + body+header precondition guard + scrub defense  (:143)
      ssh-transports.test.ts           MODIFIED  --config - / stdin / argv-absent / guard cases
    reconciler/
      idempotency.property.test.ts     MODIFIED  private-service skip+pull convergence (cycle 2 no-op)
      secret-apply.test.ts             UNCHANGED  (assert byte-identical — guard, do not edit)
  test/
    fakes/
      docker-http.ts                   MODIFIED  GET /images/<ref>/json 200/404 + setImagePresent seam; capture X-Registry-Auth on create; request() 4th headers arg
      docker-http.test.ts              MODIFIED  fake-fidelity cases
core/.env.example                      MODIFIED  REGISTRY_AUTH_REFS key + JSON cred format
CHANGELOG.md                           MODIFIED  [Unreleased] entry
deploy/README.md                       MODIFIED  operator workflow (spec §5)
```

---

# Task 1 — Fake fidelity: image presence + `X-Registry-Auth` capture

- Files: `core/test/fakes/docker-http.ts` (modify),
  `core/test/fakes/docker-http.test.ts` (modify).
- [ ] Familiarise: read the fake's existing pull/presence state
  (`presentImages` / `absentImages` / `failedPulls` Sets at
  `docker-http.ts:201-203`), the `POST /images/create` handler
  (`:294-313`, which already adds to `presentImages`), the `request(method,
  path, body)` signature (`:273-279`), the `transport`/seam object
  (`:534-548`, where `setImageExposedPorts` / `failPull` live), and the
  `fresh()` reset (`:233-247`). Confirm there is NO existing
  `GET /images/<ref>/json` route (grep returns none).
- [ ] Failing test (add to `docker-http.test.ts`):
  - `GET /images/<encodeURIComponent(ref)>/json` returns **200** for a ref
    seeded via a new `setImagePresent(ref)` seam, **404** otherwise
    (Engine error envelope `{ message }`);
  - after a successful `POST /images/create` for `ref`, a subsequent
    `GET /images/<ref>/json` returns **200** (create marks it present — so
    the idempotency cycle-2 skip works);
  - `POST /images/create` called with a 4th `headers` arg containing
    `X-Registry-Auth` CAPTURES that value on a new seam (e.g.
    `fake.capturedRegistryAuth(ref)` or a captured-calls list) so a later
    test can assert the base64url.
- [ ] Run `npm --prefix core test -- docker-http.test.ts` → expect FAIL
  (no `GET …/json` route → falls through to a 404/unhandled that does not
  honour `setImagePresent`; no header capture; `request` has no 4th arg).
- [ ] Minimal impl in `docker-http.ts`:
  - widen `request`/`route` to accept an optional 4th
    `headers?: Readonly<Record<string,string>>` (thread it into `route`);
  - add a `GET` handler for `/images/<ref>/json`: decode the ref
    (`decodeURIComponent` of the segment between `/images/` and `/json`),
    return `ok(200, {…minimal inspect…})` if `presentImages.has(ref)`, else
    `err(404, "no such image: <ref>")`;
  - in the `POST /images/create` handler, when `headers?.["X-Registry-Auth"]`
    is present, store `ref → value` in a new `capturedRegistryAuth` Map;
  - add `setImagePresent(ref)` and a `capturedRegistryAuth(ref)` reader to
    the returned seam object; clear both in `fresh()`.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): faithful docker fake — image presence + X-Registry-Auth capture (1)`

# Task 2 — `_registryHostOf` pure helper

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify, add export near `_parseImageRef`
  at `:210`).
- [ ] Familiarise: read `_parseImageRef` (`docker.ts:210-221`) for the
  established Rule-8 `_`-prefixed test-only export convention and the
  digest/tag/host-vs-tag parsing it already handles. The new helper is
  SIBLING to it — DO NOT modify `_parseImageRef`.
- [ ] Failing test (add to `docker.test.ts`): `_registryHostOf` maps
  - `ghcr.io/example-org/bevox-backend@sha256:abc…` → `"ghcr.io"`;
  - `redis:7-alpine` → `"docker.io"` (unqualified → Docker Hub default);
  - `postgres:16-alpine` → `"docker.io"`;
  - `library/redis` → `"docker.io"` (first segment has no `.`/`:` → not a host);
  - `r:5000/img:tag` → `"r:5000"` (host:port);
  - `localhost/img` → `"localhost"`.
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (`_registryHostOf` not exported).
- [ ] Minimal impl: export
  `export function _registryHostOf(image: string): string` — take the
  segment BEFORE the first `/`; it is the registry host **iff** it contains
  `.` or `:` OR equals `"localhost"`; otherwise return `"docker.io"`. (Note:
  `docker.io` is BOTH the map key convention and the auth `serveraddress`;
  the Engine's internal `registry-1.docker.io` is not surfaced — spec §1.4
  risk row.)
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): _registryHostOf derives registry host (docker.io default) (2)`

# Task 3 — Peça B: skip pull when image already present

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `ensureImage` at `:392-410`).
- [ ] Familiarise: re-read `ensureImage` (`:392-410`) — it `_parseImageRef`s
  then unconditionally `POST /images/create`. The skip-if-exists `GET` uses
  the FULL `image` ref via `encodeURIComponent`, NOT the parsed pieces. The
  call site is `:726` (`if (needsCreate) await ensureImage(svc.image, action.entity)`).
  `changed` is driven by create/start at `:735`, NOT by the pull.
- [ ] Failing test (add to `docker.test.ts`): with the docker fake seeded
  `setImagePresent("ghcr.io/x@sha256:abc")` (via Task 1), applying a service
  with that image issues NO `POST /images/create` (assert the fake's pull
  was not called — e.g. presence of a capture/counter, or that the absent
  default would otherwise 404 the create); the converse — an absent image —
  still issues the `POST /images/create`. Skip path never flips `changed`.
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (ensureImage always pulls — no GET probe).
- [ ] Minimal impl in `ensureImage`, BEFORE the `POST /images/create`:
  - `const probe = await call("GET", `/images/${encodeURIComponent(image)}/json`, undefined, entity)`
    — wrap so a 404 is NOT thrown as fatal here (the Engine 404 means
    "absent" → proceed to pull). Prefer routing the probe through `tx.request`
    directly and branching on `res.status === 200` (return early) vs else
    (continue to pull), so the existing `call()` non-2xx mapping does not
    convert the expected 404 into a thrown error. Keep ESM `.js` extensions
    and narrow per `noUncheckedIndexedAccess`.
  - on 200 ⇒ `return` (no pull, no registry hit, no `changed`).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): skip docker pull when image already present locally (3)`

# Task 4 — Transport: sensitive `headers` via `curl --config -` (STDIN)

- Files: `core/src/providers/ssh-transports.test.ts` (modify),
  `core/src/providers/docker-transport.ts` (modify `request` signature at
  `:56-62` + secret-boundary doc at `:47-54`),
  `core/src/providers/ssh-transports.ts` (modify `makeDocker.request` at
  `:143-189`).
- [ ] Familiarise: read `docker-transport.ts:41-62` (the seam + its
  secret-boundary contract that already forbids the BODY in diagnostics)
  and `ssh-transports.ts:135-200` (`makeDocker`: `secrets =
  [config.SSH_PRIVATE_KEY]`, the argv builder, the `hasBody` branch pushing
  `-H Content-Type` + `--data-binary @-`, the `run(conn, argv, { stdin })`
  call, and the `scrub(res.stderr, secrets)` curl-fail path at `:194-200`).
- [ ] Failing test (add to `ssh-transports.test.ts`): build `makeDocker`
  with a FAKE `SshRunner` that records `argv` + `opts.stdin`. Call
  `request("POST", "/images/create?fromImage=ghcr.io/x", undefined,
  { "X-Registry-Auth": "BASE64URLVALUE" })` and assert:
  - argv contains the tokens `--config` and `-`;
  - argv does NOT contain `"BASE64URLVALUE"` anywhere (the value is absent
    from the command line);
  - the recorded `stdin` contains the line
    `header = "X-Registry-Auth: BASE64URLVALUE"`.
  - Second case: calling `request("POST", "/containers/create", { body },
    { "X-Registry-Auth": "x" })` (body AND headers together) throws
    `ReconcileError` with code `"precondition"`.
- [ ] Run `npm --prefix core test -- ssh-transports.test.ts` → expect FAIL
  (`request` has no 4th param; no `--config -` routing; no guard).
- [ ] Minimal impl:
  - `docker-transport.ts`: add `headers?: Readonly<Record<string,string>>`
    as the 4th param of `request`; extend the secret-boundary doc to state
    sensitive headers MUST route off-argv (STDIN) and MUST NOT appear in
    error/rejection/retry/debug surfaces.
  - `ssh-transports.ts` `makeDocker.request`:
    - accept the 4th `headers` param;
    - GUARD: if `hasBody && headers` ⇒ `throw new ReconcileError("precondition", "Docker transport: body+sensitive-header combination is unsupported", { entity: ... })` (no caller mixes them in v1; the guard stops a future caller from forcing a secret onto argv);
    - when `headers` present (and no body, so STDIN is free): push
      `"--config", "-"` to argv and set `stdin` to the config text — one
      line per header: `header = "X-Registry-Auth: <value>"`;
    - DEFENSE-IN-DEPTH: add each header VALUE to the per-call `secrets`
      array used by `scrub(...)` so any accidental stderr echo is redacted.
  - Keep `hasBody`-only path (`-H Content-Type` + `--data-binary @-` argv +
    body STDIN) byte-identical when no headers are supplied.
- [ ] Run → expect PASS. Sanity: `npm --prefix core test -- ssh-transports`
  to confirm no existing transport test flapped. `npm --prefix core run
  typecheck` → no NEW errors.
- [ ] Commit: `feat(core): docker transport routes sensitive headers via curl --config - stdin (4)`

# Task 5 — Config + boot: parse/validate `REGISTRY_AUTH_REFS` (fail-closed)

- Files: `core/src/config.test.ts` (modify), `core/src/config.ts` (modify,
  add field near the SECRETS knobs ~:159),
  `core/src/entrypoint-wiring.test.ts` (modify),
  `core/src/entrypoint-wiring.ts` (modify the `createDockerProvider({...})`
  call at `:305-313`).
- [ ] Familiarise: read `config.ts:114` (`ConfigSchema = z.object({...})`)
  and the existing optional-string pattern; read `entrypoint-wiring.ts:270-313`
  (where `dockerTransport`, `secretResolver`, and `resolveVolumeMount` are
  wired into `createDockerProvider`), and the `ReconcileError` import
  already in that file.
- [ ] Failing test (config): `config.test.ts` — `REGISTRY_AUTH_REFS` parses
  as an optional string (present → preserved verbatim; absent → `undefined`).
  (`config.ts` does NOT JSON-parse — it stays pure string-parse.)
- [ ] Failing test (boot): `entrypoint-wiring.test.ts` —
  - `REGISTRY_AUTH_REFS` set to malformed JSON ⇒ boot throws
    `ReconcileError("fatal")` whose message is exactly
    `"REGISTRY_AUTH_REFS is not valid JSON"` (VALUE-FREE — never echoes the
    content, which could contain a ref);
  - set to a non-`{host:ref}` shape (e.g. `{"ghcr.io": 5}`) ⇒
    `ReconcileError("fatal", "REGISTRY_AUTH_REFS must be a {host: ref} string map")`;
  - absent ⇒ ok; the `registryAuthRefs` passed to `createDockerProvider`
    is an empty map (or omitted). Use the existing wiring-test harness
    (grep `entrypoint-wiring.test.ts` for how it asserts the
    `createDockerProvider` opts / stubs config).
- [ ] Run `npm --prefix core test -- config.test.ts entrypoint-wiring.test.ts`
  → expect FAIL (no field; no boot parse/validate; no opt passed).
- [ ] Minimal impl:
  - `config.ts`: add `REGISTRY_AUTH_REFS: z.string().optional()` with a
    doc-comment (OPTIONAL JSON host→secret-ref map; absent ⇒ no auth wired).
  - `entrypoint-wiring.ts`: a non-exported helper that, when
    `config.REGISTRY_AUTH_REFS` is present, `JSON.parse`s it inside a
    try/catch → on throw, `ReconcileError("fatal", "REGISTRY_AUTH_REFS is
    not valid JSON")` (value-free); then
    `z.record(z.string(), z.string()).parse(parsed)` → on failure,
    `ReconcileError("fatal", "REGISTRY_AUTH_REFS must be a {host: ref}
    string map")`. Pass the resulting map (or `{}` when absent) as the new
    OPTIONAL `registryAuthRefs` opt of `createDockerProvider`, alongside
    `transport` / `resolveVolumeMount` / `secretResolver`. Do NOT boot-scan
    that each ref exists in `SECRETS_FILE` (consistent with
    `2026-05-28-secret-resolver-real-v1` §10).
  - `docker.ts` `DockerProviderOptions` (~:160, after `resolveVolumeMount`):
    add `readonly registryAuthRefs?: Readonly<Record<string,string>>;` with
    an OPTIONAL/additive doc-comment (mirror the `secretResolver` tone:
    absent ⇒ no `X-Registry-Auth` ever sent; the ref resolves AT APPLY via
    the existing `secretResolver`). Capture it in the factory closure.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): REGISTRY_AUTH_REFS config + fail-closed boot parse, registryAuthRefs opt (5)`

# Task 6 — Peça A: resolve credential + build `X-Registry-Auth` in `ensureImage`

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (modify `ensureImage` `:392-410`, `call`
  `:328-346`, and the call site `:726`).
- [ ] Familiarise: re-read `ensureImage` (post-Task-3, now with the GET
  probe), `call` (`:328-346`, which forwards to `tx.request(method, path,
  body)`), the create-path call site (`:726`, where `action.applyContext`
  is in scope), `resolveSecretEnv` (`:607-629`) for the
  `secretResolver.resolve("secret:<ref>", token)` pattern returning
  `{ status, name, value? }`, and the resolver test in the secrets module
  (happy: `{status:"ok", name, value:"abc"}`).
- [ ] Failing test (add to `docker.test.ts`):
  - private host: build the provider with
    `registryAuthRefs={"ghcr.io":"ghcr-pat"}` + an `applyContext` (isolation
    token) + a `secretResolver` whose `resolve("secret:ghcr-pat", ctx)`
    returns `{status:"ok", name:"ghcr-pat", value: JSON.stringify({username:"bevox-bot", password:"ghp_x"})}`.
    Apply a service with image `ghcr.io/example-org/bevox-backend@sha256:abc`
    (absent ⇒ pull). Assert the fake captured an `X-Registry-Auth` equal to
    `Buffer.from(JSON.stringify({username:"bevox-bot", password:"ghp_x", serveraddress:"ghcr.io"})).toString("base64url")`.
  - public host: image `redis:7-alpine` (host `docker.io`, NOT in
    `registryAuthRefs`) ⇒ NO `X-Registry-Auth` captured.
  - no applyContext (plan/dry_run posture): even with `registryAuthRefs`
    configured, NO header sent (resolution gated by the token).
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL
  (no header built/threaded).
- [ ] Minimal impl:
  - `call`: add a 5th param `headers?: Readonly<Record<string,string>>`,
    forwarded as `tx.request(method, path, body, headers)`.
  - `ensureImage(image, entity)`: add a 3rd param
    `applyContext: ApplyContext | undefined`. AFTER the skip probe (Task 3),
    BEFORE the pull: derive `const host = _registryHostOf(image)`; if
    `registryAuthRefs?.[host]` exists AND `applyContext` AND `secretResolver`:
    - `const r = await secretResolver.resolve(`secret:${ref}`, applyContext)`
      (prepend `secret:` to the bare ref); require `r.status === "ok"`
      (otherwise fail-closed, Task 7's concern — but here a non-`ok` for a
      configured private host is also `ReconcileError("fatal", "registry
      auth for ${host} is not available")` value-free);
    - `JSON.parse(r.value)` inside try/catch; Zod-validate
      `z.object({ username: z.string().min(1), password: z.string().min(1) })`;
    - build `const header = { "X-Registry-Auth": Buffer.from(JSON.stringify({ username, password, serveraddress: host })).toString("base64url") }`;
    - pass `header` as the 5th arg of the `call("POST", /images/create…)`.
  - else (host without configured ref, or no applyContext) ⇒ no header
    (path unchanged; public pulls keep working).
  - call site `:726`: `await ensureImage(svc.image, action.entity, action.applyContext)`.
  - The pull-error throw at `:402-407` stays byte-identical.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): ensureImage sends X-Registry-Auth for private registries (apply-only) (6)`

# Task 7 — Peça A fail-closed: malformed credential aborts before pull

- Files: `core/src/providers/docker.test.ts` (modify),
  `core/src/providers/docker.ts` (verify/extend the Zod fail-closed branch
  from Task 6).
- [ ] Familiarise: re-read the credential-parse/validate branch added in
  Task 6 and the `_parseImageRef` digest path (no change).
- [ ] Failing test (add to `docker.test.ts`): with
  `registryAuthRefs={"ghcr.io":"ghcr-pat"}` + applyContext + a
  `secretResolver` whose `resolve` returns `{status:"ok", value:'"just-a-string"'}`
  (or `'{"username":"u"}'` — missing `password`, or non-JSON), applying a
  private-image service throws `ReconcileError` with code `"fatal"`, the
  message cites ONLY `ghcr.io` (NOT the resolved value), NO `POST
  /images/create` is issued, and NO container is created. (Confirms L5 +
  the abort ordering: validation precedes pull and create.)
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect FAIL or PASS:
  if Task 6's impl already throws on the Zod failure this may PASS by
  construction — in that case STRENGTHEN the assertions to make them
  load-bearing (assert no pull AND no container AND host-only message), and
  confirm red→green by temporarily relaxing the Zod check locally (do NOT
  commit the relaxation).
- [ ] Minimal impl: ensure the malformed-cred branch throws
  `ReconcileError("fatal", `registry auth for ${host} is not a {username,password} JSON`, { entity })`
  BEFORE the pull call; the resolved value never enters the message.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `feat(core): fail-closed on malformed registry credential — fatal, no pull (7)`

# Task 8 — Secret-hygiene sentinel (password + base64 header never leak)

- Files: `core/src/providers/docker.test.ts` (modify; optionally a
  companion assertion in `ssh-transports.test.ts`).
- [ ] Familiarise: read how `docker.test.ts` / the secret tests already
  capture logs / events (grep for a captured-log array or a no-secret
  assertion pattern) and how `ssh-transports.test.ts` records argv.
- [ ] Failing test (add to `docker.test.ts`): run the private-image apply
  from Task 6 with a SENTINEL password (e.g. `"ghp_S3CR3T-must-never-leak"`).
  Capture every observable surface the test can reach — provider events,
  any injected logger, the create-body, AND (via the ssh-transport test)
  the argv — and assert NEITHER the raw password NOR the computed base64url
  header value appears in ANY of them. (The base64 value should appear
  ONLY in the fake's `capturedRegistryAuth` seam — which is the intended
  Engine destination, not a leak surface.)
- [ ] Run `npm --prefix core test -- docker.test.ts` → expect PASS if
  Tasks 4/6 are correct (this task is a GUARD/lock, not a new behaviour).
  If it FAILS, a leak exists — fix the leaking surface (route off-argv,
  drop from the event/log), do NOT weaken the assertion.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): sentinel — registry password + base64 header never leak (8)`

# Task 9 — Idempotency property: private-service skip+pull converges (cycle 2 no-op)

- Files: `core/src/reconciler/idempotency.property.test.ts` (modify).
- [ ] Familiarise: read `idempotency.property.test.ts` (DB-backed; uses
  `core/test/fakes/pg-harness.ts`,
  `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`).
  Identify how it builds providers with the docker fake and runs two
  reconcile cycles; confirm whether it already threads `registryAuthRefs`
  / `applyContext`.
- [ ] Failing test (extend the property / add a scenario): a manifest with
  a service whose image is in a private host (`registryAuthRefs` configured,
  resolver returns a valid `{username,password}`). Cycle 1: image absent ⇒
  pull (with header) + create + start ⇒ converges. Cycle 2: image now
  present (fake marked it on create) ⇒ skip-if-exists ⇒ NO `POST
  /images/create`, ZERO mutating actions, `changed` flat (no re-pull, no
  re-create). Assert the cycle-2 action set is empty/no-op.
- [ ] Run `npm --prefix core test -- idempotency.property.test.ts`
  (Postgres on 5546 up) → expect PASS-by-construction if Tasks 3/6 are
  correct; if so, WIDEN the property's image/host generator so the
  private-skip path is exercised and the assertion is load-bearing, then
  confirm red→green by temporarily reverting Task 3 locally (do NOT commit
  the revert).
- [ ] Guard: `npm --prefix core test -- secret-apply.test.ts` is GREEN and
  the file is byte-identical (no edit).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → no NEW errors.
- [ ] Commit: `test(core): idempotency property over private-registry skip+pull (9)`

# Task 10 — Docs: `.env.example` + CHANGELOG + runbook

- Files: `core/.env.example` (modify), `CHANGELOG.md` (modify),
  `deploy/README.md` (modify).
- [ ] Familiarise: read the top entry of `CHANGELOG.md`, the relevant
  registry/secrets section of `deploy/README.md`, and the existing
  `SECRETS_FILE` / `SOPS_AGE_KEY_FILE` keys in `core/.env.example`.
- [ ] No test (docs-only; exempt per `.claude/rules/specs-first.md`
  "trivial / docs" and `tdd-required.md` out-of-scope).
- [ ] Edit:
  - `core/.env.example`: add the `REGISTRY_AUTH_REFS` key with the
    `{"ghcr.io":"ghcr-pat"}` example and a comment that the ref resolves
    (via `SECRETS_FILE`/sops) to a `{"username":"…","password":"…"}` JSON;
    absent ⇒ public registries only.
  - `CHANGELOG.md` `[Unreleased]`: feature entry citing
    `2026-06-01-docker-private-registry-auth.md` (private-registry auth via
    `X-Registry-Auth` + skip-pull-if-present).
  - `deploy/README.md`: the operator workflow (spec §5) — store the
    credential JSON in the sops file under the ref, declare
    `REGISTRY_AUTH_REFS` in `core/.env`, rebuild + restart, then
    `apply_manifest` the private service.
- [ ] Run `npm --prefix core run typecheck` (no-op sanity) and full
  `npm --prefix core test` → expected green (no NEW typecheck errors; 1
  `@live` skipped).
- [ ] Commit: `docs: REGISTRY_AUTH_REFS workflow + CHANGELOG (10)`

---

## Acceptance criteria (spec §8)

- [ ] `npm --prefix core run typecheck` introduces NO new errors beyond the
      two pre-existing baseline errors; `npm --prefix core test` green.
- [ ] Fakes faithful (`GET /images/<ref>/json` 200/404; `X-Registry-Auth`
      capture) with tests that FAIL before the fix (Task 1).
- [ ] Peça A: private-image pull carries `X-Registry-Auth` = expected
      base64url; public host ⇒ no header; `_registryHostOf` covers
      qualified/unqualified/port/localhost (Tasks 2, 6).
- [ ] Peça A: fail-closed on non-`{username,password}` cred ⇒ `fatal`,
      nothing created (Task 7).
- [ ] Peça B: image present ⇒ NO `POST /images/create`; absent ⇒ pull
      (Task 3).
- [ ] Transport: sensitive header via `--config -` STDIN; value ABSENT
      from argv; body+header guard `precondition` (Task 4).
- [ ] Boot: `REGISTRY_AUTH_REFS` malformed/shape-wrong ⇒ boot `fatal`
      value-free; absent ⇒ ok (Task 5).
- [ ] Secret hygiene: password + base64 header ABSENT from every captured
      log/plan/event/argv (Task 8).
- [ ] Idempotency property covers skip+pull (cycle 2 no-op, no re-pull);
      `secret-apply.test.ts` byte-identical (Task 9).
- [ ] `CHANGELOG.md` `[Unreleased]` + `.env.example` + runbook (Task 10).

---

## Riscos (spec §7)

1. **base64 ≠ encryption (HIGH).** The `X-Registry-Auth` value is just
   base64url of `{username,password}` — whoever reads it reads the cred.
   Mitigation: travels via `curl --config -` STDIN, NEVER argv (`ps aux`);
   transport secret-boundary contract forbids it in any log/error; the SSH
   impl adds it to the `scrub` set; sentinel test (Task 8).
2. **Docker Hub host convention (`docker.io` vs `registry-1.docker.io`,
   MEDIUM).** `_registryHostOf` returns `docker.io` as BOTH the map key and
   the `serveraddress`; documented; explicit unqualified→`docker.io` test
   (Task 2).
3. **skip-if-exists on a mutable tag does not re-pull (LOW, accepted).**
   Operator chose ALWAYS; bevox images are pinned by `@sha256:` (immutable);
   mirrors Docker's pull-by-digest no-op. Re-apply becomes a no-op (Task 3).
4. **Malformed cred fails late (at apply, not boot) (LOW).** Fail-closed in
   apply (`ReconcileError fatal`, host-only message); no boot-scan
   (consistent with `2026-05-28` §10) (Task 7).
5. **body+sensitive-header in a future caller (LOW).** Guarded
   `precondition` in the SSH impl; no such caller exists in v1
   (`/images/create` is header-only) (Task 4).
6. **pull-error throw stays `transient`, not `fatal` (LOW).** Preserved
   from current state; an `unauthorized` is recoverable by re-config +
   re-apply; fail-safe guarantees nothing created/removed (`docker.ts:402-407`
   byte-identical).

## Rollback

Each task is one commit; rollback is `git revert` of the offending
commit(s):

- Tasks 1–2 (fake fidelity, pure helper) are inert without later tasks —
  reverting them is safe and isolated.
- Task 3 (skip-if-exists) is independent of auth — reverting restores
  unconditional pull.
- Task 4 (transport header param) is additive — with no caller passing
  headers it is dormant; reverting needs Task 6 reverted first (Task 6
  passes the header).
- Tasks 5–7 (config/boot/auth) are the auth feature — revert 7→6→5 to
  remove auth entirely; because `registryAuthRefs` is OPTIONAL, simply
  un-setting the `REGISTRY_AUTH_REFS` env var (or reverting Task 5 alone)
  neutralises the feature in production while leaving the code dormant and
  AS-IS.
- Tasks 8–10 are tests + docs — reverting drops coverage/docs only.

No migration, no contract change ⇒ no data or wire rollback concern. No
destructive operation is ever issued (pull-fail and cred-fail both abort
without deleting), so there is nothing to clean up on revert.

---

## Fora de escopo / depende de credenciais reais

- Reusing the host `~/.docker/config.json` / docker credential helpers
  (the Engine ignores them for API calls — the cred is ours, resolved via
  `secretResolver`).
- OAuth token-refresh / registry token-exchange dance — the static
  base64 auth-config is exactly what `/images/create` accepts.
- Per-IMAGE credentials (this plan is per-HOST: one registry host → one
  cred).
- Multi-arch manifest-list auth nuances.
- Boot-scan validating each `<ref>` exists in `SECRETS_FILE` (deliberately
  omitted — first apply fail-closes).
- `core/src/reconciler/**` (no `StateEvent` write-site change),
  `core/src/store/secrets.ts` (`SecretResolver` FROZEN, reused),
  `core/src/reconciler/secret-apply.test.ts` (golden, byte-identical),
  `core/src/agent/**` (zero agent-surface change) — all EXPLICITLY
  untouched (spec §6).
- Any `@live` registry test — not added by this plan.

## Done = (per task, summary)

- **1:** docker fake models image presence (`GET …/json` 200/404) +
  captures `X-Registry-Auth`.
- **2:** `_registryHostOf` derives the registry host (`docker.io` default).
- **3:** skip the pull when the image is already present locally.
- **4:** transport routes sensitive headers via `curl --config -` STDIN,
  off argv, with a body+header `precondition` guard + scrub defense.
- **5:** `REGISTRY_AUTH_REFS` config + fail-closed boot parse/validate +
  `registryAuthRefs` opt on `createDockerProvider`.
- **6:** `ensureImage` resolves the cred AT APPLY and sends
  `X-Registry-Auth` for private hosts; public hosts unchanged.
- **7:** fail-closed on a malformed credential ⇒ `fatal`, no pull, no
  container.
- **8:** sentinel — resolved password + base64 header never leak to any
  captured log/plan/event/argv.
- **9:** idempotency property covers the private-registry skip+pull path
  (cycle 2 no-op); secret golden byte-identical.
- **10:** `.env.example` + CHANGELOG + runbook document the workflow.
