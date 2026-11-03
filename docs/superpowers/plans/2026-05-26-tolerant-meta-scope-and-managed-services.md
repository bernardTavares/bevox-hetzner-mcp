# Tolerant meta-scope + `MANAGED_SERVICES` knob — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. 6 TDD-sized tasks across 3 phases. Spec aceita.

**Goal:** Land Mudanças B (tolerant meta-scope) + C (MANAGED_SERVICES knob) per the accepted spec, so `apply_manifest` (apply path) works in deploys without managed Docker.

**Architecture:** Two orthogonal changes:
- **B** — `composite-provider.ts` `observe("manifest")` wraps each per-backend visit in try/catch. Failure → structured `console.warn` JSON + continue.
- **C** — new `MANAGED_SERVICES=on|off` env knob; `routes.service` becomes optional; `BootDeps.scopes` excludes `"service"` when off; boot warn mirrors `MANAGED_MESH=off`.

**Tech Stack:** Inherits v1 — Node 20+, TS 5 strict ESM/NodeNext, Zod, Pino, Vitest + fakes. Zero new deps. Zero new files in `core/src/` (one file might be added if logger plumbing requires; aim for none).

**Specs:**
- Spec-filha: `docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md` (Aceita)
- Spec irmãs: `2026-05-26-server-scope-transport-decoupling.md` (#11), `2026-05-26-apply-manifest-meta-scope.md` (#12)

---

## Working agreement

- TDD strict per task: red → minimal green → commit.
- One task = one commit.
- Co-Authored-By trailer mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- No edits outside the named files per task.
- Tests via fakes in `core/test/fakes/`; `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test` inline.

---

## Non-negotiable principles (CONTRIBUTING §Ground rules)

1. Specs first: spec-filha aceita precedes code.
2. Idempotency: composite.observe stays pure; property tests untouched.
3. Fail-safe, never fail-deleting: B/C ONLY tolerate observe; no delete path.
4. Secrets at apply only: tolerant warn logs are value-free (kind + error class only, never secret value).
5. StateEvent actor: unchanged.

---

## File structure

```
core/src/config.ts                                MODIFIED: add MANAGED_SERVICES knob (F2.1)
core/src/config.test.ts                           MODIFIED: parse cases (F2.1)
core/src/reconciler/composite-provider.ts         MODIFIED: try/catch (F1.1), routes.service optional + skip (F2.3)
core/src/reconciler/composite-provider.test.ts    MODIFIED (or new sibling): tolerant test (F1.1), undefined-service test (F2.3)
core/src/entrypoint-wiring.ts                     MODIFIED: routes.service conditional + effective scopes + boot warn (F2.2, F2.4, F2.5)
core/src/entrypoint-wiring.test.ts                MODIFIED: routes.service + scopes + warn assertions
core/.env.example                                 MODIFIED: document MANAGED_SERVICES (F3.1)
CLAUDE.md                                         MODIFIED: §Stack note (F3.1)
deploy/README.md                                  MODIFIED: k3s example update (F3.1)
```

No new files in `core/src/`.

---

# Task 0 — Branch + baseline (BLOCKING)

### Task 0.1 — Verify baseline
- Branch `fix/tolerant-meta-scope-and-managed-services` already created (controller handled).
- [ ] `DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test npm --prefix core test` → expect 929/930 green matching post PR #12 baseline.
- [ ] No commit (branch only).

---

# Fase 1 (F1) — Mudança B: tolerant meta-scope

### Task 1.1 — composite.observe("manifest") tolerates per-backend failure
- Files: `core/src/reconciler/composite-provider.ts`, `core/src/reconciler/composite-provider.test.ts` (or sibling test file if soft-limit pressure).
- [ ] Failing test (append): build a composite where `routes.service.observe("service")` throws (a deliberate test fake — e.g., `{ name: "docker", observe: () => { throw new Error("ssh: connection failed (test sentinel)"); }, ... }`). Call `composite.observe("manifest")`. Assert (a) return value is `{ scope: "manifest", entities: [...] }` containing union of OTHER backends' entities, (b) NO throw escapes, (c) a structured warn was emitted to stderr (capture `console.warn` via `vi.spyOn(console, "warn")`).
- [ ] Run → expect FAIL (composite currently propagates the throw).
- [ ] Minimal impl: wrap `await p.observe(kind)` inside `visit` in try/catch. On catch: `console.warn(JSON.stringify({ subsystem: "composite-meta-scope", kind, error: (err as Error)?.name ?? "Error", msg: "backend observe failed during manifest meta-scope union; continuing (spec 2026-05-26 §2)" }))`. Do NOT log error.message (may contain secret).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `fix(core): composite meta-scope observe tolerates per-backend failure (1.1)`

**Done (F1) =** composite.observe("manifest") robust to one-backend failure.

---

# Fase 2 (F2) — Mudança C: MANAGED_SERVICES knob

### Task 2.1 — `ConfigSchema` learns `MANAGED_SERVICES` (default `on`)
- Files: `core/src/config.ts`, `core/src/config.test.ts`.
- [ ] Familiarise: re-read `MANAGED_MESH` field in `config.ts` (added in PR #11). Same preprocess → enum(["on","off"]).optional() → transform → "on" pattern.
- [ ] Failing tests (append to `config.test.ts`): 4 cases mirroring 1.1 of PR #11 plan but for `MANAGED_SERVICES`:
  ```ts
  it("ConfigSchema parses MANAGED_SERVICES default to 'on' when absent", ...)
  it("ConfigSchema parses MANAGED_SERVICES='off' verbatim", ...)
  it("ConfigSchema treats MANAGED_SERVICES empty string as default 'on'", ...)
  it("ConfigSchema rejects MANAGED_SERVICES invalid value", () => { expect(() => loadConfig({...fullEnv(), MANAGED_SERVICES: "maybe"})).toThrow(/MANAGED_SERVICES/); })
  ```
- [ ] Run → expect FAIL (`MANAGED_SERVICES` not yet on Config).
- [ ] Minimal impl: add `MANAGED_SERVICES` field to `ConfigSchema`, same shape as `MANAGED_MESH`. Cite spec §3.
- [ ] Run → expect PASS. Typecheck clean.
- [ ] Commit: `feat(core): MANAGED_SERVICES knob in ConfigSchema (default on) (2.1)`

### Task 2.2 — `CompositeRoutes.service` becomes optional + entrypoint-wiring conditional
- Files: `core/src/reconciler/composite-provider.ts`, `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: `CompositeRoutes` interface in `composite-provider.ts` (~line 67). Currently `service: Provider` required. Compare against `dns?: Provider` (already optional).
- [ ] Failing tests (append to `entrypoint-wiring.test.ts`): 2 cases:
  ```ts
  it("MANAGED_SERVICES='on' (default) wires routes.service as Docker provider", ...)
  it("MANAGED_SERVICES='off' wires routes.service as undefined", ...)
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl:
  1. In `composite-provider.ts:67-87` `CompositeRoutes` interface: change `readonly service: Provider` to `readonly service?: Provider`.
  2. In `composite-provider.ts` `targetsFor("service")` case: if `routes.service` is undefined, throw `precondition` with the same message style as the dns/backup undefined case. (existing dns/backup pattern at line ~109-118.)
  3. In `composite-provider.ts` `observe("manifest")` branch — the `visit` helper added in F1.1 already skips undefined `p` (see `if (!p || visited.has(p)) return;` — if F1.1 didn't add the `!p` guard yet, add here).
  4. In `entrypoint-wiring.ts:193-204`, the `providers` literal: change `service: docker` to `...(config.MANAGED_SERVICES === "on" ? { service: docker } : {})`. Cite spec §3.
- [ ] Run → expect PASS. Typecheck clean.
- [ ] Commit: `feat(core): routes.service conditional on MANAGED_SERVICES + optional in CompositeRoutes (2.2)`

### Task 2.3 — effective scopes excludes `"service"` when `MANAGED_SERVICES=off`
- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: `BootDeps.scopes?: readonly string[]` seam (server.ts uses `deps.scopes ?? DEFAULT_SCOPES`). Currently `entrypoint-wiring` doesn't set scopes, so server.ts falls back to `DEFAULT_SCOPES = ["network", "server", "service", "volume"]`.
- [ ] Failing test (append to `entrypoint-wiring.test.ts`):
  ```ts
  it("MANAGED_SERVICES='on' → BootDeps.scopes is undefined (server.ts uses DEFAULT_SCOPES)", ...)
  it("MANAGED_SERVICES='off' → BootDeps.scopes excludes 'service'", () => {
    const deps = buildBootDeps(cfgWith({ MANAGED_SERVICES: "off" }), fakeTransports);
    expect(deps.scopes).toBeDefined();
    expect(deps.scopes).not.toContain("service");
    expect(deps.scopes).toContain("network");
    expect(deps.scopes).toContain("server");
    expect(deps.scopes).toContain("volume");
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: in `entrypoint-wiring.ts` `buildBootDeps` add:
  ```ts
  const scopes = config.MANAGED_SERVICES === "on"
    ? undefined   // fall through to server.ts DEFAULT_SCOPES (current behavior)
    : ["network", "server", "volume"];   // explicit exclusion
  // ... return { ..., ...(scopes ? { scopes } : {}) };
  ```
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): BootDeps.scopes excludes service when MANAGED_SERVICES=off (2.3)`

### Task 2.4 — boot-time warn when `MANAGED_SERVICES='off'`
- Files: `core/src/entrypoint-wiring.ts`, `core/src/entrypoint-wiring.test.ts`.
- [ ] Familiarise: `warnManagedMeshOff` in `entrypoint-wiring.ts` (added in PR #11 F1.3). Same shape.
- [ ] Failing test: with capturing logger, run `runMain` with `MANAGED_SERVICES=off`, assert exactly one warn with `subsystem: "managed-services"`, `managedServices: "off"`, and an actionable message. With `on` → no such warn.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: add `function warnManagedServicesOff(logger: Logger)` mirroring `warnManagedMeshOff`. Call it from `runMain` next to the existing managed-mesh warn, conditional on `config.MANAGED_SERVICES === "off"`. Value-free; cite spec §3.
- [ ] Run → expect PASS. Typecheck clean.
- [ ] Commit: `feat(core): boot-time warn when MANAGED_SERVICES=off (2.4)`

**Done (F2) =** `MANAGED_SERVICES` knob fully wired; routes.service optional; effective scopes filter; boot warn.

---

# Fase 3 (F3) — Documentation

### Task 3.1 — Update `.env.example`, `CLAUDE.md` §Stack, `deploy/README.md`
- Files: `core/.env.example`, `CLAUDE.md`, `deploy/README.md`.
- [ ] `.env.example`: append `MANAGED_SERVICES` block after `MANAGED_MESH`, mirror tone. Document: default `on`; `off` means "MCP does NOT manage Docker services" (k3s/CNI scenario); cite spec.
- [ ] `CLAUDE.md`: under §Stack add one bullet for `MANAGED_SERVICES` next to the `MANAGED_MESH` bullet. Same one-liner format. Cite spec.
- [ ] `deploy/README.md`: in the existing "k3s/CNI external — MANAGED_MESH=off" section, append a paragraph noting `MANAGED_SERVICES=off` should accompany `MANAGED_MESH=off` for full "pure Hetzner Cloud HTTP" posture. Update the example `core/.env` snippet:
  ```bash
  MANAGED_MESH=off
  MANAGED_SERVICES=off
  ```
- [ ] No code test required.
- [ ] Commit: `docs: document MANAGED_SERVICES knob (.env.example + CLAUDE.md + deploy/README.md) (3.1)`

**Done (F3) =** docs aligned.

---

## After all tasks

- `git log --oneline e58eb95..HEAD` (or `caae890..HEAD` for the merged base) shows 6 commits in order 1.1 → 2.1 → 2.2 → 2.3 → 2.4 → 3.1.
- `DATABASE_URL_TEST=... npm --prefix core test` → all green (929/930 + ~6 new tests ≈ 935-936).
- Open PR vs `main`. After merge: rebuild + restart daemon. Optionally flip `MANAGED_SERVICES=off` in `core/.env` for the k3s posture (the bug-report scenario).

---

## Risks

- **Periodic reconcile property tests** may iterate the default scopes. Verify they don't hardcode `"service"` in the expected scope list. If they do, the test should accept either DEFAULT_SCOPES or the filtered list based on `routes.service` presence.
- **Composite logger plumbing**: Mudança B uses `console.warn` (no logger seam in `CompositeRoutes`). If a structured Pino logger is later threaded into composite, the warn becomes a `logger.warn`. Tracked as follow-up; non-blocking.
- **Effective scopes test setup**: `entrypoint-wiring.test.ts` already has fake transports from PR #11 F1.2. Reuse those.

---

## Rollback

If MANAGED_SERVICES introduces a regression: trivial revert of the 2.x commits restores routes.service = Docker unconditionally. B's tolerant try/catch stays as a safety net.

If B introduces a regression (e.g., masks a critical observe failure that should have halted apply_manifest): revert F1.1 commit; meta-scope returns to strict failure propagation. Apply_manifest with placeholder SSH_HOST then fails again until MANAGED_SERVICES=off is set.

---

## Done = (per phase)

- F1: composite tolerates per-backend observe failures; test green.
- F2: `MANAGED_SERVICES` knob parsed; routes.service optional; effective scopes filtered; boot warn; all tests green.
- F3: 3 docs aligned.
- Final: PR opened, suite green, ready to merge + restart.
