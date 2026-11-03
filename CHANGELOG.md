# Changelog

All notable changes to bevox-hetzner-mcp are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — v2 Bloco E: Kubernetes/k3s provider (kubectl-over-SSH)

**Spec:** `docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md` (Aceita
2026-06-12). First-class Kubernetes/k3s management, added entirely via the
v2-additive path — the 12 v1 tools stay FROZEN and byte-identical
(`contract-conformance.test.ts` `ALL_TOOLS.length === 12` unchanged). Two
new approval-always v2 tools (`V2_TOOLS` grows 8 → 10).

- **`kubectl_apply`** (MCP `tools/call` + REST `POST /api/v2/kube/apply`)
  applies an opaque k8s manifest envelope to a named host's k3s via
  `kubectl apply -f -` over the existing argv-only SSH seam (zero new deps —
  no `ssh2`, no k8s SDK). `KubeManifestSchema` validates only the envelope
  (`host` named ref, `apiVersion`, `kind`, `metadata.name`, `namespace`); the
  YAML `body` rides opaque. Idempotent by a `hetzner-mcp/manifest-hash`
  content-hash annotation (a 2nd apply with a matching hash is a strict
  no-op — zero `kubectl` calls); NEVER `--prune`; a gated `destroy()` is the
  only delete path. `secret:<ref>` in the body is resolved ONLY at apply
  behind the unforgeable `ApplyContext`; `observe()` returns a minimal
  secret-free projection (identity + hash only) and never reads back a
  `Secret`'s `data` nor the `kubectl.kubernetes.io/last-applied-configuration`
  annotation. Namespace must pre-exist (precondition; never silently created).
- **`ensure_k3s`** (MCP + REST `POST /api/v2/k3s/ensure`) installs k3s on a
  named host **install-only**: absent ⇒ install (the recipe is a
  provider-owned constant; the typed `version`/`role` ride as discrete argv
  tokens, never interpolated into a shell string); present ⇒ strict no-op;
  version-divergent ⇒ DRIFT reported (NO auto-upgrade); removed-from-desired
  ⇒ DRIFT. There is NO uninstall path on any branch — uninstalling would be
  fail-deleting. `EnsureK3sSchema` is `.strict()` (rejects any free-exec
  `command`/`script` key).
- Both kinds (`kube`, `k3s`) are wired data-driven (`V2_PLAN_ORDER` orders
  `k3s` before `kube`; `byKind` composite routing; the observed-adapter
  degrade-safe-skips them — they reconcile per-entity via `verify()`).
  `reconcile.ts` / `apply.ts` are unchanged. Idempotency property tests cover
  both kinds. Both tools are `isSensitive: () => true` (every invocation
  routes through the Approval Gate); every `StateEvent` carries the actor.
- **Production fix (`server.ts`):** the daemon constructed its MCP/REST
  servers WITHOUT passing `v2Tools`, so the ENTIRE v2 surface was unreachable
  in production — the 8 prior Bloco A tools (`set_firewall`,
  `set_load_balancer`, `expose_service`, …) were dead, not just the 2 new
  ones. `server.ts` now threads the granted `v2Tools` set + the kube/k3s tool
  deps (from `buildBootDeps` `kubePieces`) into both `createMcpServer` and
  `createRestServer`, unlocking the whole v2 surface. Per-credential
  capability checks and the Approval Gate still gate actual use (advertising a
  tool ≠ authorizing it).
- **Known limitations (deferred):** a version-divergence drift event is
  recorded with `result:"ok"` in the `StateEvent` table (the `op:"drift"`
  discriminator is the load-bearing signal; `reconcile.ts:496` hardcodes the
  result — out of scope here). Edge (Cloudflare), generic arbitrary host
  exec, multi-cluster targeting, helm, k3s in-place upgrade, and a B2
  kube-apiserver client are out of scope (spec §9).

### Fixed — Observed-state adapter (get_state / diff reflect reality)

**Spec:** `docs/specs/2026-06-02-observed-state-adapter.md` (Aceita 2026-06-02).

`GET /api/state` and `GET /api/diff` now reflect the real cluster. Previously
the production `observedAdapter` was an unimplemented stub (`server.ts`) that
`buildBootDeps` never wired, so the reconciler persisted an empty observed
snapshot every cycle — `get_state` returned `[]` and `diff` proposed `create`
for every entity even with a live cluster. Observe-only, non-destructive,
idempotent; no console-contract / migration change.

