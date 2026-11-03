# v2 Bloco E — Kubernetes/k3s provider (kubectl-over-SSH) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Each
> task is a self-contained TDD unit (failing test → run → minimal impl →
> run → commit). Do not skip the red step. Do not batch commits.

**Goal:** Add a new v2 block (E) that lets the agent manage Kubernetes
workloads and the k3s host of a running cluster, FIRST-CLASS, via the
same `Provider` port the reconciler already drives — entirely through the
v2-additive path (the 12 v1 tools are FROZEN and untouched). After this
plan: (1) `kubectl_apply` applies an opaque k8s manifest envelope to a
named SSH host's k3s via `kubectl apply -f -` (never `--prune`),
idempotent by a content-hash annotation `hetzner-mcp/manifest-hash`, with
secrets resolved ONLY at apply behind `ApplyContext`, `observe()` that
never reads back `Secret.data`, and a gated `destroy()`; and (2)
`ensure_k3s` installs k3s on a named host install-only — present ⇒ strict
no-op, version-divergent ⇒ DRIFT (no auto-upgrade), removed-from-desired
⇒ DRIFT (never `k3s-uninstall.sh`). Both tools are approval-always. The
verified production gap — `server.ts` constructing the MCP server WITHOUT
`v2Tools`, so NO v2 tool is reachable in the daemon — is fixed so the
whole v2 surface (these two tools and the prior eight) becomes callable.

**Architecture:** Two clean-boundary components behind one new SSH-backed
transport, wired data-driven into the existing extension points (no
change to `reconcile.ts` / `apply.ts`). Component 1 (workload):
`KubeManifestSchema` (Zod, envelope-only, opaque `body`, named `host` ref)
+ `KubernetesProvider` (`core/src/providers/v2/kube-apply.ts`) driving
`kubectl`-over-SSH through a `KubeTransport` seam analogous to
`DockerTransport`. Component 2 (host): `EnsureK3sSchema` (Zod, typed,
restricted — no arbitrary command) + `EnsureK3sProvider`
(`core/src/providers/v2/ensure-k3s.ts`) owning the install recipe.
Wiring: both kinds land in `observed-adapter.ts` `KIND_TABLE`,
`plan.ts` `V2_PLAN_ORDER` (with `k3s` BEFORE `kube` so the host is up
before workload applies), `v2-wrap.ts` `byKind` routing, a `kube()`
transport factory on `EntrypointTransports` + `buildBootDeps`; tools
`kubectl_apply` / `ensure_k3s` added to `V2_TOOLS`, registered on MCP
(`mcp.ts`) and REST (`rest.ts`), both `isSensitive: () => true`.

