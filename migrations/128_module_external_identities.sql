-- 128_module_external_identities.sql — W1-P5: Clerk social login, one Clerk application (user pool) per module.
-- A social-only module account has no password, so it cannot live in module_credentials (password_hash NOT NULL, argon2id CHECK).
-- The Clerk user id is therefore stored in its own table, keyed (module, provider, external_id): the same Clerk id string in two
-- modules is two different people-pools and two different rows. Also widens the audit event list again.
-- Idempotent.
CREATE TABLE IF NOT EXISTS module_external_identities (
  id SERIAL PRIMARY KEY,
  module_account_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'clerk',
  external_id TEXT NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMP,
  CONSTRAINT module_external_identities_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE,
  CONSTRAINT module_external_identities_module_chk CHECK (module IN ('sylo','ryft','fyra','verve','skarn','warde','wisp','zynth')),
  CONSTRAINT module_external_identities_provider_chk CHECK (provider IN ('clerk')),
  CONSTRAINT module_external_identities_clerk_id_chk CHECK (provider <> 'clerk' OR external_id ~ '^user_[A-Za-z0-9]{8,64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS module_external_identities_ext_idx ON module_external_identities(module, provider, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS module_external_identities_account_idx ON module_external_identities(module_account_id, provider);

ALTER TABLE module_auth_events DROP CONSTRAINT IF EXISTS module_auth_events_event_chk;
ALTER TABLE module_auth_events ADD CONSTRAINT module_auth_events_event_chk
  CHECK (event IN ('signup','login','logout','continue','password_reset_requested','password_reset_completed','oidc_login','link','clerk_login','clerk_user_created','clerk_user_deleted'));

INSERT INTO service_table_ownership (service_key, table_name) VALUES ('identity', 'module_external_identities')
ON CONFLICT (service_key, table_name) DO NOTHING;
