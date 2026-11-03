# apply_manifest multi-scope + destroy execution — Plan

**Spec:** `docs/specs/2026-06-01-manifest-multiscope-and-destroy-execution.md` (Aceita).

**Goal:** Bug 7 — a full multi-scope manifest converges in one `apply_manifest`
call. Bug 8 — an approved `destroy` actually removes the service's containers,
via a new approval-gated path that preserves the reconcile-path fail-safe. TDD,
fakes-only. Commit trailer + `spec: 2026-06-01-manifest-multiscope-and-destroy-execution.md (task N)`.

**Order:** Bug 7 first (go-live blocker), then Bug 8 (destructive — extra care).

---

### Task 1 — Bug 7a: `UPSTREAM_DEPS["service"]` includes `volume`

- Files: `core/src/store/desired-state-seam.ts` (+ its test).
- [ ] Red: a test that `loadDesired("service")` on a seam where `volume` and
  `service` slices were written returns a merged view INCLUDING `volumes`.
- [ ] Green: `service: ["server", "network", "volume"]`; update the comment.
- [ ] Commit: `fix(core): service scope merges volume desired (cross-kind plan validation) (1)`

### Task 2 — Bug 7b: apply_manifest reconciles all manifest scopes

- Files: `core/src/agent/tools.ts` (+ `tools.test.ts` / `rest.test.ts`).
- [ ] Familiarise: `doApplyManifest` (`tools.ts:670`), `reconcileToEnvelope`
  (`:374`), the fan-out writeDesired (`:694-699`).
- [ ] Red: an `apply_manifest` with services referencing a declared volume (+ the
  network/server/volume) → today only one scope reconciles → the referenced-volume
  services don't apply. Assert all manifest scopes apply in one call (containers
  for the 6-ish services created+started); a sensitive item in any scope → one
  `pending_approval`; dependency order respected (volume before service).
- [ ] Run → FAIL.
- [ ] Green: after fan-out, reconcile each manifest-present scope in
  `MANIFEST_SCOPE_ORDER` (network → server → volume → service → backup → dns),
  aggregating: first withhold → `pending_approval`; any error propagates (what
  applied stays); else `applied` with summed counts. Reuse `reconcileToEnvelope`
  per scope.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `fix(core): apply_manifest reconciles every manifest scope in dependency order (2)`

### Task 3 — Bug 8a: `DockerProvider.destroy()` removes a service's containers

- Files: `core/src/providers/provider.ts` (optional `destroy?`), `core/src/providers/docker.ts`, `core/test/fakes/docker-http.ts`, `docker.test.ts`.
- [ ] Familiarise: `Provider` port (`provider.ts:140`), `replicasOf`, the apply
  no-op for remove/destroy (`docker.ts`), `.claude/rules/fail-safe.md`.
- [ ] Red:
  - Fake: `DELETE /containers/{id}` (and `?force=true`) removes the container; 404 if absent.
  - `docker.test.ts`: `provider.destroy({op:"destroy", entity:"service:x", …})`
    removes every replica of `x` (DELETE force), idempotent (absent → `changed:false`),
    touches ONLY `x`. CRITICAL guard: `apply({op:"destroy", …})` is STILL a no-op
    (fail-safe property intact) and orphans are never deleted by apply/verify.
- [ ] Run → FAIL (destroy not a function).
- [ ] Green: add optional `destroy?(action): Promise<ApplyResult>` to `Provider`;
  implement in `DockerProvider` (list replicas with `all=true`, DELETE each force,
  changed iff something was removed). `apply(op:"destroy")` unchanged.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `feat(core): DockerProvider.destroy removes a service's containers (approved-only) (3)`

### Task 4 — Bug 8b: doGatedOp executes destroy on approval (caller-retry)

- Files: `core/src/agent/tools.ts` (+ `tools.test.ts`).
- [ ] Familiarise: `doGatedOp` (`tools.ts:719`), the approved branch
  (`return applied()` at `:766`), how the gate reports approved vs denied.
- [ ] Red: destroy `service:x`: 1st call → `pending_approval`; approve; 2nd call →
  gate approved → `provider.destroy` invoked → container gone → `applied`; a
  StateEvent `op:"destroy" result:"ok"` recorded with the actor. Restore/snapshot
  (no `provider.destroy` semantics for them) and providers without `destroy`
  remain `applied()` no-op (back-compat).
- [ ] Run → FAIL (approved branch never removes).
- [ ] Green: in `doGatedOp`'s approved branch, when `op==="destroy"` and
  `provider.destroy` exists, call it (and record the StateEvent via the existing
  channel); else keep `applied()`. No new PlanOp; reuses the 4.3 gate.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `feat(core): execute approved destroy via provider.destroy (caller-retry) (4)`

### Task 5 — Idempotency/fail-safe re-assertion + docs

- Files: idempotency/fail-safe property tests (run; extend only if needed), `CHANGELOG.md`, docs.
- [ ] Confirm the fail-safe property (orphan never deleted by reconcile) and the
  apply(destroy)=no-op property are GREEN and unchanged. Extend the idempotency
  property if the multi-scope apply needs coverage.
- [ ] Docs: CHANGELOG `[Unreleased]`; note the destroy caller-retry model
  (approve → re-call) in the cheatsheet / deploy README.
- [ ] Commit: `test+docs: fail-safe/idempotency intact for destroy; caller-retry docs (5)`

---

## Risks
- **Fail-safe regression (highest, Bug 8):** the ONLY destructive call must be
  `provider.destroy` reached via an approved `doGatedOp`. `apply(op:"destroy")`
  and orphan-drift MUST stay no-op — Task 3 asserts both explicitly; the
  reconciler fail-safe property must stay green.
- **Multi-scope envelope aggregation (Bug 7):** a withhold in any scope must
  surface as pending with the correct approval id; an error mid-sequence leaves
  earlier scopes applied (fail-safe, no rollback) — assert.
- **`UPSTREAM_DEPS` widening:** adding `volume` to `service` must not create a
  cycle (volume→server, service→volume/server/network is acyclic) — confirm.

## Rollback
Additive/correctness; revert the commit range. Bug 8 introduces a destructive
path but only behind an approved gate; reverting removes the path entirely.

## Done =
Full manifest converges in one apply (all scopes, dependency order); an approved
destroy removes the service's containers (caller-retry), idempotent, with a
StateEvent; the reconcile-path fail-safe (apply/orphan never deletes) is intact.
