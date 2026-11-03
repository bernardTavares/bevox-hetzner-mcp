# `asRecord` JSON-string acceptance — Implementation Plan

> 1 commit. ~3 LOC impl + ~20 LOC tests.

**Spec:** `docs/specs/2026-05-27-asrecord-accept-json-string.md` (Aceita 2026-05-27)
**Branch:** `fix/asrecord-accept-json-string` (already cut from main)
**Baseline:** suite 966/968 verde (pós-PR-B).

## Working agreement

- TDD: red → minimal green → commit (single commit; 4 tests + 1 impl change together is fine for this size).
- Mandatory trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Task 1.1 — `asRecord` accepts JSON-encoded string (single commit)

- Files:
  - `core/src/agent/tools.ts` — `asRecord` at lines 298-302.
  - `core/src/agent/tools.test.ts` — append 4-test describe block.
- [ ] Familiarise:
  - `core/src/agent/tools.ts:298-302` — current `asRecord`.
  - `core/src/agent/tools.ts:603, 410, 451, 506` etc. — callers (mostly `asRecord(input.manifest)` or `asRecord(input.record)`).
- [ ] Append failing tests to `core/src/agent/tools.test.ts` (anywhere a new describe block can land, e.g. right before the existing `describe("reconcileToEnvelope failure surfacing", ...)`):
  ```ts
  describe("asRecord (spec 2026-05-27 — JSON-string input)", () => {
    it("parses JSON-encoded object string", () => {
      expect(asRecord('{"foo":"bar"}')).toEqual({ foo: "bar" });
    });
    it("rejects malformed JSON string", () => {
      expect(asRecord("{not json")).toEqual({});
    });
    it("rejects array input (object-like but not Record)", () => {
      expect(asRecord([1, 2, 3])).toEqual({});
    });
    it("preserves object passthrough", () => {
      expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    });
  });
  ```
  Note: `asRecord` is a module-scope function not currently exported. EITHER export it from `tools.ts` (adding `export function asRecord(...)`) OR re-import via a re-export shim. Prefer the former — minimal diff.
- [ ] Run:
  ```
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test -- src/agent/tools.test.ts
  ```
  Expect 3 of 4 new tests to FAIL (parse case, malformed case, array case all currently return `{}` correctly OR return cast-of-array which is wrong). Object passthrough should pass already.
- [ ] Minimal impl in `core/src/agent/tools.ts:298-302`:
  ```ts
  function asRecord(input: unknown): Record<string, unknown> {
    // Accept JSON-encoded string input — some MCP clients (Claude Code, etc.)
    // serialize nested object args as JSON strings. Spec
    // docs/specs/2026-05-27-asrecord-accept-json-string.md §2.
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        return {};
      }
    }
    return input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  }
  ```
  Plus `export` if needed for the test to import it.
- [ ] Run same test command → expect all 4 new tests PASS, plus the entire existing tools.test.ts suite remains green.
- [ ] Full suite + typecheck:
  ```
  DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test \
    npm --prefix core test
  npm --prefix core run typecheck
  ```
  Expect 970/972 green (+4). Typecheck: only pre-existing console/idempotency errors.
- [ ] Commit:
  ```
  fix(core): asRecord accepts JSON-encoded string input (interop fix)

  Some MCP clients (Claude Code et al.) serialize nested object args as
  JSON strings — the daemon was silently dropping those to `{}`,
  resulting in apply_manifest returning {status:"applied"} with no
  side-effects (manifest = {}; fan-out conditions all falsy).

  Pre-parse strings via JSON.parse + try/catch (malformed → {} preserves
  current fail-safe). Bonus: exclude arrays from the Record cast path
  (typeof [] === "object" was an accident, never a contract).

  Spec: docs/specs/2026-05-27-asrecord-accept-json-string.md
  Plan: docs/superpowers/plans/2026-05-27-asrecord-accept-json-string.md

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Done

After commit:
- Push branch.
- Open PR; expect single commit (or 2 if docs separate).
- After merge: rebuild + restart daemon.
