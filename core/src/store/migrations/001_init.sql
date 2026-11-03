-- 001_init.sql
-- Initial schema for bevox-hetzner-mcp state store.
-- All tables use CREATE TABLE IF NOT EXISTS — this file is safe to
-- reference repeatedly (the migration runner's ledger prevents re-execution,
-- but the DDL itself is also idempotent as an extra safety net).
--
-- Columns are intentionally minimal for 1.4; subsequent migrations (1.5/1.6)
-- will add columns via ALTER TABLE as the reconciler and event model mature.

-- Migration ledger: one row per applied migration file.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Observed state: ground-truth snapshot from the Hetzner/Docker/WireGuard
-- providers. Keyed by (scope, entity) — last-write wins per reconcile cycle.
CREATE TABLE IF NOT EXISTS observed_state (
  id         BIGSERIAL   PRIMARY KEY,
  scope      TEXT        NOT NULL,           -- e.g. "servers", "networks"
  entity     TEXT        NOT NULL,           -- resource name / identifier
  state      JSONB       NOT NULL,           -- full provider snapshot
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, entity)
);

-- Working state: desired state as last applied by the reconciler.
-- Mirrors the YAML manifest snapshot at reconcile time.
CREATE TABLE IF NOT EXISTS working_state (
  id         BIGSERIAL   PRIMARY KEY,
  scope      TEXT        NOT NULL,
  entity     TEXT        NOT NULL,
  state      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, entity)
);

-- State events: immutable append-only audit log.
-- Records every reconciler action: actor (agent id), scope, operation,
-- entity, before/after snapshots, and outcome.
CREATE TABLE IF NOT EXISTS state_events (
  seq     BIGSERIAL   PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT        NOT NULL,             -- agent id / "system"
  scope   TEXT        NOT NULL,
  op      TEXT        NOT NULL,             -- "create"|"update"|"delete"|"drift"|"noop"
  entity  TEXT        NOT NULL,
  before  JSONB,                            -- null for creates
  after   JSONB,                            -- null for deletes
  result  TEXT        NOT NULL              -- "ok"|"error"|"skipped"
);
