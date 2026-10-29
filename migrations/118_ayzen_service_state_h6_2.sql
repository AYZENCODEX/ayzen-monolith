-- AYZEN Event & Workflow Enforcement Roadmap, Phase H6.2
-- Generic durable state table for the extracted microservices
-- (finance, vault, mail, notification, marketplace, search, ai, workflow, ...).
--
-- Each service previously held its domain state (accounts, transactions,
-- vault records, listings, messages, notifications, tasks, workflow
-- definitions/executions) in a plain in-memory Map() that a restart, crash,
-- or redeploy wiped clean. @ayzen/service-state's createPostgresStateStore
-- reads and writes this single shared table, keyed by (service, collection,
-- id), instead of every service needing its own bespoke schema.
--
-- Safe to run more than once: this mirrors the CREATE TABLE IF NOT EXISTS
-- @ayzen/service-state itself issues on boot, so a fresh service works
-- before this migration has run and this migration is a no-op once it has.

CREATE TABLE IF NOT EXISTS service_state (
  service     TEXT        NOT NULL,
  collection  TEXT        NOT NULL,
  id          TEXT        NOT NULL,
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, collection, id)
);

CREATE INDEX IF NOT EXISTS idx_service_state_service_collection
  ON service_state (service, collection);
