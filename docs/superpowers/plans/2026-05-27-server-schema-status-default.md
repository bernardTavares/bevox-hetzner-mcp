# `ServerSchema.status` defaults to `"pending"` — Implementation Plan

> 1 commit. 1-clause schema edit + 2 unit tests. Branch already cut.

**Spec:** `docs/specs/2026-05-27-server-schema-status-default.md` (Aceita 2026-05-27)
**Branch:** to be cut `fix/server-schema-status-default` from main.
**Baseline:** suite 970/972 verde (pós PR #17).

## Task 1.1 — `ServerSchema.status` `.default("pending")` + 2 tests

- Files:
  - `core/src/domain/entities.ts` (line 34).
  - `core/src/domain/entities.test.ts` (append 2 tests inside existing describe block).
- [ ] Failing test — append to `core/src/domain/entities.test.ts` inside `describe("entities ↔ console contract", ...)`:
  ```ts
  it("ServerSchema parses manifest-shape input (no status) with 'pending' default", () => {
    const manifestServer = {
      name: "bevox-app-1",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-22.04",
      ssh_keys: ["k1"],
      labels: { app: "x" },
      network: "bevox-priv",
      // intentionally NO status — manifest-shape input
    };
    const parsed = ServerSchema.parse(manifestServer);
    expect(parsed.status).toBe("pending");
  });
  it("ServerSchema output (with default-filled status) stays console-valid", () => {
    const manifestServer = {
      name: "bevox-app-2",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-22.04",
      ssh_keys: [],
      labels: {},
      network: "bevox-priv",
    };
    const coreOut = ServerSchema.parse(manifestServer);
    // Oracle: core output → console parse must succeed (status filled).
    expect(() => ConsoleServer.parse(coreOut)).not.toThrow();
  });
  ```
- [ ] Run: `DATABASE_URL_TEST=... npm --prefix core test -- src/domain/entities.test.ts` → expect both new tests FAIL ("Required" for missing status).
- [ ] Minimal impl in `core/src/domain/entities.ts:34`:
  ```ts
  // Before:
  status: StatusEnum,
  // After:
  status: StatusEnum.default("pending"),
  ```
  Single-clause change. Comment on the line above may be added pointing to spec.
- [ ] Run same test command → expect both new tests PASS + existing oracle test (line 16) still passes.
- [ ] Full suite + typecheck:
  ```
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  npm --prefix core run typecheck
  ```
  Expect 972/974 green (+2). Typecheck: only pre-existing console/idempotency errors.
- [ ] **Property test sentinel:** `core/src/reconciler/idempotency*.property.test.ts` may generate server objects via fast-check. If status was generated explicitly, no change. If property tests generate w/o status (relying on schema rejection), they'd now pass differently — investigate. Expected outcome: property tests are unaffected (they either provide status or they parse via a different shape).
- [ ] Commit:
  ```
  fix(core): ServerSchema.status defaults to "pending" (bug #8)

  ManifestServerSchema intentionally omits `status` (manifest expresses
  intent, not state), but observed ServerSchema (FROZEN console contract
  mirror) requires it. HetznerCloudProvider + WireGuardProvider's
  parseDesired hit "Required" error for every apply_manifest with a
  server entry.

  Defensive 1-clause fix: status `.default("pending")` so manifest-shape
  input parses; output always has status (default fills in) → console
  contract oracle preserved at the OUTPUT level (wire format unchanged).

  Spec: docs/specs/2026-05-27-server-schema-status-default.md (Aceita)
  Plan: docs/superpowers/plans/2026-05-27-server-schema-status-default.md

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Done

Push, PR, merge, rebuild, restart daemon.
