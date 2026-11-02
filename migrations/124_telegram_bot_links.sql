-- Telegram Phase 3 + 4.
-- 1) telegram_update_receipts.error: markTelegramUpdate() writes it, the table never had it.
-- 2) telegram_bot_links: one row per (AYZEN user, module bot). AYZENX keeps users.telegram_chat_id.
-- 3) telegram_link_codes: single-use, 10 minute link codes; only a SHA-256 hash is stored.
-- Idempotent and additive only (no drops, no data rewrites). The same statements run at boot from
-- artifacts/api-server/src/lib/schema-migrations.ts.
ALTER TABLE telegram_update_receipts ADD COLUMN IF NOT EXISTS error TEXT;

CREATE TABLE IF NOT EXISTS telegram_bot_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  username TEXT,
  verified_at TIMESTAMP NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_activity_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_links_user_bot_idx ON telegram_bot_links(user_id, bot_key);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_bot_links_bot_chat_idx ON telegram_bot_links(bot_key, chat_id);
CREATE INDEX IF NOT EXISTS telegram_bot_links_user_id_idx ON telegram_bot_links(user_id);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  id SERIAL PRIMARY KEY,
  bot_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  direction TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT,
  telegram_user_id TEXT,
  username TEXT,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_link_codes_bot_hash_idx ON telegram_link_codes(bot_key, code_hash);
CREATE INDEX IF NOT EXISTS telegram_link_codes_expires_idx ON telegram_link_codes(expires_at);
