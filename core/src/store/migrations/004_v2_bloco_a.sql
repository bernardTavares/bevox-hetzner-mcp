-- 004_v2_bloco_a.sql
--
-- v2 Bloco A — additive migration.
--
-- Adds five new observed-state tables for v2 resource kinds and extends
-- state_events with two columns required by the v2 capability/policy model.
--
-- Forward-only: no rollback. Applied once via runMigrations (db.ts), which
-- records the filename in schema_migrations to prevent re-application.
--
-- All five observed tables share the same minimal shape:
--   id          uuid PRIMARY KEY
--   name        text UNIQUE NOT NULL   -- desired-state name (stable handle)
--   observed    jsonb NOT NULL          -- last observed payload from provider
--   status      text NOT NULL           -- coarse lifecycle status
--   updated_at  timestamptz NOT NULL    -- last reconcile that wrote this row

CREATE TABLE IF NOT EXISTS firewalls (
  id          uuid        PRIMARY KEY,
  name        text        UNIQUE NOT NULL,
  observed    jsonb       NOT NULL,
  status      text        NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS load_balancers (
  id          uuid        PRIMARY KEY,
  name        text        UNIQUE NOT NULL,
  observed    jsonb       NOT NULL,
  status      text        NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS certificates (
  id          uuid        PRIMARY KEY,
  name        text        UNIQUE NOT NULL,
  observed    jsonb       NOT NULL,
  status      text        NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS primary_ips (
  id          uuid        PRIMARY KEY,
  name        text        UNIQUE NOT NULL,
  observed    jsonb       NOT NULL,
  status      text        NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ingresses (
  id          uuid        PRIMARY KEY,
  name        text        UNIQUE NOT NULL,
  observed    jsonb       NOT NULL,
  status      text        NOT NULL,
  updated_at  timestamptz NOT NULL
);

ALTER TABLE state_events
  ADD COLUMN IF NOT EXISTS capability_token_id text,
  ADD COLUMN IF NOT EXISTS policy_eval_result  jsonb;