**Tech Stack:** Inherits the v1/v2 ratified stack unchanged (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`,
PostgreSQL 16 via `pg`, Hetzner Cloud HTTP over `fetch`, the argv-only
SSH command-runner `core/src/providers/ssh-exec.ts` — key 0600 in a temp
file deleted in `finally`, `shell:false`, no shell — Zod, Pino, Vitest +
fakes). **Zero new dependencies** — no `ssh2`, no k8s SDK; `kubectl`/`k3s`
run on the remote host over the existing SSH seam. No new migration.

**Specs:**
- This spec: `docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md` (Status: Aceita)
- Investigation: `docs/investigations/2026-06-04-kubernetes-integration-feasibility.md` (Path B1)
- v2 contract (FROZEN, spec-mãe): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- v1 base (FROZEN, spec-avô): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`
- Voice / structure reference: `docs/superpowers/plans/2026-06-02-observed-state-adapter.md`,
  `docs/superpowers/plans/2026-06-01-volume-hetzner-bind-automount.md`,
  `docs/superpowers/plans/2026-05-28-migration-runner-v1.md` (the `run_migrations`
  v2-tool template — the closest analogue for these two tools)

---

## How this plan is executed

Two phases, one ordered task list NUMBERED SEQUENTIALLY across both
(Task 1 … Task 24). Phase 1 (workload, Tasks 1–14) is delivered before
Phase 2 (host, Tasks 15–23); Task 24 is the docs capstone. Within
Phase 1 the schema and provider land BEFORE the tool/registration (a tool
with no provider behind it is dead code), and the wiring lands after the
provider so each red test fails for the RIGHT reason (assertion mismatch,
not import/type error). The two phases share the `KubeTransport` seam
(introduced in Task 4, reused in Task 16) and the SSH-exec fake (extended
in Task 3, reused in Task 16) — but the PLAN-ORDER gate (`k3s` before
`kube`) is locked in the wiring tasks of each phase so it holds regardless
of delivery order.

All paths are repo-root-relative under ``.
New production source files: `core/src/providers/v2/kube-transport.ts`,
`core/src/providers/v2/kube-apply.ts`, `core/src/providers/v2/ensure-k3s.ts`,
`core/src/agent/v2/kubectl-apply.ts`, `core/src/agent/v2/ensure-k3s.ts`
(+ colocated `*.test.ts`). Everything else modifies an existing file. Do
not start a task until the previous task's commit is in and
`npm --prefix core test` is green.

> **Typecheck baseline.** If `npm --prefix core run typecheck` already
> reports pre-existing errors on `main`, every "typecheck clean" check
> below means "no NEW errors beyond that baseline". This plan neither
> introduces nor resolves any pre-existing error.

> **DB-backed tests.** The idempotency property tasks (Tasks 13 and 22)
> and the reconcile-integration capstone (if exercised) require the
> disposable Postgres on port 5546:
> `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test`
> (CONTRIBUTING §"First-time setup"). Schema reset is owned by
> `core/test/fakes/pg-harness.ts`; do not bypass it.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail for the RIGHT
  reason (assertion mismatch, not import/type error) → minimal
  implementation → run, see it pass → commit. Reference
  @superpowers:test-driven-development and `.claude/rules/tdd-required.md`.
- **DRY / YAGNI / minimal change**: build only what each task needs; no
  speculative abstraction (no Helm, no multi-host targeting, no k3s
  upgrade/uninstall, no B2 kube-apiserver client — all explicitly out of
  scope, spec §9). Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Conventional Commits.
  Mandatory trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md (task N)
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real infra**: every test resolves the remote
  command through the extended `core/test/fakes/ssh-exec-recorder.ts`
  fake (records argv; scripts stdout). NO real `ssh`, host, k3s, kubectl,
  or network in any `unit`-project file. `@live` smokes (if any) live
  ONLY under `core/test/live/*.live.test.ts` (excluded from `npm test`),
  require operator tokens/host, and are NOT added by this plan unless an
  explicit `*.live.test.ts` file is named.
- **12 v1 tools FROZEN**: `core/src/agent/capability.ts` `ALL_TOOLS` stays
  byte-identical (12 entries); `core/src/agent/contract-conformance.test.ts:823`
  (`expect(ALL_TOOLS).toHaveLength(12)`) MUST stay green WITHOUT
  modification. The two new tools go to `V2_TOOLS` only.
- **Approval-always on both tools**: `kubectl_apply` and `ensure_k3s` are
  built with `isSensitive: () => true` (the `run_migrations` precedent —
  the tool routes through the real Approval Gate on every invocation; the
  runner never decides sensitivity).
- **Secrets resolved at apply only** (spec §2.4, ground rule #4): a
  `secret:<ref>` in the opaque `body` is resolved ONLY inside `apply()`
  behind the unforgeable `ApplyContext`; `plan` / `dry_run` / `observe`
  carry refs only; the content-hash is a one-way digest computed in a way
  that NEVER reveals a secret; `observe()` NEVER reads back `Secret.data`;
  errors are wrapped so a resolved value never appears in `.message` /
  `.cause` / stderr (mirrors `ssh-exec.ts` SECRET NON-LEAK + the
  `DockerTransport` secret-boundary contract). Reference
  `.claude/rules/secrets-resolution.md`.
- **Fail-safe, never fail-deleting** (ground rule #3): `apply()` NEVER
  uses `--prune`; NEVER deletes on an error path. A manifest removed from
  desired ⇒ DRIFT, never auto-delete. Real delete only via `destroy()`,
  gated by Approval + explicit desired-state removal. `ensure_k3s` is
  install-only — NEVER runs `k3s-uninstall.sh`, NEVER auto-upgrades.
  Reference `.claude/rules/fail-safe.md`.
- **Idempotency by design** (ground rule #2): a property test asserting
  apply-twice ⇒ strict no-op (`changed:false`, zero mutating argv) is
  MANDATORY for BOTH new kinds (`kube`, `k3s`). Any task touching
  `providers/**` or `reconciler/**` MUST include or extend the matching
  property test.
- **Every StateEvent carries the actor** (ground rule #5): the
  `ApplyContext` / `VerifiedCredential` supplies the actor; the provider
  propagates it into the emitted `StateEvent`. No anonymous mutation.
- **`reconcile.ts` and `apply.ts` are UNCHANGED** — both kinds are routed
  data-driven (the `v2-wrap.ts:157-159` "no dispatch switch lives in
  apply.ts/reconcile.ts" rule). Assert this in the wiring tasks.
- **ESM/NodeNext hygiene**: `.js` import extensions, `import type` for
  type-only imports, narrow indexed access (`noUncheckedIndexedAccess`),
  Zod on every wire-ish payload (no `as` on `res.json()` / argv-stdout),
  no `console.*` in `core/src/`, `_`-prefix any test-only export (Rule 8).
  Reference `.claude/rules/esm-nodenext.md`.
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — additions to v2 (Bloco E)

This plan is **additive**; the v1 12-tool contract and the v2 Bloco A
schemas are byte-identical at the end.

| New tool | Surface | Approval semantics |
|---|---|---|
| `kubectl_apply` | MCP `tools/call` (`mcp.ts`) + REST `POST /api/v2/kube/apply` (`rest.ts`) | `isSensitive: () => true` — ALWAYS routes through the Approval Gate |
| `ensure_k3s` | MCP `tools/call` + REST `POST /api/v2/k3s/ensure` | `isSensitive: () => true` — ALWAYS routes through the Approval Gate |

- New schemas (`KubeManifestSchema`, `EnsureK3sSchema`) land in
  `core/src/domain/entities-v2.ts` (NOT `entities.ts` — v1 is FROZEN).
  Mirror the cross-package oracle convention only if/when these schemas
  cross the console contract (Bloco E does not add a console wire field;
  flag for contract-oracle review, goal ZERO new console field).
- `V2_TOOLS` (`capability.ts:82`) gains `"kubectl_apply"` and
  `"ensure_k3s"`. `ALL_TOOLS` (12 v1) stays byte-identical.
- New entity-kinds in the reconciler vocabulary: `kube` and `k3s`. Their
  identity keys: `kube:<host>/<namespace>/<kind>/<name>` (Component 1)
  and `k3s:<host>` (Component 2).
- No new migration, no change to any `StateEvent` write-site shape (the
  `actor` channel is reused unchanged).

---

## Non-negotiable principles (this plan)

All v1/v2 invariants apply unchanged. The load-bearing ones here
(spec §5):

1. **#2 — idempotency.** `kube`: 2nd apply ⇒ `hetzner-mcp/manifest-hash`
   matches ⇒ `changed:false`, zero `kubectl apply` mutation. `k3s`:
   present ⇒ `changed:false`, zero install argv. Property tests for both
   (Tasks 13, 22).
2. **#3 — fail-safe, never fail-deleting.** `apply()` never `--prune`,
   never deletes on error; manifest/k3s removed from desired ⇒ DRIFT;
   real delete only via gated `destroy()`; `ensure_k3s` NEVER
   `k3s-uninstall.sh`, NEVER auto-upgrade. Locked by Tasks 9, 12, 19, 20.
3. **#4 — secrets at apply only.** `secret:<ref>` resolved only in
   `apply()` behind `ApplyContext`; refs in plan/observe/log/StateEvent;
   `observe()` never reads `Secret.data`; hash never reveals a value.
   Locked by Tasks 7, 8 (leak-sentinel).
4. **#5 — StateEvent actor.** actor from `ApplyContext`; never synthesised
   locally. Locked by Tasks 11, 21.
5. **v1-FROZEN.** `ALL_TOOLS.length === 12` byte-identical;
   `contract-conformance.test.ts:823` untouched and green. Guarded in
   every tool/capability task and the capstone.

---

## Testing strategy

| Layer | How | Covers |
|---|---|---|
| SSH-exec fake | extend `core/test/fakes/ssh-exec-recorder.ts` to script `kubectl apply -f -` / `kubectl get … -o json` / `kubectl delete` / `k3s --version` / `systemctl is-active k3s` / `kubectl get nodes`, recording argv + stdin | argv-by-token assertions; zero real ssh/host/network |
| `KubeManifestSchema` unit | `core/src/domain/entities-v2.test.ts` (Zod parse/safeParse) | envelope valid (incl. `host` ref); opaque `body` preserved verbatim; arbitrary `kind` accepted; missing `namespace`/`name` rejected |
| `KubeTransport` seam | `core/src/providers/v2/kube-transport.test.ts` | argv assembly for `kubectl …` over the SSH runner; manifest on stdin; kubeconfig path `/etc/rancher/k3s/k3s.yaml`; secret-boundary (body never echoed in errors) |
| `KubernetesProvider` apply/observe/verify | `core/src/providers/v2/kube-apply.test.ts` + fake | hash-annotation injected; matched hash ⇒ `changed:false`, mismatched/absent ⇒ apply + `changed:true`; observe by identity; `Secret.data` redacted; verify read-only |
| `kube` idempotency (property) | `core/src/providers/v2/kube-apply.property.test.ts` (or extend the v2 property family) | apply 2× ⇒ strict no-op (`changed:false`, zero mutating argv) |
| Secrets / leak-sentinel | extend `core/src/reconciler/secret-apply.test.ts` (or the sentinel family) | sentinel-bearing manifest ⇒ zero occurrence in plan/log/StateEvent/observed; `Secret.data` never read back |
| Gated destroy | `core/src/providers/v2/kube-apply.test.ts` + fake gate | `kubectl delete` only via Approval Gate + explicit desired removal; never on error; never `--prune` |
| `EnsureK3sSchema` unit | `core/src/domain/entities-v2.test.ts` | typed input; `role` enum; NO arbitrary command/script field accepted |
| `ensure_k3s` observe/apply/verify | `core/src/providers/v2/ensure-k3s.test.ts` + fake | absent ⇒ install (`changed:true`); present ⇒ no-op (`changed:false`); version-divergent ⇒ DRIFT (no upgrade argv); node Ready in verify |
| `k3s` idempotency (property) | `core/src/providers/v2/ensure-k3s.property.test.ts` | apply 2× ⇒ strict no-op for kind `k3s` |
| Fail-safe install-only | `core/src/providers/v2/ensure-k3s.test.ts` | k3s removed from desired ⇒ DRIFT; assert NO `k3s-uninstall.sh` / NO upgrade argv ever recorded |
| Wiring | `observed-adapter.test.ts`, `plan.test.ts`, `v2-wrap` test, `entrypoint-wiring.test.ts`, `mcp.test.ts`, `rest.test.ts`, `server.ts` test | `KIND_TABLE` carries `kube`/`k3s`; `V2_PLAN_ORDER` has `k3s` BEFORE `kube`; `byKind` routes both; `kube()` transport factory present; `v2Tools` reaches MCP from `server.ts` (gap fixed) |
| v1 FROZEN guard | `contract-conformance.test.ts` | `ALL_TOOLS.length === 12` byte-identical (NOT modified) |

CI runs unit + property with fakes on every commit. No real infra. No
`@live` surface added (unless a named `*.live.test.ts` is introduced).

---

## File structure (one responsibility per file)

```
core/
  src/
    domain/
      entities-v2.ts                   MODIFIED  + KubeManifestSchema, + EnsureK3sSchema
      entities-v2.test.ts              MODIFIED  schema unit cases
    providers/
      v2/
        kube-transport.ts              NEW       KubeTransport seam (analogous to docker-transport.ts)
        kube-transport.test.ts         NEW       argv assembly + secret-boundary
        kube-apply.ts                  NEW       KubernetesProvider: apply/observe/verify/destroy (kubectl-over-SSH)
        kube-apply.test.ts             NEW       apply/observe/verify/destroy + Secret.data redaction
        kube-apply.property.test.ts    NEW       idempotency property (kind kube)
        ensure-k3s.ts                  NEW       EnsureK3sProvider: observe/apply/verify (install-only)
        ensure-k3s.test.ts            NEW       absent→install / present→no-op / version-divergent→drift / no-uninstall
        ensure-k3s.property.test.ts    NEW       idempotency property (kind k3s)
    reconciler/
      observed-adapter.ts              MODIFIED  KIND_TABLE :33 + kube / k3s entries
      observed-adapter.test.ts         MODIFIED  kube/k3s slice cases
      plan.ts                          MODIFIED  V2_PLAN_ORDER :463 append "k3s","kube" (k3s BEFORE kube)
      plan.test.ts                     MODIFIED  ordering case (k3s before kube)
      v2-wrap.ts                       MODIFIED if needed  (byKind is map-driven; assert routing, may need no edit)
      v2-wrap.test.ts                  MODIFIED  kube/k3s routing case
      secret-apply.test.ts             MODIFIED  leak-sentinel for kubectl_apply path
    agent/
      capability.ts                    MODIFIED  V2_TOOLS :82 + "kubectl_apply","ensure_k3s"; ALL_TOOLS UNCHANGED
      capability.test.ts               MODIFIED if present  v2 vocabulary case
      v2/
        kubectl-apply.ts               NEW       kubectl_apply tool (template run-migrations.ts; isSensitive ()=>true)
        kubectl-apply.test.ts          NEW       deny-before-write / parse / gate-always / apply
        ensure-k3s.ts                  NEW       ensure_k3s tool (same template)
        ensure-k3s.test.ts             NEW       deny-before-write / parse / gate-always / apply
      mcp.ts                           MODIFIED  register kubectl_apply + ensure_k3s in tools/list + tools/call
      mcp.test.ts                      MODIFIED  v2 tool listing + call cases
      rest.ts                          MODIFIED  POST /api/v2/kube/apply + /api/v2/k3s/ensure
      rest.test.ts                     MODIFIED  REST route cases
      contract-conformance.test.ts     UNCHANGED ALL_TOOLS length 12 lock (:823) — verify, do NOT edit
    entrypoint-wiring.ts               MODIFIED  EntrypointTransports.kube() :124 + buildBootDeps pieces :422
    entrypoint-wiring.test.ts          MODIFIED  kube transport factory + pieces
    server.ts                          MODIFIED  pass v2Tools (+ kube/k3s deps) into createMcpServer :587 (GAP FIX)
  test/
    fakes/
      ssh-exec-recorder.ts             MODIFIED  script kubectl/k3s commands; expose recorded stdin
CHANGELOG.md                           MODIFIED  [Unreleased]
```

---

# Phase 1 — Workload: `KubernetesProvider` / `kubectl_apply`

**Phase goal:** an opaque k8s manifest envelope applies to a named host's
k3s via `kubectl apply -f -`, idempotent by content-hash annotation,
secrets resolved only at apply, `observe()` never reads `Secret.data`,
`destroy()` gated — and the tool is reachable on MCP+REST in production.
**Deliverable:** `kubectl_apply` v2 tool + `KubernetesProvider` + `kube`
kind wired data-driven. **Exit criteria:** Tasks 1–14 green;
`npm --prefix core run typecheck` clean; `ALL_TOOLS.length === 12`
untouched.

### Task 1 — `KubeManifestSchema` (envelope-only, opaque body)

- Files: `core/src/domain/entities-v2.ts` (modify — append schema),
  `core/src/domain/entities-v2.test.ts` (modify).
- [x] Familiarise: read `entities-v2.ts:1-60` (header + `KebabCaseString`
  + `SelectorSchema` conventions) and the spec §2.1 envelope table
  (`host` named ref, `apiVersion`, `kind`, `metadata.name`, `namespace`
  required, `body` opaque string).
- [x] Failing test (add to `entities-v2.test.ts`):
  - a valid envelope (`{ host: "prod-k3s", apiVersion: "apps/v1",
    kind: "Deployment", metadata: { name: "api" }, namespace: "bevox",
    body: "<yaml>" }`) `parse`s and the `body` round-trips
    byte-identical;
  - an arbitrary `kind` (e.g. `"ConfigMap"`, `"Service"`) is accepted
    (opaque — no kind enum);
  - a missing `namespace` (resp. missing `metadata.name`, missing `host`)
    `safeParse` → `success === false`;
  - `body` is a string (a non-string `body` is rejected).
- [x] Run `npm --prefix core test -- entities-v2.test.ts` → expect FAIL
  (`KubeManifestSchema` does not exist → assertion fails, not a bare
  import crash if you import the symbol the test references; ensure the
  test references the not-yet-exported name so the red is a real
  parse-shape mismatch once the export is added minimally).
- [x] Minimal impl: add `export const KubeManifestSchema = z.object({...})`
  — `host` (string, named ref; do NOT model credentials), `apiVersion`
  (string), `kind` (string), `metadata: z.object({ name: z.string() })`,
  `namespace` (string), `body` (string). Export
  `export type KubeManifest = z.infer<typeof KubeManifestSchema>`. No
  field-level k8s body validation (D2 — opaque).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): KubeManifestSchema — envelope-only, opaque body (1)`

### Task 2 — kube identity key helper (`kube:<host>/<namespace>/<kind>/<name>`)

- Files: `core/src/providers/v2/kube-apply.ts` (NEW — start with the key
  helper + types only), `core/src/providers/v2/kube-apply.test.ts` (NEW).
- [x] Familiarise: read the key convention in spec §2.1 and how v2
  providers shape `entity = `${kind}:${name}`` (e.g.
  `hetzner-load-balancer.ts:231`).
- [x] Failing test (add to `kube-apply.test.ts`): a pure
  `kubeIdentityKey(manifest)` returns
  `"kube:prod-k3s/bevox/Deployment/api"` for the Task-1 fixture; two
  manifests differing only by `host` produce DIFFERENT keys (Q-c: host in
  the key disambiguates).
- [x] Run `npm --prefix core test -- kube-apply.test.ts` → expect FAIL
  (module/symbol absent → add a minimal stub export so the red is the
  key-string assertion, not a missing-module crash).
- [x] Minimal impl: in `kube-apply.ts`, export
  `kubeIdentityKey(m: KubeManifest): string` =
  `` `kube:${m.host}/${m.namespace}/${m.kind}/${m.metadata.name}` ``.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): kube identity key kube:<host>/<ns>/<kind>/<name> (2)`

### Task 3 — extend the SSH-exec fake to script kubectl/k3s + expose stdin

- Files: `core/test/fakes/ssh-exec-recorder.ts` (modify),
  `core/test/fakes/ssh-exec-recorder.test.ts` (modify or add if present;
  else add a sibling test for the new capability).
- [x] Familiarise: read `ssh-exec-recorder.ts` in full — it implements
  the `SshRunner` seam `(conn, remoteArgv, opts?) => Promise<SshResult>`,
  records `{ conn, remoteArgv }` in `calls`, matches by argv predicate.
  Note `opts` is currently ignored (`_opts`); the kube transport pipes
  the manifest via `opts.stdin`, so the fake must RECORD stdin to assert
  the manifest never lands on argv.
- [x] Failing test (add): a call with `opts.stdin = "<manifest>"` records
  the stdin on the matching `SshExecCall`; a matcher keyed on
  `argv.includes("apply")` returns a scripted stdout
  (`"deployment.apps/api configured"`); the manifest string is NOT
  present anywhere in `remoteArgv` (argv-only — stdin carries the body).
- [x] Run `npm --prefix core test -- ssh-exec-recorder` → expect FAIL
  (`stdin` is not recorded on `SshExecCall`).
- [x] Minimal impl: extend `SshExecCall` with
  `readonly stdin?: string`; capture `_opts?.stdin` into the recorded
  call. Keep the existing matcher/default behaviour byte-identical;
  preserve `reset()`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): ssh-exec fake records stdin for kubectl-over-SSH (3)`

### Task 4 — `KubeTransport` seam (analogous to `DockerTransport`)

- Files: `core/src/providers/v2/kube-transport.ts` (NEW),
  `core/src/providers/v2/kube-transport.test.ts` (NEW).
- [x] Familiarise: read `core/src/providers/docker-transport.ts` (the
  seam shape + the SECRET-BOUNDARY contract: implementations MUST NOT
  echo the body/stdin in errors) and `core/src/providers/ssh-exec.ts`
  (`runSsh(conn, remoteArgv, opts)` — argv-only, `opts.stdin`, 0600 key
  in `finally`). The seam is OWNED by `src/` (port-ownership: production
  must not import from `test/`).
- [x] Failing test (add to `kube-transport.test.ts`): a
  `createKubeTransport({ run, conn })` built over the extended fake
  (Task 3) exposes `kubectl(args, stdin?)` (or an equivalent narrow
  method) that:
  - assembles the remote argv as
    `["kubectl", "--kubeconfig", "/etc/rancher/k3s/k3s.yaml", ...args]`
    (assert token-by-token against the recorder's `calls`);
  - pipes `stdin` (the manifest) via `opts.stdin`, NEVER as an argv token;
  - returns the runner's `{ code, stdout, stderr }`;
  - on a non-zero/255 failure, the thrown error message contains ONLY
    host + a scrubbed signal — NOT the stdin body (secret-boundary).
- [x] Run `npm --prefix core test -- kube-transport.test.ts` → expect
  FAIL (module absent → add a minimal export so the red is the argv/stdin
  assertion).
- [x] Minimal impl: in `kube-transport.ts`, declare
  `interface KubeTransport { kubectl(args, stdin?) }` (+ the
  `KubeTransportOptions` carrying the `SshRunner` + `SshConnection` +
  kubeconfig path default `/etc/rancher/k3s/k3s.yaml`) and a factory that
  drives `runSsh`. NO body in any error/log. Document the seam + the
  secret-boundary contract in the module header (mirror
  `docker-transport.ts`).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): KubeTransport seam — kubectl-over-SSH, manifest on stdin (4)`

### Task 5 — content-hash annotation `hetzner-mcp/manifest-hash` (pure)

- Files: `core/src/providers/v2/kube-apply.ts` (modify — add the hash +
  annotation injection helper), `core/src/providers/v2/kube-apply.test.ts`
  (modify).
- [x] Familiarise: re-read spec §2.3 + Q-b — the hash is the CANONICAL
  change-detection signal (kubectl stdout is secondary); it is a one-way
  digest that NEVER reveals a secret; `observe()` never resolves a secret.
- [x] Failing test (add): a pure `manifestHash(body: string): string`
  (use `node:crypto` `createHash("sha256")` — zero new dep) is
  deterministic (same body ⇒ same hash) and differs for a one-byte
  change; an `annotateManifest(body, hash)` helper injects
  `hetzner-mcp/manifest-hash: <hash>` into the manifest's
  `metadata.annotations` (assert the annotation key+value appear in the
  emitted YAML/JSON document the provider will pipe to kubectl) WITHOUT
  mutating any other field.
- [x] Run `npm --prefix core test -- kube-apply.test.ts` → expect FAIL
  (helpers absent → assertion mismatch once minimally exported).
- [x] Minimal impl: add `manifestHash` (sha256 hex of the body) and
  `annotateManifest` to `kube-apply.ts`. Keep them pure. NOTE for the
  executor: the hash is computed over the manifest in its plan/observe
  form (refs, not values) so it is stable and reveals nothing — secret
  resolution happens later in apply (Task 7); document this constraint
  inline.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): manifest content-hash annotation hetzner-mcp/manifest-hash (5)`

### Task 6 — `KubernetesProvider.observe()` (by identity; redact Secret.data)

- Files: `core/src/providers/v2/kube-apply.ts` (modify — add
  `createKubernetesProvider` + `observe`), `kube-apply.test.ts` (modify).
- [x] Familiarise: re-read spec §2.3 — `observe()` runs
  `kubectl get <kind> <name> -n <ns> -o json` by identity; read-only;
  builds an enriched observed slice (`{ key, payload }` shape — see
  `observed-adapter.ts`); for `kind === "Secret"` it MUST redact/skip the
  `data` field. Read `hetzner-load-balancer.ts:213-225` for the
  observe-returns-null-when-absent pattern.
- [x] Failing test (add): with the fake scripted to return a JSON object
  for `kubectl get Deployment api -n bevox -o json`, `observe(manifest)`
  returns an observed object carrying the live `hetzner-mcp/manifest-hash`
  annotation; a `kubectl get` that 404s → `observe` returns `null`; for a
  `Secret` manifest, the scripted `kubectl get Secret … -o json` carries
  a `data: { … }` block and `observe()` returns a payload with `data`
  ABSENT/redacted (assert the secret bytes are NOT in the returned
  payload). Assert `observe()` never calls any secret resolver (no
  `ApplyContext` is even passed to observe).
- [x] Run `npm --prefix core test -- kube-apply.test.ts` → expect FAIL.
- [x] Minimal impl: add `observe()` driving
  `transport.kubectl(["get", kind, name, "-n", ns, "-o", "json"])`,
  Zod-/guard-parse the stdout (no `as` on the wire), extract the
  annotation + identity, and for `kind === "Secret"` strip `data` before
  returning. Map a not-found exit/stderr → `null`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): KubernetesProvider.observe by identity; Secret.data redacted (6)`

### Task 7 — `KubernetesProvider.apply()` (no --prune; hash no-op; secret at apply)

- Files: `core/src/providers/v2/kube-apply.ts` (modify — add `apply`),
  `kube-apply.test.ts` (modify).
- [x] Familiarise: re-read spec §2.3 + §2.4. Read how `run_migrations`
  (`run-migrations.ts:307-352`) takes the apply seam optionally; read the
  `ApplyContext` / `SecretResolver` shape (`core/src/store/secrets.ts`)
  and how `docker.ts` resolves `secret:<ref>` ONLY in apply behind the
  token. The apply command is `kubectl apply -f -` (manifest on stdin),
  NEVER `--prune`.
- [x] Failing test (add):
  - FIRST apply (observe null OR hash mismatch): the provider pipes the
    annotated manifest to `kubectl apply -f -` (assert via the recorder:
    argv is exactly `["apply", "-f", "-"]` under the kubeconfig prefix,
    body on stdin, NO `--prune` token anywhere) and returns
    `changed:true`;
  - SECOND apply (observed carries the SAME `hetzner-mcp/manifest-hash`):
    `changed:false` and ZERO `kubectl apply` call is recorded (strict
    no-op driven by the hash, not by parsing stdout);
  - SECRET path: a `body` containing a `secret:<ref>` is resolved to the
    real value ONLY in the stdin piped at apply (inject a fake resolver +
    `ApplyContext`); with NO resolver/token the `secret:<ref>` stays a ref
    (apply still runs, ref unresolved — mirrors `docker.ts` 3.2 default).
- [x] Run `npm --prefix core test -- kube-apply.test.ts` → expect FAIL.
- [x] Minimal impl: add `apply(desired, observed, ctx?)`: compute hash,
  compare to `observed?.annotations["hetzner-mcp/manifest-hash"]`; equal ⇒
  `{ changed:false }` (no kubectl call); else resolve `secret:<ref>` in
  the body ONLY when `secretResolver` + `applyContext` present, annotate,
  pipe to `kubectl apply -f -`. Wrap any thrown error so a resolved value
  never appears in `.message`/`.cause` (the transport already scrubs
  stdin; double-guard here). NEVER `--prune`. NEVER delete on error.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): KubernetesProvider.apply — hash no-op, no --prune, secret at apply (7)`

### Task 8 — leak-sentinel: secret never escapes plan/observe/log/StateEvent

- Files: `core/src/reconciler/secret-apply.test.ts` (modify) and/or
  `core/src/providers/v2/kube-apply.test.ts` (modify).
- [x] Familiarise: read `secret-apply.test.ts` (the golden leak harness)
  and `.claude/rules/secrets-resolution.md` (sentinel string family
  `S3CR3T-…-must-never-leak-…` allowlisted only in test files via
  `.gitleaks.toml`).
- [x] Failing test (extend): drive the kube `apply()` with a `body`
  binding a SENTINEL secret value resolved ONLY behind the injected
  `ApplyContext`. Assert the sentinel value appears NOWHERE in: the
  computed `manifestHash` input/output, the `observe()` payload, any
  recorded argv, any captured log/StateEvent payload — only the
  `secret:<ref>` reference does. If it PASSES by construction (Task 7
  correct), it is a regression LOCK; if it FAILS, fix the leaking surface
  (do NOT weaken the assertion).
- [x] Run `npm --prefix core test -- secret-apply.test.ts` (and the kube
  test) → expect PASS (lock) or FAIL→fix.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): sentinel — kubectl_apply path leaks no resolved secret (8)`

### Task 9 — `verify()` + gated `destroy()` (no --prune, never on error)

- Files: `core/src/providers/v2/kube-apply.ts` (modify — add `verify` +
  `destroy`), `kube-apply.test.ts` (modify).
- [x] Familiarise: re-read spec §2.3 + §2.5 — `verify()` is read-only
  (`kubectl get` confirms reality == desired); `destroy()` runs
  `kubectl delete` ONLY when desired-state explicitly removes the
  manifest AND the Approval Gate approved; NEVER on an error path; NEVER
  `--prune`. Read the `LoadBalancerProvider.verify` (`:398-409`) shape and
  the fail-safe rule `.claude/rules/fail-safe.md`.
- [x] Failing test (add):
  - `verify(desired)` returns `true` when observe's live hash matches the
    desired hash, `false` otherwise; calls only `kubectl get` (no
    mutation argv recorded);
  - `destroy()` issues exactly
    `kubectl delete <kind> <name> -n <ns>` (assert argv; NO `--prune`)
    and returns `changed:true`;
  - a forced apply-error path records NO `kubectl delete` (fail-safe:
    never delete on error).
- [x] Run `npm --prefix core test -- kube-apply.test.ts` → expect FAIL.
- [x] Minimal impl: add `verify()` (hash compare via observe) and
  `destroy()` (`kubectl delete` by identity, no `--prune`). Keep
  `destroy()` reachable ONLY via the gated tool path (it is not called by
  the reconciler's apply on error).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): KubernetesProvider verify + gated destroy (no --prune) (9)`

### Task 10 — `kube` kind in the observed-adapter `KIND_TABLE`

- Files: `core/src/reconciler/observed-adapter.ts` (modify `KIND_TABLE`
  :33), `core/src/reconciler/observed-adapter.test.ts` (modify).
- [x] Familiarise: read `observed-adapter.ts` in full — `KIND_TABLE` maps
  `kind → { schema, collection }`; the adapter derives the kind from the
  key prefix (`entity.key.slice(0, idx)`), `safeParse`s, and SKIPS
  invalid/unknown (degrade-safe, never throws). NOTE: the `State`
  collection set (`servers`/`networks`/…/`backups`) is the v1 shape;
  Bloco E entities are v2 and are reconciled per-entity via the wrapped
  provider's `verify()`, NOT via this v1 `State` snapshot — so the adapter
  must remain degrade-safe for a `kube:` key it does not have a v1
  collection for. Decide minimally: add a `kube` entry ONLY if the spec's
  KIND_TABLE row (§4 row 1) requires a payload schema there; otherwise
  the correct behaviour is the existing degrade-safe SKIP.
- [x] Failing test (add): an `ObservedSlice` carrying a `kube:…` entry is
  handled WITHOUT throwing and WITHOUT corrupting the v1 `State` (the
  `kube` entry does not land in any v1 collection); `StateSchema.parse`
  of the result still succeeds. If the spec intends a dedicated observed
  channel for `kube`, assert it via the agreed shape; otherwise assert the
  degrade-safe SKIP is intentional and load-bearing.
- [x] Run `npm --prefix core test -- observed-adapter.test.ts` → expect
  FAIL (if a new entry/behaviour is required) or PASS-as-lock (degrade-safe
  already holds — then the test pins the intended behaviour as a
  regression guard).
- [x] Minimal impl: extend `KIND_TABLE` per the spec's intended channel,
  OR leave the adapter untouched and lock the degrade-safe SKIP. Keep the
  adapter pure, total, degrade-safe (never throws).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): observed-adapter handles kube kind (degrade-safe) (10)`

### Task 11 — `byKind` routing for `kube` + StateEvent actor through the wrapper

- Files: `core/src/reconciler/v2-wrap.test.ts` (modify;
  `v2-wrap.ts` modify ONLY if a routing gap surfaces).
- [x] Familiarise: read `v2-wrap.ts` — `createCompositeProvider({ byKind,
  fallback })` routes a `PlanAction` by the `<kind>:` prefix; the wrapper
  unpacks `action.desired` as the typed payload and propagates through
  apply/verify. The actor rides on the `ApplyContext` threaded by the
  reconciler (`.claude/rules/state-event-actor.md`); the provider does NOT
  synthesise it.
- [x] Failing test (add): a composite built with `byKind: { kube:
  wrappedKubeProvider }` routes a `PlanAction{ entity: "kube:prod-k3s/…"
  }` to the kube provider (assert the kube provider's apply was called,
  the fallback was not); a v1 `server:web` action still flows to the
  fallback (no regression). Assert the emitted StateEvent (or the apply
  result the wrapper returns) carries the actor sourced from the
  reconciler context, never a locally-synthesised one.
- [x] Run `npm --prefix core test -- v2-wrap` → expect FAIL (if the
  wrapper needs a kube-shaped `observeArg`/unpack adjustment) or
  PASS-as-lock (map-driven routing already supports it — the test pins
  it).
- [x] Minimal impl: only if a gap surfaces — register the kube wrapper in
  the `byKind` construction site; otherwise no production change (routing
  is data-driven). Do NOT touch `reconcile.ts` / `apply.ts`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): composite routes kube kind; actor flows from ApplyContext (11)`

### Task 12 — `V2_PLAN_ORDER` includes `kube` (after the host kind)

- Files: `core/src/reconciler/plan.ts` (modify `V2_PLAN_ORDER` :463),
  `core/src/reconciler/plan.test.ts` (modify).
- [x] Familiarise: read `plan.ts:457-514` (`V2_PLAN_ORDER` is the single
  source of truth for v2 DAG order; `planV2`/`desiredPayloadsV2` iterate
  it). The host kind `k3s` must come BEFORE the workload kind `kube` (the
  host needs k3s up before workload applies). In this Phase-1 task add
  `"kube"`; Task 18 adds `"k3s"` BEFORE it (the ordering assertion is
  locked in Task 18 once both exist).
- [x] Failing test (add to `plan.test.ts`): given v2 working sources for
  `kube`, `planV2` emits the kube PlanItem(s) in deterministic order after
  the existing v2 kinds.
- [x] Run `npm --prefix core test -- plan.test.ts` → expect FAIL
  (`"kube"` absent from `V2_PLAN_ORDER`).
- [x] Minimal impl: append `"kube"` to `V2_PLAN_ORDER`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): V2_PLAN_ORDER includes kube (12)`

### Task 13 — idempotency property for kind `kube` (apply 2× ⇒ strict no-op)

- Files: `core/src/providers/v2/kube-apply.property.test.ts` (NEW).
- [x] Familiarise: read an existing v2 idempotency property test
  (e.g. `core/src/reconciler/idempotency-load-balancer.property.test.ts`
  if present, or the conformance harness `provider.ts:245` referenced by
  the spec §5 #2) for the apply-twice → zero-mutation shape.
- [x] Failing test (add): for a generated valid `KubeManifest`, apply
  once (observe null) ⇒ `changed:true` and one `kubectl apply`; feed the
  resulting observed (carrying the live hash) back and apply again ⇒
  `changed:false` and ZERO `kubectl apply` recorded. Assert across a
  range of manifests (different kinds/names/bodies) that the 2nd pass is
  ALWAYS a strict no-op.
- [x] Run `npm --prefix core test -- kube-apply.property.test.ts` →
  expect FAIL until the hash no-op (Task 7) is exercised property-wide
  (or PASS-as-lock — then confirm red→green by temporarily breaking the
  hash compare locally; do NOT commit the break).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): idempotency property — kube apply 2× is a strict no-op (13)`

### Task 14 — `kubectl_apply` tool: V2_TOOLS + tool module + MCP/REST registration

- Files: `core/src/agent/capability.ts` (modify `V2_TOOLS` :82),
  `core/src/agent/v2/kubectl-apply.ts` (NEW),
  `core/src/agent/v2/kubectl-apply.test.ts` (NEW),
  `core/src/agent/mcp.ts` (modify), `core/src/agent/rest.ts` (modify),
  `core/src/agent/mcp.test.ts` (modify), `core/src/agent/rest.test.ts`
  (modify). Verify `contract-conformance.test.ts:823` stays green
  (do NOT edit).
- [x] Familiarise: read `run-migrations.ts` END-TO-END (the v2-tool
  template: deny-before-write via `assertV2Capability`, FROZEN-schema
  parse, always-sensitive Approval Gate via `makeGate(() => true)`, actor
  from `ApplyContext`, no-throw error envelope) and its MCP registration
  (`mcp.ts:898-938`) + REST route (`rest.ts:1028-1060`,
  `POST /api/v2/migrations`). Read `capability.ts:82-95` (`V2_TOOLS` +
  `V2_TOOL_SET` + `mintVerifiedCredential` filters into the known
  vocabulary).
- [x] Failing test (add to `capability.test.ts` if present, else
  `kubectl-apply.test.ts`): `mintVerifiedCredential("agent:x",
  ["kubectl_apply"])` grants the v2 cap; `ALL_TOOLS` still has length 12
  (assert the FROZEN lock from this test too). Add `kubectl-apply.test.ts`
  cases: out-of-scope credential ⇒ deny-before-write error envelope (no
  apply, no StateEvent); valid call routes through the Approval Gate on
  EVERY invocation (assert the gate `evaluate` was consulted); a denial
  ⇒ `pending_approval` envelope. Add `mcp.test.ts` + `rest.test.ts` cases:
  with `v2Tools` containing `"kubectl_apply"`, `tools/list` advertises it
  and `tools/call` / `POST /api/v2/kube/apply` reach the shared function.
- [x] Run the relevant tests → expect FAIL (`"kubectl_apply"` not in
  `V2_TOOLS`; tool module + routes absent).
- [x] Minimal impl:
  - `capability.ts`: add `"kubectl_apply"` to `V2_TOOLS`. Leave
    `ALL_TOOLS` byte-identical.
  - `kubectl-apply.ts`: a single `kubectlApply(input, ctx, deps)` (template
    `run-migrations.ts`): deny-before-write, parse via
    `KubeManifestSchema`, resolve the named `host` to a server-side SSH
    config via a deps seam (credential NEVER in input — Q-c), namespace
    precondition check (Q-d: missing namespace ⇒ precondition error,
    never created), always-sensitive gate, then drive the
    `KubernetesProvider.apply` behind the per-call `ApplyContext`. No
    throw — contract error envelope. `isSensitive: () => true` is the
    CALLER's wiring contract.
  - `mcp.ts`: register the tool in `listToolsResult` + the `tools/call`
    dispatch, gated by `v2Tools.has("kubectl_apply")` (mirror the
    `run_migrations` block).
  - `rest.ts`: add `POST /api/v2/kube/apply` routing to the same shared
    function.
- [x] Run → expect PASS, including `contract-conformance.test.ts` green
  UNCHANGED. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): kubectl_apply v2 tool — schema parse, always-gated, MCP+REST (14)`

**Done (Phase 1) =** `kubectl_apply` applies an opaque manifest to a named
host's k3s via `kubectl apply -f -` (never `--prune`), idempotent by
`hetzner-mcp/manifest-hash`, secrets resolved only at apply, `observe()`
redacts `Secret.data`, `destroy()` gated, the kind is wired data-driven,
the tool is reachable on MCP+REST, and `ALL_TOOLS` stays 12.

---

# Phase 2 — Host: `ensure_k3s` (install-only)

**Phase goal:** `ensure_k3s` installs k3s on a named host install-only —
present ⇒ strict no-op, version-divergent ⇒ DRIFT (no auto-upgrade),
removed-from-desired ⇒ DRIFT (never `k3s-uninstall.sh`). **Deliverable:**
`ensure_k3s` v2 tool + `EnsureK3sProvider` + `k3s` kind wired (ordered
BEFORE `kube`). **Exit criteria:** Tasks 15–23 green;
`npm --prefix core run typecheck` clean; `ALL_TOOLS.length === 12`
untouched.

### Task 15 — `EnsureK3sSchema` (typed, restricted — no arbitrary command)

- Files: `core/src/domain/entities-v2.ts` (modify — append schema),
  `core/src/domain/entities-v2.test.ts` (modify).
- [x] Familiarise: re-read spec §3.1 — `host` (named ref), `version`
  (channel/tag string), `role: "server" | "agent"`, additional TYPED
  recipe fields only; NEVER a `command`/`script` free-exec field (D7).
- [x] Failing test (add): a valid `{ host: "prod-k3s", version:
  "v1.30.2+k3s1", role: "server" }` `parse`s; `role` outside the enum is
  rejected; an input carrying a `command`/`script`/`exec` field is NOT
  silently accepted as a passthrough (the schema is strict — assert
  unknown free-exec keys are stripped or rejected, locking D7 at the
  schema boundary).
- [x] Run `npm --prefix core test -- entities-v2.test.ts` → expect FAIL.
- [x] Minimal impl: add `export const EnsureK3sSchema = z.object({ host:
  z.string(), version: z.string(), role: z.enum(["server","agent"]),
  … })` (`.strict()` to reject unknown keys — D7), + `export type
  EnsureK3s = z.infer<…>`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): EnsureK3sSchema — typed, restricted, no free-exec (15)`

