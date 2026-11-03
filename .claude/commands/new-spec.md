---
description: After brainstorm, invokes the spec-writer agent to draft a new spec under docs/specs/. Takes free-text brief as input.
---

# /new-spec

Drafts a new design spec at `docs/specs/<YYYY-MM-DD>-<slug>.md`. Use only after the
brainstorm phase is closed and the problem framing is stable. Do NOT use to capture
half-formed ideas — that is what brainstorm is for.

## Arguments

One input, free text: the brief.

- Problem being solved (one paragraph).
- Scope and non-goals.
- Known constraints (invariants from CONTRIBUTING §"Ground rules" that apply,
  upstream specs to reference — e.g. `2026-05-17 v1 design`, `2026-05-20 v2
  contract`).
- Open questions worth raising in the spec.

Example:

```
/new-spec
Brief: Add a TLS termination contract for L7 load balancers fronting Docker
services on the WireGuard mesh. Must extend v2 Bloco A Ingress without
breaking the existing Cert+LB+Firewall composite. Open question: per-listener
SNI vs single-cert default.
```

## What it does

1. Confirms today's date (`YYYY-MM-DD`) and proposes a kebab-case slug from the
   brief.
2. Verifies the brief references at least one upstream spec or invariant. If
   not, aborts and asks for it (no spec is written in a vacuum).
3. Invokes the **`spec-writer`** agent with: brief, target path, upstream
   refs, applicable invariants.
4. Agent produces `docs/specs/<YYYY-MM-DD>-<slug>.md` with sections: Context,
   Goals, Non-goals, Design, Invariants touched, Open questions, Acceptance
   criteria.
5. Reports the path and a one-line summary. Does NOT open a PR. Does NOT write
   a plan — that is `/new-plan` after the spec is accepted.

## Does not

- Implement anything in `core/src/`. Specs precede code (CONTRIBUTING §"Ground
  rules" #1).
- Modify existing specs. Revisions are new dated files that reference the
  previous one.
- Skip the brainstorm phase. If the framing is fuzzy, stop and brainstorm.
