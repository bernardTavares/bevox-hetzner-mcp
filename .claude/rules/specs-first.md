---
name: specs-first
glob: "core/src/**/*.ts"
priority: 1
---

# specs-first

No non-trivial behavioral change to `core/src/` lands without:

1. **A referenced spec** under `docs/specs/` (existing or newly drafted via
   `/new-spec`). The spec defines the contract being changed.
2. **A referenced plan** under `docs/superpowers/plans/` (existing or newly
   drafted via `/new-plan`). The plan lists the TDD-sized tasks that
   implement the spec.

## Trivial changes (exempt)

- Typo fixes in comments or strings.
- Comment-only edits.
- Dependency version pins (no API surface change).
- Pure formatting (no AST change).

Everything else — new provider, new tool, new wire field, changed invariant,
changed error code, changed reconciler step, changed `StateEvent` shape — is
non-trivial.

## How a change traces

Every PR that touches `core/src/` MUST cite, in its description:

- The spec by date+slug (e.g. `2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`).
- The plan by date+slug, and the specific task index implemented.

If either reference is missing, the change is blocked at review.

## Reference

CONTRIBUTING §"Ground rules" #1: "Specs come first. Behavioral changes start
as a spec under `docs/specs/`. […] Do not change v1 invariants without a new
spec revision."

## Enforcement

`/audit-invariants` and `/pre-pr` check that the diff's `core/src/` changes
trace to a spec and a plan. A diff that fails this check returns NO-GO until
the spec / plan is in place or the change is reduced to a trivial subset.
