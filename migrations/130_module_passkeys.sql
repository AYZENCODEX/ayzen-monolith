-- 130_module_passkeys.sql — WebAuthn passkeys for module accounts (second factor at module sign-in; same library and
-- credential shape as the core passkey_credentials table, but keyed to module_accounts so a passkey is per module and
-- per host). Idempotent and additive. The same statements run at boot from artifacts/api-server/src/lib/schema-migrations.ts.

CREATE TABLE IF NOT EXISTS module_passkeys (
  id SERIAL PRIMARY KEY,
  module_account_id INTEGER NOT NULL,
  module TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  transports TEXT,
  name TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_passkeys_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS module_passkeys_credential_idx ON module_passkeys(module, credential_id);
CREATE INDEX IF NOT EXISTS module_passkeys_account_idx ON module_passkeys(module_account_id);

INSERT INTO service_table_ownership (service_key, table_name) VALUES ('identity', 'module_passkeys')
ON CONFLICT (service_key, table_name) DO NOTHING;