- The internal `ObservedSlice` now carries `{ key, payload }` per entity
  (was key strings only). HetznerCloud and Docker `observe()` map the rich
  wire object to an `entities.ts`-shaped payload (HetznerCloud widens its
  `listAll` deserialization; Docker builds the Service shape).
- A new pure adapter (`reconciler/observed-adapter.ts`) Zod-validates each
  payload and builds a typed `State`; an invalid or unknown-kind payload is
  degrade-safe-skipped (never throws — the snapshot always satisfies
  `StateSchema`). `buildBootDeps` wires it (the root-cause fix); the empty
  stub stays a test-only fallback.
- **Secret hygiene:** a secret-bound service env is OMITTED from the observed
  payload — observe leaks neither the resolved value nor the ref name; the
  key→ref binding stays on the container label for the apply path.
- **Fail-safe:** a truer observed makes real drift VISIBLE (notably the known
  manifest-Hetzner-volumes vs Docker-named-volumes divergence). Drift is
  reported (`result:"drift"`), never corrected; no destroy is ever issued.
  Resolving the volume source-of-truth + desired-state durability (#70) +
  an import/adopt path are deferred to Part 2.

### Fixed/Added — Docker private registry auth + skip-pull-if-present

**Spec:** `docs/specs/2026-06-01-docker-private-registry-auth.md` (Aceita 2026-06-01).

A `service` whose image lives in a private registry now pulls and starts.
Additive; no contract/migration change.

- **Bug 11 (fixed):** `ensureImage` sends an `X-Registry-Auth` header on
  `POST /images/create`. The new optional `REGISTRY_AUTH_REFS` env (JSON map
  `{"<host>":"<secret-ref>"}`) maps a registry host to a `secret:<ref>` that
  resolves — AT APPLY, behind the unforgeable `ApplyContext`, via the
  `secretResolver` — to a `{username,password}` credential, encoded as
  `base64url({username,password,serveraddress})`. Public pulls (host not in the
  map) are byte-identical. Malformed `REGISTRY_AUTH_REFS` ⇒ fail-closed at boot
  (value-free); a resolved value that is not `{username,password}` ⇒
  fail-closed at apply (`fatal`, host-only message), before any pull or create.
- **Skip-pull-if-present (added):** `ensureImage` probes `GET /images/<ref>/json`
  first; a 200 short-circuits the pull (no registry hit, no `changed`).
  Re-apply over a present image is a no-op; unblocks operators who pre-pull.
- **Secret hygiene:** the resolved password and the base64 header value
  (base64 ≠ encryption) never reach a plan/dry_run/log/StateEvent/observed
  state/error message — and never an argv token: the SSH docker transport
  routes sensitive headers via `curl --config -` on **stdin**, guarding the
  unsupported body+header combination.

### Fixed/Added — Hetzner volume bind + automount (service persistence)

**Spec:** `docs/specs/2026-06-01-volume-hetzner-bind-automount.md` (Aceita 2026-06-01).

End-to-end persistence of a declared Hetzner volume by the container that uses
it. Additive; no contract/migration change.

- **Bug 9 (fixed):** the planner now derives the cross-kind `service → volume`
  dependency from the volume **NAME** (segment before the first `:`), not the
  whole `service.volumes` string. `service.volumes: ["<name>:<container_path>"]`
  validates against the declared volume `<name>`; bare `["data"]` stays valid;
  an undeclared name is still a dangling-ref precondition.
- **automount (added):** `POST /volumes` now sends `automount: true`. Hetzner
  formats the **new** volume once and mounts it at `/mnt/HC_Volume_<id>`;
  re-attach/re-create **never reformats** (data-safe — no `mkfs` of our own).
  The manifest `mount_path` is **advisory** and is **not** sent (the path is
  fixed by automount).
- **bind resolution (added):** the `DockerProvider` resolves a
  `<name>:<container_path>` bind (with a non-absolute `<name>`) to the real
  Hetzner mount `/mnt/HC_Volume_<hcloud_id>:<container_path>` at apply, via an
  optional `resolveVolumeMount` seam backed by the observed VOLUME store.
  `createBody` and `isConverged` resolve the bind through the **same** helper,
  so re-apply is a strict no-op (no re-create flap). Absolute host-path binds,
  bare names, and the no-resolver path all pass through AS-IS (back-compat).
  First cycle (volume not yet observed) binds AS-IS and converges on the next
  cycle (non-atomic, accepted per spec §7.4).

### Fixed/Added — manifest multi-scope + destroy execution

**Spec:** `docs/specs/2026-06-01-manifest-multiscope-and-destroy-execution.md` (Aceita 2026-06-01).

- **Bug 7a (fixed):** `UPSTREAM_DEPS["service"]` now includes `"volume"`. A
  service referencing a declared volume (`svc.volumes` → a `plan()` volume dep)
  failed cross-kind validation when the **service** scope reconciled standalone
  (e.g. the periodic loop), because the merged desired view lacked volumes.
- **Bug 8 (added) — approved `destroy` now executes.** `doGatedOp` previously
  gated the approval then returned `applied()` with no effect. An approved
  destroy now removes the resource via a **new, sanctioned destructive path**:
  `Provider.destroy?()` (additive/optional), implemented by `DockerProvider`
  (Engine `DELETE …?force=true` over the service's replicas, idempotent) and
  routed by `compositeProvider.destroy`. **Consumption is caller-retry**
  (destroy → approve → re-call → executes), the same model as
  `provision_server`. The reconcile path is unchanged — `apply(op:"destroy")`
  and orphan-drift remain no-ops (fail-safe **never** auto-deletes). v1 covers
  the `service` kind (server/volume/network destroy = follow-up).

### Fixed/Added — Docker provider: pull, start, verify + provision user_data

**Spec:** `docs/specs/2026-06-01-docker-provider-bootstrap-and-verify.md` (Aceita 2026-06-01).

Four bugs surfaced applying a real `nginx:alpine` service (two were masked by an unfaithful docker-http fake, now made honest):

- **Bug 5 (fixed):** `listManaged` now passes `all=true`. The Engine lists only
  running containers by default, so a freshly-created ("Created") replica was
  invisible and never started → "did not converge". (`waitForHealthy` too.)
- **Bug 6 (fixed):** `isConverged` compares declared ports as a SUBSET of the
  container's exposed ports, not exact equality — an image's default ports
  (nginx → 80/tcp) are no longer treated as drift.
- **Bug 4 (added):** `docker pull` (`POST /images/create`) before container
  create, fail-closed. The Docker transport line-parses the NDJSON stream so an
  in-stream `{"error"}` (the Engine's HTTP-200 pull failure) aborts the action
  with no container created. Handles tag and `@sha256:` digest refs; pull does
  not flip `changed` (idempotent re-apply).
- **Bug 3 (added):** `servers[].user_data` passthrough → Hetzner provision
  `user_data` (cloud-init), so a fresh server can come up with Docker
  pre-installed. Omitted ⇒ byte-identical provision body.

### Fixed — SSH control transport (deploy blockers)

**Spec:** `docs/specs/2026-06-01-ssh-argv-quoting-and-key-unescape.md` (Aceita 2026-06-01).

- **SSH remote argv now shell-escaped.** `buildSshArgs` pushed `remoteArgv`
  raw, but the `ssh` client space-joins the post-host args and the remote
  `sshd` runs them via `$SHELL -c` — so a newline / space / `$` / `%{}` / quote
  re-parsed on the remote shell and corrupted the command (the Docker
  `curl -w "\n__BEVOX_HTTP__%{http_code}"` marker split across a newline). Each
  token is now POSIX single-quote escaped. Secrets unaffected (request body
  travels via stdin, not argv).
- **`SSH_PRIVATE_KEY` `\n`-unescape.** Node `--env-file` does not unescape
  `\n`, so operator PEM keys written single-line reached OpenSSH verbatim and
  were rejected. `config.ts` now converts `\n`→newline and guarantees a
  trailing newline (RESTIC_PASSWORD and other single-line secrets untouched).
- **Docs:** `core/.env.example` + `deploy/README.md` document the SSH key
  workflow (Hetzner SSH key → manifest `servers[].ssh_keys` → `.env` format).

### Added — manifest `services[]` additive fields (manifest schema gaps)

**Spec:** `docs/specs/2026-05-28-manifest-schema-gaps.md` (Aceita 2026-05-28).

- `services[].command` (`string[]`) → Docker Engine `Cmd` (gap #1).
- `services[].restart` (`no|on-failure|always|unless-stopped`) →
  `HostConfig.RestartPolicy` (gap #4).
- `services[].depends_on` (short `"name"` or object
  `{ name, wait_healthy_timeout }`) → intra-`service` DAG ordering in the
  reconciler; cycle / dangling dep → `precondition` before any mutation
  (gap #2, Phase 1 — ordering only; wait-for-healthy is Phase 2.0).

All three are OPTIONAL: omitted ⇒ the container create body is
byte-identical to the prior mapping (no `isConverged` flap, no forced
re-create). `depends_on` ordering never reaches the container body or
`isConverged`.

**Phase 2.0 — wait-for-healthy.** Before creating a dependent's containers,
`apply()` waits for each dep's Engine `State.Health.Status` to be `healthy`
(per-dep `wait_healthy_timeout`, default 120s). A dep image without a
HEALTHCHECK degrades to ordering-only and surfaces `service.wait_skipped`; a
timeout aborts by return (nothing created, nothing deleted) and surfaces
`service.dep_health_timeout`, reconverging next cycle. Provider outcomes ride a
new optional `ApplyResult.events[]`, persisted by the reconciler Record step
with the cycle actor (providers never emit StateEvents).

**Phase 2.1 — declarative `services[].healthcheck`.** Compose-style
`{ test, interval, timeout, retries, start_period }` → `ContainerCreate.Healthcheck`
(durations in ns), overriding the image HEALTHCHECK. Lets `depends_on` wait on
upstream images that ship no HEALTHCHECK.

### Removed — dead `services[].env_from`

- `services[].env_from` removed from the manifest schema, fixture and docs
  (gap #3). It was declared but never consumed by any provider. The working
  secret channel is `env: { KEY: "secret:<ref>" }`. Item schema is
  non-strict, so legacy manifests carrying `env_from` parse with the field
  silently stripped — identical runtime behaviour, no error.

### Added — `run_migrations` v2 tool

- `run_migrations` v2 tool (additive — 8th v2 tool) — forward-only
  idempotent SQL migrations against a daemon-managed Postgres service.
  Always-sensitive (passes Approval Gate). Per-migration transaction;
  stops on first error. Synthetic entity `migrations:<svc>:<db>`.
  `MIGRATION_TIMEOUT_MS` config knob (default 60s, range [1s, 10min]).
  ALL_TOOLS (12) FROZEN byte-identical; V2_TOOLS now 8.
  Spec: `docs/specs/2026-05-28-migration-runner-v1.md`.

### Added — `createSopsAgeSecretResolver` (real secret resolver v1)

**Spec:** `docs/specs/2026-05-28-secret-resolver-real-v1.md` (Aceita 2026-05-28).

Replaces the inert `createStubSecretResolver` (which returned `{status:"deferred"}` by design) with a real resolver based on `sops` + `age`:

- On-demand subprocess decrypt per `resolve()` call.
- Single global `SECRETS_FILE` (sops-encrypted YAML).
- `SOPS_AGE_KEY_FILE` (mode 0600, daemon-user-owned, non-symlink enforced at boot).
- Fail-fast boot validation: file existence + key perms + sops binary on PATH.
- Buffer cap 64KB per resolve (defense L9: tampered/oversized file OOM).
- Timeout SIGTERM → 200ms grace → SIGKILL.
- Env hygiene: subprocess receives only `{PATH, HOME, SOPS_AGE_KEY_FILE}`.

### **BREAKING** — `ConfigSchema` ganha 2 fields REQUIRED

| Field | Required? | Default |
|---|---|---|
| `SECRETS_FILE` | yes | — |
| `SOPS_AGE_KEY_FILE` | yes | — |
| `SECRETS_TIMEOUT_MS` | no | 5000 ms |

Daemon will fail boot value-free if `SECRETS_FILE` or `SOPS_AGE_KEY_FILE` is absent. Migration: see `deploy/runbook-secrets-go-live.md` §5.1.

**Rationale (CVE-class, not feature):** the inert stub left manifests with `secret:<ref>` env values structurally broken (resolver returned `deferred`, providers had no value to inject). The real resolver closes that leak surface AT APPLY TIME, behind the unforgeable `ApplyContext` token, preserving all 9 leak-prevention invariants (L1-L9) from spec §3.

### Preserved (no API change)

- `createStubSecretResolver` remains exported as a test seam.
- `SecretResolver` interface, `SecretResolveResult` discriminated union, `ApplyContext` brand — all UNCHANGED.
- `core/src/agent/rest.ts` consumes only `describe()` (no value path through REST).
- Golden tests `secret-apply.test.ts` + `secrets.test.ts` byte-identical.
