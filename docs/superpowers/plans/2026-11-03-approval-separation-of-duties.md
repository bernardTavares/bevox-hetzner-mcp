# Plan — Approval Gate separation of duties

Spec: `docs/specs/2026-11-03-approval-separation-of-duties.md`.

## Task 1 — gate refuses self-resolution (TDD)

1. **Red.** In `core/src/agent/approval-gate.test.ts` (`resolveApproval(): webhook path`), add tests where:
   - the requester actor (`agent:vox`, from `CTX`) approves its own pending approval, and the call rejects with a fatal `ReconcileError`;
   - the same actor rejects its own pending approval, with the same result;
   - after each attempt the approval is still `pending` and no `approved` / `rejected` event exists;
   - the requester resolving an approval that is **already terminal** returns it unchanged (idempotent).
2. **Green.** In `resolveApproval`, after the `existing.status !== "pending"` short-circuit, throw `ReconcileError("fatal", …)` when `resolver === existing.actor`.
3. Run the full suite. Fix any existing test that relied on self-approval by giving it a distinct reviewer actor. These are test-fixture changes, not behaviour changes.

## Task 2 — REST surfaces it as 403 (TDD)

1. **Red.** In `core/src/agent/rest.test.ts`, the requester's token calling `POST /api/approvals/:id/approve` on its own approval gets 403, and the approval stays `pending`.
2. **Green.** Expected to pass with no REST change: `fatal` already maps to 403.

## Task 3 — docs

README "Safety model" and GETTING-STARTED §5 / §8 should describe the invariant instead of the limitation. They should also say that operators need two actors.
