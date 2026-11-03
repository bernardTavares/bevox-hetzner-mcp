---
description: Reads the active plan, finds the first unchecked task, proposes a TDD breakdown (failing test, minimal impl, commit). Read-only — does not execute.
---

# /next-task

Read-only. Does not modify files. Does not invoke writer agents.

## What it does

1. Locates the active plan under `docs/superpowers/plans/` (most recent by
   date, or the one explicitly passed).
2. Parses the task list and identifies the first unchecked item (`- [ ]`).
3. Reads the spec referenced by the plan (same date+slug under `docs/specs/`)
   and pulls the section(s) the task implements.
4. Proposes a TDD breakdown:
   - **Red**: the failing test to write first (path + name + assertion shape).
   - **Green**: the minimal implementation that satisfies the test (file
     touch-list, no code yet).
   - **Refactor**: optional cleanup, only if a smell is concrete.
   - **Commit**: Conventional Commit subject (`feat(core): …`, `test(core): …`)
     per CONTRIBUTING §"Commit message format".
5. Lists invariants the task touches (CONTRIBUTING §"Ground rules" #1–#5)
   and any provider contracts (v1 `2026-05-17`, v2 `2026-05-20`) it must
   respect.
6. Lists blockers / open questions if the task cannot start cleanly.

## Arguments

Optional: plan filename. Defaults to most recent plan.

## Output structure

- Header: plan + task index + title.
- Spec context (3–5 bullets).
- TDD breakdown (Red / Green / Refactor / Commit).
- Invariants touched.
- Blockers (empty if none).

## Does not

- Write code or tests. The user invokes implementation explicitly.
- Tick the checkbox. The plan is updated only when the commit lands.
- Skip to a later task. Plans are executed in order; reorder via plan edit.