### Task 16 — `EnsureK3sProvider.observe()` (reuse KubeTransport)

- Files: `core/src/providers/v2/ensure-k3s.ts` (NEW),
  `core/src/providers/v2/ensure-k3s.test.ts` (NEW).
- [x] Familiarise: re-read spec §3.2 — `observe()` runs `k3s --version`
  / `systemctl is-active k3s` / `kubectl get nodes` on the host → state
  (installed? which version? node Ready?). Reuse the `KubeTransport`
  (Task 4) for the SSH command channel (or a thin sibling transport
  method `run(argv)` — minimal). The identity key is `k3s:<host>`.
- [x] Failing test (add): with the fake scripted so `k3s --version`
  returns `"k3s version v1.30.2+k3s1"` and `systemctl is-active k3s`
  returns `"active"`, `observe(desired)` returns an observed object with
  `installed:true`, `version:"v1.30.2+k3s1"`; with `k3s --version`
  exiting non-zero (absent), `observe` returns `installed:false`.
- [x] Run `npm --prefix core test -- ensure-k3s.test.ts` → expect FAIL.
- [x] Minimal impl: add `createEnsureK3sProvider({ transport })` with
  `observe()` parsing the three command outputs (guard-parse, no `as`).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): EnsureK3sProvider.observe — version/active/node-ready (16)`

### Task 17 — `apply()` install-only + version-divergence DRIFT (Q-a) + `verify()`

- Files: `core/src/providers/v2/ensure-k3s.ts` (modify — add `apply` +
  `verify`), `ensure-k3s.test.ts` (modify).
- [x] Familiarise: re-read spec §3.2 + §3.3 + Q-a — `apply()` runs the
  install recipe ONLY when k3s is ABSENT; present ⇒ `changed:false`;
  version-divergent ⇒ DRIFT (NO upgrade, the install recipe does NOT run);
  `verify()` ⇒ node Ready. The provider OWNS the recipe (no input
  command). Read the fail-safe rule and the `LoadBalancerProvider` drift
  channel (`plan` op `"drift"`) for the drift-shape precedent.
- [x] Failing test (add):
  - ABSENT (`observe` installed:false) ⇒ `apply` runs the install recipe
    (assert the recorded argv is the recipe — e.g. the documented
    `curl … | sh -s - <role>` style command vector, argv-only, NEVER an
    input-supplied string) and returns `changed:true`;
  - PRESENT same version ⇒ `apply` runs NO install argv and returns
    `changed:false` (strict no-op);
  - VERSION-DIVERGENT (`observed.version !== desired.version`) ⇒ `apply`
    reports DRIFT and runs NO install/upgrade argv (assert ZERO install
    command recorded; assert the result/plan surfaces drift, never
    `changed:true`);
  - `verify(desired)` ⇒ true only when `kubectl get nodes` shows the node
    Ready.
- [x] Run `npm --prefix core test -- ensure-k3s.test.ts` → expect FAIL.
- [x] Minimal impl: add `apply()` (install-only branch + drift branch +
  no-op branch) and `verify()`. The recipe is an internal constant argv
  vector. NO upgrade path. NO uninstall path.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): ensure_k3s apply install-only; version-divergent ⇒ drift (17)`

