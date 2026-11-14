-- W1-P2: per-module credentials + per-module sessions (req 7, ADR A2 + A4).
-- Builds on 125_module_accounts.sql. Idempotent and additive only (no drops, no data rewrites).
-- The same statements run at boot from artifacts/api-server/src/lib/schema-migrations.ts.
--
-- Model: a module account (module_accounts) is always owned by a users row, because every data table
-- keys on users.id. A person who signs up directly on a module host gets a *backing* users row
-- (non-deliverable email, empty central password hash, so it can never sign in centrally) plus a
-- module account, a module credential and a 'backing' link. A person who already has an AYZEN account
-- is provisioned a module account on first "Continue with AYZEN" and gets a 'legacy_continue' link.

-- Composite-FK target: lets child tables prove their denormalized `module` equals the module of the
-- account they reference, so a credential/link/session can never point at another module's account.
CREATE UNIQUE INDEX IF NOT EXISTS module_accounts_id_module_idx ON module_accounts(id, module);

CREATE TABLE IF NOT EXISTS module_credentials (
  id SERIAL PRIMARY KEY,
  module_account_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  identifier TEXT NOT NULL,
  identifier_norm TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  identifier_verified_at TIMESTAMP,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMP,
  last_login_at TIMESTAMP,
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT,
  mfa_enrolled_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_credentials_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE,
  CONSTRAINT module_credentials_hash_chk CHECK (password_hash LIKE '$argon2id$%'),
  CONSTRAINT module_credentials_ident_chk CHECK (identifier_norm = lower(btrim(identifier_norm)) AND length(identifier_norm) BETWEEN 3 AND 254),
  CONSTRAINT module_credentials_mfa_chk CHECK (NOT mfa_enabled OR mfa_secret IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS module_credentials_account_idx ON module_credentials(module_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS module_credentials_module_ident_idx ON module_credentials(module, identifier_norm);

CREATE TABLE IF NOT EXISTS module_account_links (
  id SERIAL PRIMARY KEY,
  module_account_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  ayzen_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  linked_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_account_links_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE,
  CONSTRAINT module_account_links_method_chk CHECK (method IN ('backing','legacy_continue','oidc','explicit'))
);
CREATE UNIQUE INDEX IF NOT EXISTS module_account_links_account_user_idx ON module_account_links(module_account_id, ayzen_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS module_account_links_user_module_idx ON module_account_links(ayzen_user_id, module);
CREATE INDEX IF NOT EXISTS module_account_links_account_idx ON module_account_links(module_account_id);

-- Single-use password-reset tokens. Only the sha256 of the emailed token is stored.
CREATE TABLE IF NOT EXISTS module_password_resets (
  id SERIAL PRIMARY KEY,
  module_account_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  requested_ip TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_password_resets_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS module_password_resets_token_idx ON module_password_resets(token_hash);
CREATE INDEX IF NOT EXISTS module_password_resets_account_idx ON module_password_resets(module_account_id) WHERE used_at IS NULL;

-- Append-only audit trail for every event that creates or changes access to a module account.
-- Never stores passwords, tokens or raw identifiers of unknown accounts (identifier_hash only).
CREATE TABLE IF NOT EXISTS module_auth_events (
  id BIGSERIAL PRIMARY KEY,
  module TEXT NOT NULL,
  module_account_id INTEGER REFERENCES module_accounts(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_auth_events_module_chk CHECK (module IN ('sylo','ryft','fyra','verve','skarn','warde','wisp','zynth')),
  CONSTRAINT module_auth_events_event_chk CHECK (event IN ('signup','login','logout','continue','password_reset_requested','password_reset_completed')),
  CONSTRAINT module_auth_events_outcome_chk CHECK (outcome IN ('success','failure'))
);
CREATE INDEX IF NOT EXISTS module_auth_events_account_idx ON module_auth_events(module_account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS module_auth_events_module_event_idx ON module_auth_events(module, event, created_at DESC);

-- Module dimension on sessions (NULL = a central AYZEN session, exactly as before).
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS module TEXT NULL;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS module_account_id INTEGER NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_module_chk') THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_module_chk CHECK (
      (module IS NULL AND module_account_id IS NULL)
      OR (module IS NOT NULL AND module_account_id IS NOT NULL AND module IN ('sylo','ryft','fyra','verve','skarn','warde','wisp','zynth'))
    ) NOT VALID;
    ALTER TABLE user_sessions VALIDATE CONSTRAINT user_sessions_module_chk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_module_account_fk') THEN
    ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_module_account_fk
      FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE NOT VALID;
    ALTER TABLE user_sessions VALIDATE CONSTRAINT user_sessions_module_account_fk;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_user_sessions_module_account ON user_sessions(module_account_id, revoked_at) WHERE module_account_id IS NOT NULL;

INSERT INTO service_table_ownership (service_key, table_name)
VALUES ('identity', 'module_credentials'), ('identity', 'module_account_links'), ('identity', 'module_password_resets'), ('identity', 'module_auth_events')
ON CONFLICT (service_key, table_name) DO NOTHING;
