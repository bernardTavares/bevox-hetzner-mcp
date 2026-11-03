---
name: tdd-required
glob: "core/src/**/*.ts"
description: |
  Every behavior change in core/src/ starts with a failing test. Red → minimal
  green → commit, per CONTRIBUTING.md §"Workflow" item 3 ("TDD per task. Red →
  minimal green → commit. The repository's test suite is the contract; preserve
  and extend it"). The test suite is the load-bearing contract of this project:
  CI runs only against fakes (`core/test/fakes/`), property tests enforce
  reconciler idempotency, and `@live` smokes are opt-in and excluded from
  `npm test`.
priority: 2
---

# Rule: TDD is mandatory in `core/src/**/*.ts`

Applies to all `core/src/**/*.ts` except `**/*.test.ts`. Violation is a
blocking review comment.

## The workflow is non-negotiable

Per CONTRIBUTING.md §"Workflow" item 3:

> **TDD per task.** Red → minimal green → commit. The repository's test
> suite is the contract; preserve and extend it.

Operationally, for every behavior change:

1. **Red.** Write the test first — colocated as `<name>.test.ts` next to
   the source file (CONTRIBUTING §"Code style"). Run `npm --prefix core
   test -- <path>` and confirm it FAILS for the right reason (assertion
   mismatch — not import error, not type error, not "test not found").
2. **Green (minimal).** Add the smallest production change that flips the
   test to green. Resist scope creep — additional behavior earns its own
   red test first.
3. **Commit.** Atomic commit, Conventional Commits style with the
   mandatory `Co-Authored-By` trailer (CONTRIBUTING §"Commit message
   format"). One logical task per commit.

"Behavior change" includes: new public function, new branch in an
existing function, new error class, new field parsed off the wire, new
reconciler decision, new SQL emitted, new MCP tool registered. It does
NOT include: pure rename, dead-code deletion, comment edits, type-only
refactors that the type checker proves equivalent.

## Property tests for idempotency — do not weaken

Per CONTRIBUTING §"Ground rules" item 2:

> **Idempotency by design.** Every provider apply must converge —
> re-running the reconciler is the recovery mechanism. Property tests
> enforce this; do not weaken them.

If your change touches `core/src/providers/**` or `core/src/reconciler/**`,
the diff MUST include or extend a property test asserting that applying
the same desired state twice produces the same observed state and the
second apply emits zero mutating actions. Removing or relaxing an existing
property test requires a spec revision under `docs/specs/` referenced in
the PR body.

## Fakes only — no real infra in CI

Per CONTRIBUTING §"Tests never touch real infra":

> Hetzner Cloud, Docker Engine, SSH hosts, restic, ACME — all of these
> go through interface seams. CI runs only against fakes
> (`core/test/fakes/`).

Practical consequences:

- Tests under `core/src/**` and `core/test/e2e/**` MUST resolve external
  HTTP through a fake from `core/test/fakes/`. Use `createHetznerHttpFake()`
  /  `createDockerHttpFake()` / `pg-harness` / `wireguard-control` etc.,
  injected as `fetchImpl` or the matching seam.
- Need a new external HTTP dependency? Author a fake first — see the
  `fakes-author` skill at `.claude/skills/fakes-author/SKILL.md`.
- `@live` tests live ONLY in files named `*.live.test.ts` under
  `core/test/live/`. They are excluded from `npm test` via the vitest
  `unit` project's glob (`core/vitest.config.ts`) and require operator
  tokens (`HETZNER_LIVE_TOKEN`, `HETZNER_LIVE_ZONE`). NEVER add a real
  network call inside a `unit` project file — it will pass locally and
  fail in CI (or worse: pass in CI by hitting the live API).
- DB-backed tests use `core/test/fakes/pg-harness.ts` against the
  disposable Postgres on port 5546 documented in CONTRIBUTING §"First-time
  setup". The harness owns schema reset; do not bypass it.

## Definition of "failing test for the right reason"

A red test must fail because the production code lacks the behavior
under test, not because:

- The test file does not import what it claims (no module-not-found, no
  `undefined is not a function`).
- The test types are wrong (no TS compile error in the test).
- Fake state leaked from a sibling test (use `beforeEach(() =>
  fake.reset())`).
- A snapshot was auto-written on first run — snapshots count as red
  only if asserted against a checked-in expectation.

If the test passes on the first run, either the behavior already exists
(no production change needed) or the test does not actually cover the
intended behavior (fix the assertion, not the production code).

## Workflow checks before commit

```bash
npm --prefix core run typecheck                      # NodeNext strict; must be clean
npm --prefix core test -- <path to new test>         # the new test alone
npm --prefix core test                               # full suite — expected 1,403 passing, 3 skipped (@live)
```

A diff that adds production code in `core/src/**/*.ts` without a
corresponding addition under `core/src/**/*.test.ts` or `core/test/`
will be requested to be reverted and resubmitted test-first.

## Out of scope for this rule

- Generated code (build artifacts, migration SQL emitted by a tool).
- Type-only declarations with no runtime behavior (`.d.ts`, pure `type
  Foo = ...`).
- `core/test/fakes/**` itself — the fake's sibling test exists and is
  the test, not the subject.

## References

- `CONTRIBUTING.md` §"Workflow" item 3 (TDD per task)
- `CONTRIBUTING.md` §"Ground rules" item 2 (idempotency property tests)
- `CONTRIBUTING.md` §"Tests never touch real infra"
- `core/vitest.config.ts` (the `unit` vs `live` project split)
- `.claude/skills/fakes-author/SKILL.md` (authoring a new fake)
