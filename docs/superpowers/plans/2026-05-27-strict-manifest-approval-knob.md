# `STRICT_MANIFEST_APPROVAL` knob — Implementation Plan

**Spec:** `docs/specs/2026-05-27-strict-manifest-approval-knob.md` (Aceita)
**Branch:** to be cut `fix/strict-manifest-approval-knob` from main.
**Baseline:** suite 985/987 verde (pós PR #23).

## Working agreement

- TDD per task: red → minimal green → commit.
- Single commit per task; ~5 tasks total.
- Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Task 1.1 — Config field

- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Append to ConfigSchema, mirror MANAGED_MESH:
  ```ts
  STRICT_MANIFEST_APPROVAL: z
    .preprocess((v) => (v === undefined || v === "" ? undefined : v),
                z.enum(["on", "off"]).optional())
    .transform((v) => v ?? "off"),
  ```
- [ ] Tests: parsing (default off, "on", "off", "", invalid). Mirror existing `MANAGED_MESH` tests.
- [ ] Commit: `feat(core): STRICT_MANIFEST_APPROVAL config knob (1.1)`

## Task 2.1 — `strictManifestIsSensitive` predicate

- Files: `core/src/agent/strict-manifest-sensitivity.ts` (NEW), `core/src/agent/strict-manifest-sensitivity.test.ts` (NEW).
- [ ] Implement per spec §1.2 (ownerToolFor + strictManifestIsSensitive).
- [ ] Unit tests:
  - `create server:X` → sensitive (provision_server "always").
  - `create service:X` → not sensitive (deploy_service "conditional" → default false for create).
  - `create dns:X` → not sensitive (set_dns "none").
  - `create network:X` → fallback default → not sensitive.
  - `destroy server:X` → sensitive (destroy "always").
  - `snapshot volume:X` → not sensitive (snapshot "none").
  - `restore volume:X` → sensitive (restore "always").
  - `update service:X` → not sensitive.
  - Edge cases: noop / drift / add ops → default fallback.
- [ ] Commit: `feat(core): strictManifestIsSensitive predicate (2.1)`

## Task 3.1 — Wire into ToolDeps + doApplyManifest

- Files: `core/src/agent/tools.ts`, `core/src/agent/tools.test.ts`.
- [ ] `ToolDeps` gains `strictManifestApproval?: boolean`.
- [ ] `createToolCatalog` destructures `strictManifestApproval ?? false`.
- [ ] In `doApplyManifest`, choose isSensitive based on flag:
  ```ts
  const isSensitive = strictManifestApproval
    ? strictManifestIsSensitive
    : defaultIsSensitive;
  return reconcileToEnvelope(scope, actor, isSensitive);
  ```
- [ ] Integration tests:
  - `apply_manifest({servers:[X]}, dry_run:false)` with `strictManifestApproval:true` → `pending_approval`.
  - Same with `strictManifestApproval:false` (default) → `applied` (regression sentinel).
- [ ] Commit: `feat(core): doApplyManifest dispatches strictManifestApproval (3.1)`

## Task 4.1 — entrypoint-wiring + server.ts forward + boot warn

- Files: `core/src/entrypoint-wiring.ts`, `core/src/server.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] `BootDeps.strictManifestApproval?: boolean`.
- [ ] `buildBootDeps` computes `config.STRICT_MANIFEST_APPROVAL === "on"` and adds to returned deps.
- [ ] `server.ts` forwards to `createToolCatalog` deps.
- [ ] Boot warn `warnStrictManifestApprovalOn(logger)` emitted when knob on, called from `runMain`.
- [ ] Tests:
  - `buildBootDeps` exposes `strictManifestApproval` matching config.
  - Boot warn structured (capturing logger asserts subsystem + msg snippet).
- [ ] Commit: `feat(core): entrypoint-wiring + server forward + boot warn (4.1)`

## Task 5.1 — Docs

- Files: `CLAUDE.md`, `deploy/README.md`.
- [ ] CLAUDE.md §"Stack" ganha bullet sobre o knob (após MANAGED_SERVICES).
- [ ] `deploy/README.md` ganha exemplo `.env` opt-in (próximo aos outros knobs).
- [ ] Commit: `docs: STRICT_MANIFEST_APPROVAL knob (5.1)`

## Done

- Suite expected ~990/992 verde (~+5 testes).
- Typecheck clean.
- PR with body covering both specs + bug #9 closure.
