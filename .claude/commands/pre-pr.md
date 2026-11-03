---
description: Pre-PR gate — runs typecheck and tests, audits invariants and secret-leak sentinels, flags contract drift. Output GO/NO-GO.
---

# /pre-pr

Quality gate before opening a PR. Combines automated checks with auditor
agents. Operates on the current diff vs the base branch (`git diff
main...HEAD` plus the working tree).

## Arguments

None.

## What it does

1. **Automated checks (sequential, fail-fast):**
   - `npm --prefix core test` — if red, NO-GO. Baseline is 897/898 (1 `@live`
     skipped) per CONTRIBUTING §"Development setup".
   - `npm --prefix core run typecheck` — if red, NO-GO.
2. **Invariants audit:** invokes **`hetzner-mcp-invariants-auditor`** over the
   modified file list. Verifies CONTRIBUTING §"Ground rules" #1–#5:
   specs-first, idempotency, fail-safe (never fail-deleting), secrets resolved
   at apply only, every `StateEvent` records the actor.
3. **Leak sentinels:** invokes **`leak-sentinel-auditor`** to scan the diff
   for `S3CR3T-*` markers, raw tokens (`HCLOUD_TOKEN`, `RESTIC_PASSWORD`,
   `SSH_PRIVATE_KEY`), and resolved secret values in `plan` / `dry_run` /
   logs / observed state per §"Ground rules" #4.
4. **Contract oracle:** inspects `git diff` for staged changes to the
   `console` contract files (`contract.ts`, `contract-v2.ts`) and to provider
   wire schemas. If touched, flags for explicit consistency review against
   the v1 spec (`2026-05-17`) and v2 contract (`2026-05-20`).
5. **GO / NO-GO output:**
   - **GO**: all checks green, no auditor blockers. Lists modified files +/-
     and a suggested PR title in English (imperative mood, per
     §"Commit message format").
   - **NO-GO**: numbered blockers grouped by source (typecheck / tests /
     invariants / leaks / contract).

## Does not

- Run the `@live` suite. That is opt-in, manual, pre-release
  (CONTRIBUTING §"Tests never touch real infra").
- Open the PR, commit, or push.
- Modify any file. Read-only against the working tree.
