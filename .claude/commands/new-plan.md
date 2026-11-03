---
description: After spec is accepted, invokes the plan-writer agent to draft a subagent-executable plan under docs/superpowers/plans/. Takes spec filename as input.
---

# /new-plan

Drafts an implementation plan at
`docs/superpowers/plans/<YYYY-MM-DD>-<slug>.md` that breaks an accepted spec
into TDD-sized tasks executable by a subagent loop.

## Arguments

One input, required: the spec filename (date+slug) under `docs/specs/`.

Example:

```
/new-plan
Spec: 2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md
```

## What it does

1. Reads the referenced spec end-to-end. Aborts if the spec has open questions
   marked unresolved.
2. Reuses the date+slug from the spec (so plan and spec are paired by name).
3. Invokes the **`plan-writer`** agent with: spec path, target plan path,
   invariants to enforce (CONTRIBUTING §"Ground rules" #1–#5).
4. Agent produces a plan with: Goal, Out-of-scope, Acceptance criteria,
   Numbered tasks (each task = failing test + minimal impl + commit), Risks,
   Rollback notes.
5. Reports the path. Does NOT execute any task — that is `/next-task`.

## Does not

- Touch `core/src/`. The plan is documentation; the work happens task-by-task.
- Re-open spec decisions. If the plan reveals a missing decision, stop and
  revise the spec (new dated file, then a new plan).
- Estimate calendar time. Tasks are sized by TDD increments, not hours.
