-- VLT-GAP-19: idempotent POST /vault. A client that never saw the response (connection dropped after the entity committed) retries
-- with the same Idempotency-Key header; the server pins the entity serial to (user_id, idem_key) BEFORE inserting, so the retry finds
-- the entity (or re-uses the pinned serial if the first attempt died before inserting) instead of creating a second one.
CREATE TABLE IF NOT EXISTS vault_create_idempotency (
  user_id       integer     NOT NULL,
  idem_key      text        NOT NULL,
  entity_serial text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS vault_create_idempotency_created_idx ON vault_create_idempotency (created_at);
