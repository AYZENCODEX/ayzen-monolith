-- Durable idempotency key for outbound mailbox sends.
ALTER TABLE ayzen_mailbox_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_messages_user_idempotency_idx
  ON ayzen_mailbox_messages(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;