### Task 18 — fail-safe install-only: removed-from-desired ⇒ DRIFT; never uninstall

- Files: `core/src/providers/v2/ensure-k3s.ts` (modify if needed),
  `ensure-k3s.test.ts` (modify).
- [x] Familiarise: re-read spec §3.3 + Q-a — k3s removed from desired ⇒
  DRIFT reported, NEVER `k3s-uninstall.sh`; no gated uninstall in this
  spec. Read `.claude/rules/fail-safe.md` (forbidden: destroy on error /
  heuristic teardown).
- [x] Failing test (add): across every code path exercised in
  Tasks 16–17 (absent, present, version-divergent, and a
  desired-removed/observe-only scenario), assert the recorder's argv
  NEVER contains `k3s-uninstall.sh` (nor any `uninstall`/`upgrade`
  token); a "k3s observed but not in desired" reconcile yields a DRIFT
  result, not a teardown. This is the install-only INVARIANT LOCK.
- [x] Run `npm --prefix core test -- ensure-k3s.test.ts` → expect PASS
  (lock — Task 17 already install-only) or FAIL→fix if any path issues a
  forbidden command.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): ensure_k3s install-only — never uninstall/upgrade (drift only) (18)`

### Task 19 — `k3s` kind in KIND_TABLE + `V2_PLAN_ORDER` BEFORE `kube`

- Files: `core/src/reconciler/observed-adapter.ts` (modify if a channel
  is needed), `core/src/reconciler/plan.ts` (modify `V2_PLAN_ORDER`),
  `core/src/reconciler/observed-adapter.test.ts` (modify),
  `core/src/reconciler/plan.test.ts` (modify).
- [x] Familiarise: re-read the Task 10 + Task 12 notes — `k3s` follows the
  same degrade-safe adapter treatment; the ORDERING gate is the
  load-bearing assertion HERE: `k3s` MUST precede `kube` in
  `V2_PLAN_ORDER` (host up before workload).
- [x] Failing test (add to `plan.test.ts`): with v2 working sources for
  BOTH `k3s` and `kube`, `planV2` emits the `k3s` PlanItem(s) BEFORE the
  `kube` PlanItem(s) (assert the index of `k3s:<host>` < the index of
  `kube:…`). Add the adapter degrade-safe case for a `k3s:` key (mirrors
  Task 10).
- [x] Run `npm --prefix core test -- plan.test.ts` → expect FAIL
  (`"k3s"` absent from `V2_PLAN_ORDER`, or ordered wrong).
- [x] Minimal impl: insert `"k3s"` into `V2_PLAN_ORDER` at a position
  BEFORE `"kube"`; extend `KIND_TABLE`/degrade-safe handling for `k3s` per
  the agreed channel.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): V2_PLAN_ORDER puts k3s before kube; k3s kind wired (19)`

