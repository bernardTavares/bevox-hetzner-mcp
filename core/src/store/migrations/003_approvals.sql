-- 003_approvals.sql
-- Approval Gate lifecycle store (Task 4.3).
--
-- An approval is the persisted decision record for a SENSITIVE plan item that
-- the reconciler withheld. It survives across reconcile cycles / process
-- restarts so a pending approval is re-evaluated (still withheld) every cycle
-- until a webhook resolution OR the TTL-expiry sweep terminates it.
--
-- CREATE TABLE / INDEX IF NOT EXISTS keep this DDL idempotent as an extra
-- safety net (the migration ledger already prevents re-execution). Forward-only:
-- this file is never edited once applied; later changes are new numbered files.
--
-- Dedupe contract: at most ONE non-terminal (status='pending') row per
-- (scope, op, entity) — a partial UNIQUE index enforces "one open approval per
-- action" so re-evaluating the same withheld item every cycle never duplicates.
-- Terminal rows (approved/rejected/cancelled) are unconstrained history.
--
-- status vocabulary (internal superset of the frozen console ApprovalSchema
-- enum pending|approved|rejected): pending → approved | rejected | cancelled.
-- 'cancelled' is the terminal state for BOTH a rejected and an expired pending
-- (the plan: expired → cancelled + event; rejected → cancelled + reason). The
-- agent-interface projection (Task 4.5) maps this superset back onto the
-- contract enum; the column is intentionally a free TEXT + CHECK, not an ENUM
-- type, to stay forward-only friendly.

CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT        PRIMARY KEY,            -- contract id, "apr_<uuid>"
  scope       TEXT        NOT NULL,               -- reconcile scope
  op          TEXT        NOT NULL,               -- plan op (destroy/restore/…)
  entity      TEXT        NOT NULL,               -- resource identifier
  change      TEXT        NOT NULL,               -- PlanItem.change (no secrets)
  impact      TEXT        NOT NULL,               -- PlanItem.impact (no secrets)
  actor       TEXT        NOT NULL,               -- requesting agent
  status      TEXT        NOT NULL
                          CHECK (status IN ('pending','approved','rejected','cancelled')),
  reason      TEXT,                               -- reject/expiry reason
  resolver    TEXT,                               -- agent that resolved it
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,               -- requested_at + TTL
  resolved_at TIMESTAMPTZ                         -- set on terminal transition
);

-- One OPEN (pending) approval per (scope, op, entity): the dedupe key. A
-- terminal row does not occupy the slot, so a fresh sensitive request after a
-- prior rejection/expiry can open a new pending.
CREATE UNIQUE INDEX IF NOT EXISTS uq_approvals_open_action
  ON approvals (scope, op, entity)
  WHERE status = 'pending';
