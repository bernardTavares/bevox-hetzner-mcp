---
description: Invokes the hetzner-mcp-invariants-auditor over the current diff. Outputs an invariant compliance table.
---

# /audit-invariants

Standalone invariants audit. Run mid-task to catch drift early, not only at
`/pre-pr` time.

## Arguments

None. Operates on `git diff main...HEAD` plus the working tree.

## What it does

1. Invokes the **`hetzner-mcp-invariants-auditor`** agent with the list of
   modified files.
2. Agent verifies each invariant from CONTRIBUTING §"Ground rules":
   - #1 Specs come first (every behavioral change traces to a spec).
   - #2 Idempotency by design (provider applies converge on re-run).
   - #3 Fail-safe, never fail-deleting.
   - #4 Secrets resolved at apply only (no resolved secret in plan/dry_run/
     logs/observed state).
   - #5 Every `StateEvent` records the actor.
3. Produces a compliance table.

## Output

| Invariant | Status | Evidence | Action |
|---|---|---|---|
| #1 Specs first | OK / VIOLATION | file:line or spec ref | — |
| #2 Idempotency | OK / VIOLATION | file:line | — |
| #3 Fail-safe | OK / VIOLATION | file:line | — |
| #4 Secrets at apply | OK / VIOLATION | file:line | — |
| #5 StateEvent actor | OK / VIOLATION | file:line | — |

## Does not

- Run tests or typecheck — that is `/pre-pr`.
- Modify any file. Read-only.
- Decide PR readiness alone. A clean audit is necessary, not sufficient.