### Task 20 — `byKind` routing for `k3s`; actor through the wrapper

- Files: `core/src/reconciler/v2-wrap.test.ts` (modify; `v2-wrap.ts`
  modify only if a gap surfaces).
- [x] Familiarise: re-read Task 11 — same data-driven routing; the
  `k3s:<host>` key routes to the wrapped `EnsureK3sProvider`; actor from
  `ApplyContext`.
- [x] Failing test (add): composite with `byKind: { k3s:
  wrappedEnsureK3s, kube: wrappedKube }` routes a `k3s:<host>` action to
  the k3s provider and a `kube:…` action to the kube provider; v1 actions
  still fall through. Assert the StateEvent/apply-result actor flows from
  the reconcile context.
- [x] Run `npm --prefix core test -- v2-wrap` → expect FAIL or
  PASS-as-lock (routing is map-driven).
- [x] Minimal impl: only if a gap surfaces. Do NOT touch
  `reconcile.ts` / `apply.ts`.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): composite routes k3s kind; actor flows from ApplyContext (20)`

### Task 21 — `kube()` transport factory in EntrypointTransports + buildBootDeps

- Files: `core/src/entrypoint-wiring.ts` (modify
  `EntrypointTransports` :124 + `buildBootDeps` pieces :422),
  `core/src/entrypoint-wiring.test.ts` (modify).
- [x] Familiarise: read `entrypoint-wiring.ts:124-127`
  (`EntrypointTransports { docker(); wireguard(); restic(); }`) and
  `:276` (`transports.docker(config)`) + the `buildBootDeps` return
  (`:422-437`, where `setFirewallPieces` / `runMigrationsPieces` are
  assembled). Read how `server.ts` consumes those pieces (`:499-575`).
- [x] Failing test (add to `entrypoint-wiring.test.ts`): a stub
  `transports.kube(config)` is invoked by `buildBootDeps`, and the built
  `BootDeps` carries the kube/k3s pieces (the `KubeTransport` +
  host-config resolution seam) needed to assemble the two tools'
  deps in `server.ts`. Mirror the `runMigrationsPieces` regression
  pattern.
- [x] Run `npm --prefix core test -- entrypoint-wiring.test.ts` →
  expect FAIL (`kube` not on `EntrypointTransports`; pieces absent).
- [x] Minimal impl: add `kube(config: Config): KubeTransport` to
  `EntrypointTransports`; build it once in `buildBootDeps` and expose the
  `kube`/`k3s` pieces (transport + host-config resolver) on the return
  object (mirror `runMigrationsPieces`). The seam is injectable: tests
  pass a fake; production plugs the SSH-backed transport.
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `feat(core): kube() transport factory + buildBootDeps pieces (21)`

### Task 22 — idempotency property for kind `k3s` (apply 2× ⇒ strict no-op)

- Files: `core/src/providers/v2/ensure-k3s.property.test.ts` (NEW).
- [x] Familiarise: re-read Task 13's property shape.
- [x] Failing test (add): for a generated `EnsureK3s` + an observed state
  where k3s is PRESENT at the desired version, apply ⇒ `changed:false`
  and ZERO install argv; for ABSENT, apply once ⇒ `changed:true`, then
  feed back the resulting present observed and apply again ⇒
  `changed:false`, zero install argv. Strict no-op on the 2nd pass across
  the generated range.
- [x] Run `npm --prefix core test -- ensure-k3s.property.test.ts` →
  expect PASS (after Task 17) or confirm red→green by temporarily
  forcing apply to always install locally (do NOT commit).
- [x] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [x] Commit: `test(core): idempotency property — ensure_k3s apply 2× strict no-op (22)`

### Task 23 — `ensure_k3s` tool: V2_TOOLS + tool module + MCP/REST + server.ts gap fix

- Files: `core/src/agent/capability.ts` (modify `V2_TOOLS`),
  `core/src/agent/v2/ensure-k3s.ts` (NEW),
  `core/src/agent/v2/ensure-k3s.test.ts` (NEW),
  `core/src/agent/mcp.ts` (modify), `core/src/agent/rest.ts` (modify),
  `core/src/agent/mcp.test.ts` (modify), `core/src/agent/rest.test.ts`
  (modify), `core/src/server.ts` (modify — THE GAP FIX, :587),
  `core/src/server.ts`'s test file (modify). Verify
  `contract-conformance.test.ts:823` stays green (do NOT edit).
- [x] Familiarise: re-read `run-migrations.ts` template + Task 14's MCP/REST
  registration. CRITICAL: read `server.ts:577-592` — `createMcpServer({…})`
  is called WITHOUT `v2Tools`, so `mcp.ts:606-607` defaults to an EMPTY
  set and NO v2 tool is reachable in the daemon. This task fixes that by
  threading `v2Tools` (containing the granted v2 set, incl. the prior 8 +
  the 2 new) plus the kube/k3s deps into `createMcpServer` (and the kube
  deps into `createRestServer`).
- [x] Failing test (add):
  - `capability` / `ensure-k3s.test.ts`: `mintVerifiedCredential(…,
    ["ensure_k3s"])` grants the cap; `ALL_TOOLS` length still 12;
    deny-before-write / always-gated / `pending_approval` cases (template
    `run-migrations`).
  - `mcp.test.ts` + `rest.test.ts`: with `v2Tools` containing
    `"ensure_k3s"`, the tool is listed/callable; `POST /api/v2/k3s/ensure`
    reaches the shared function.
  - `server.ts` test (the GAP-FIX regression guard): a server built via
    `server.ts` advertises the v2 tools on MCP (e.g. `kubectl_apply` /
    `ensure_k3s` appear in `tools/list`) — proving `server.ts` now passes
    `v2Tools`. This RED proves the gap (empty set today ⇒ tool absent).
- [x] Run the relevant tests → expect FAIL (`"ensure_k3s"` not in
  `V2_TOOLS`; tool/routes absent; `server.ts` does not pass `v2Tools`).
- [x] Minimal impl:
  - `capability.ts`: add `"ensure_k3s"` to `V2_TOOLS`. `ALL_TOOLS`
    byte-identical.
  - `ensure-k3s.ts` tool: `ensureK3s(input, ctx, deps)` (template
    `run-migrations.ts`): deny-before-write, parse via `EnsureK3sSchema`,
    resolve the named `host` server-side, always-sensitive gate, drive
    `EnsureK3sProvider.apply` behind `ApplyContext`. No-throw envelope.
    `isSensitive: () => true`.
  - `mcp.ts` + `rest.ts`: register both (`kubectl_apply` already from
    Task 14; add `ensure_k3s`) and the `POST /api/v2/k3s/ensure` route.
  - `server.ts`: assemble the kube/k3s tool deps from the
    `buildBootDeps` pieces (Task 21) — the always-sensitive gate via
    `createApprovalGate({ isSensitive: () => true })`, the host-config
    resolver, the providers — and PASS `v2Tools` (the granted v2 set) +
    the new deps into `createMcpServer` and the kube deps into
    `createRestServer`. THIS is the gap fix.
- [x] Run → expect PASS, including `contract-conformance.test.ts` green
  UNCHANGED and the `server.ts` gap-fix guard green.
  `npm --prefix core run typecheck` → clean. Run the FULL suite
  `npm --prefix core test`.
- [x] Commit: `feat(core): ensure_k3s v2 tool; wire v2Tools into server.ts (gap fix) (23)`

**Done (Phase 2) =** `ensure_k3s` installs k3s install-only (present ⇒
no-op, version-divergent ⇒ drift, never uninstall/upgrade), the `k3s` kind
is wired BEFORE `kube`, both v2 tools are reachable on MCP+REST in the
production daemon (the `server.ts` `v2Tools` gap is fixed), and
`ALL_TOOLS` stays 12.

---

### Task 24 — Docs: CHANGELOG `[Unreleased]`

- Files: `CHANGELOG.md` (modify).
- [x] Familiarise: read the top `[Unreleased]` entry of `CHANGELOG.md`.
- [x] No test (docs-only; exempt per `.claude/rules/specs-first.md`
  "trivial / docs" and `tdd-required.md` out-of-scope).
- [x] Edit `CHANGELOG.md` `[Unreleased]`: an "Added" entry citing
  `2026-06-12-bloco-e-kubernetes-k3s-provider.md` — v2 Bloco E adds
  Kubernetes/k3s management via `kubectl_apply` (opaque manifest over
  kubectl-over-SSH, idempotent by content-hash, never `--prune`, secrets
  at apply only, `Secret.data` never read back, gated destroy) and
  `ensure_k3s` (install-only; version-divergence ⇒ drift, never
  auto-upgrade/uninstall); both approval-always; note the `server.ts`
  `v2Tools` gap fix that made the whole v2 tool surface reachable in
  production.
- [x] Run `npm --prefix core run typecheck` (no-op sanity) and full
  `npm --prefix core test` → expected green; confirm
  `contract-conformance.test.ts` (`ALL_TOOLS` length 12) untouched.
- [x] Commit: `docs: v2 Bloco E — kubectl_apply + ensure_k3s (kubectl-over-SSH) (24)`

---

## Acceptance criteria (spec §7)

- [x] `npm --prefix core run typecheck` introduces NO new errors beyond
      the known baseline; `npm --prefix core test` green.
- [x] `V2_TOOLS` includes `kubectl_apply` and `ensure_k3s`; `ALL_TOOLS`
      (12 v1) byte-identical; `contract-conformance.test.ts:823` green
      WITHOUT modification.
- [x] `KubeManifestSchema` validates the envelope (incl. `host` as a named
      ref, Q-c) and carries the opaque `body`; accepts arbitrary k8s
      `kind`; missing `namespace` ⇒ precondition error, never created
      (Q-d).
- [x] `KubernetesProvider.apply` → `kubectl apply -f -` with NO `--prune`;
      idempotency via `hetzner-mcp/manifest-hash` (Q-b); 2nd pass = strict
      no-op (property test green for kind `kube`, Task 13).
- [x] `observe()` never reads `Secret.data`; the observed payload carries
      refs only; leak-sentinel extended and green (Task 8).
- [x] `destroy()` only via Approval Gate + explicit desired removal; no
      delete on any error path; no `--prune` anywhere (Task 9).
- [x] `EnsureK3sSchema` typed, no free-exec field (D7); provider
      install-only (Tasks 15, 17, 18).
- [x] `ensure_k3s` idempotent (property test green for kind `k3s`,
      Task 22); k3s removed ⇒ drift, NEVER `k3s-uninstall.sh` (argv
      assert, Task 18); version-divergent ⇒ drift, NEVER auto-upgrade
      (Q-a, Task 17).
- [x] Both tools `isSensitive: () => true` (Approval-always); StateEvent
      records the actor via `ApplyContext` (Tasks 11, 20).
- [x] Data-driven wiring: `KIND_TABLE`, `V2_PLAN_ORDER` (`k3s` BEFORE
      `kube`), `byKind`, `kube()` transport, MCP+REST registration,
      `v2Tools` threaded into `server.ts` (gap fixed, Task 23);
      `reconcile.ts` / `apply.ts` UNCHANGED.
- [x] The extended `ssh-exec-recorder.ts` scripts the `kubectl`/`k3s`
      commands; zero real infra in CI.
- [x] `CHANGELOG.md` `[Unreleased]` (Task 24).

---

## Risks

1. **Secret leak in the now-apply-resolving kube path (HIGH).** The
   opaque `body` may carry `secret:<ref>`; resolution at apply pipes the
   value over SSH stdin. Mitigation: resolve ONLY behind `ApplyContext`;
   `observe()`/hash never resolve; the transport + provider scrub the body
   from all errors/logs (secret-boundary, mirrors `ssh-exec.ts`);
   leak-sentinel test (Task 8).
2. **Idempotency flap on the hash signal (HIGH).** If the hash is computed
   over a different form at apply vs observe (pre- vs post-resolution),
   the 2nd pass re-applies forever. Mitigation: Q-b fixes the hash as the
   canonical signal computed over the plan/observe form (refs, not
   values); property test apply-2×-no-op (Task 13).
3. **`server.ts` gap regression (MEDIUM).** v2 tools are unreachable in
   production today because `server.ts` omits `v2Tools`. Mitigation: the
   gap fix (Task 23) has an explicit regression guard asserting the v2
   tools appear in the daemon's `tools/list`.
4. **Accidental fail-deleting (HIGH if it happens).** `--prune` or an
   error-path delete / k3s uninstall would destroy operator resources.
   Mitigation: argv asserts that NO `--prune`, NO `kubectl delete` on
   error, NO `k3s-uninstall.sh`/`upgrade` token is ever recorded
   (Tasks 9, 18); `.claude/rules/fail-safe.md`.
5. **Thin SSH fake masks real argv (MEDIUM).** A fake that does not record
   stdin/argv faithfully would let provider tests pass while production
   breaks. Mitigation: fake fidelity first (Task 3, `fakes-author`
   discipline); argv-by-token + stdin assertions throughout.
6. **k3s removed from desired (MEDIUM).** Could be mistaken for a teardown
   request. Mitigation: install-only invariant — removed ⇒ DRIFT, never
   uninstall (Task 18); teardown is a future spec (spec §9).
7. **Console contract drift (LOW).** Bloco E adds no console wire field;
   flag the new v2 schemas for contract-oracle review (goal ZERO new
   console field).

## Rollback notes

Each task is one commit; rollback is `git revert` of the offending
commit(s):

- **Task 23 alone** un-wires `v2Tools` from `server.ts` and removes the
  `ensure_k3s` tool ⇒ the daemon reverts to the pre-fix behaviour (no v2
  tools reachable) while all provider/schema code stays dormant and AS-IS.
  Reverting Task 14 additionally removes `kubectl_apply`.
- **Tasks 5–9, 16–18** (provider behaviour) are inert without the tool +
  wiring; reverting them is isolated.
- **Tasks 10, 12, 19** (`KIND_TABLE` / `V2_PLAN_ORDER`) are additive map
  mutations; reverting drops the kinds from the plan/adapter with no v1
  regression (degrade-safe SKIP for any stray key).
- **Tasks 1, 2, 15** (schemas/helpers) are leaf additions; safe to revert
  once the dependents are reverted.
- **Tasks 3, 4** (fake + transport) are test/seam infrastructure; inert
  without the providers.

No migration, no console contract change ⇒ no data or wire rollback
concern. No destructive operation is ever issued on an error path (apply
never `--prune`/deletes; `ensure_k3s` never uninstalls), so there is
nothing to clean up on revert.

---

## Fora de escopo / depende de credenciais reais (spec §9)

- Edge Cloudflare / `cloudflared` on the host — separate axis; the MCP
  edge stays Hetzner-native (`expose_service` / `set_ingress`).
- Generic arbitrary-command-on-host mechanism (`ensure_k3s` is typed and
  restricted — D7).
- Multi-cluster / multi-host targeting — assumes the current SSH host
  config (the `host` ref is forward-compatible but targeting is deferred).
- Helm.
- k3s uninstall / host teardown (uninstall = fail-deleting — D3/D7).
- In-place k3s upgrade (Q-a): version-divergence ⇒ drift only here; gated
  upgrade with a tested recipe is a future spec.
- WireGuard mesh crypto real (stays stub).
- B2 (kube-apiserver client via kubeconfig/TLS) — B1 (kubectl-over-SSH)
  adopted; B2 deferred.
- Any `@live` k3s/SSH test — not added by this plan (lives only under
  `core/test/live/*.live.test.ts` if introduced, excluded from `npm test`).

## Done = (per phase, summary)

- **Phase 1 (Tasks 1–14):** `kubectl_apply` applies an opaque manifest to
  a named host's k3s via `kubectl apply -f -` (never `--prune`), idempotent
  by `hetzner-mcp/manifest-hash`, secrets resolved only at apply, `observe()`
  redacts `Secret.data`, `destroy()` gated, the `kube` kind wired
  data-driven, the tool reachable on MCP+REST, `ALL_TOOLS` stays 12.
- **Phase 2 (Tasks 15–23):** `ensure_k3s` installs k3s install-only
  (present ⇒ no-op, version-divergent ⇒ drift, never uninstall/upgrade),
  the `k3s` kind wired BEFORE `kube`, both tools reachable in the daemon
  (the `server.ts` `v2Tools` gap fixed), `ALL_TOOLS` stays 12.
- **Task 24:** `CHANGELOG.md` `[Unreleased]` records Bloco E + the
  `server.ts` gap fix.
