-- 002_state_events_index.sql
-- Supporting index for the Task 1.6 /api/events filter endpoint.
-- Filters on actor, entity, and result columns of state_events.
-- IF NOT EXISTS makes the DDL idempotent as an extra safety net (the
-- migration ledger prevents re-execution, but this guards manual runs).

CREATE INDEX IF NOT EXISTS idx_state_events_filter
  ON state_events (actor, entity, result);
