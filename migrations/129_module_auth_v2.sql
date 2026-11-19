-- 129_module_auth_v2.sql — per-module sign-in/sign-up flows that the module login designs need (email codes, step-up,
-- captcha is stateless, profile). Builds on 125/126. Idempotent and additive only (the one constraint is widened, never
-- narrowed). The same statements run at boot from artifacts/api-server/src/lib/schema-migrations.ts.
--
--   module_otps      one-time 6-digit codes, scoped to (module, purpose, identifier). Only a keyed hash of the code is stored.
--                    purpose: signup (prove the mailbox), login (email factor of the step-up), reset (password reset by code).
--   module_profiles  what the designs collect at sign-up (username, name, location, bio, links), unique username PER MODULE.

CREATE TABLE IF NOT EXISTS module_otps (
  id SERIAL PRIMARY KEY,
  module TEXT NOT NULL,
  purpose TEXT NOT NULL,
  identifier_norm TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  requested_ip TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_otps_module_chk CHECK (module IN ('sylo','ryft','fyra','verve','skarn','warde','wisp','zynth')),
  CONSTRAINT module_otps_purpose_chk CHECK (purpose IN ('signup','login','reset'))
);
CREATE INDEX IF NOT EXISTS module_otps_lookup_idx ON module_otps(module, purpose, identifier_norm, created_at DESC);

CREATE TABLE IF NOT EXISTS module_profiles (
  module_account_id INTEGER PRIMARY KEY,
  module TEXT NOT NULL,
  username TEXT,
  username_norm TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  location TEXT,
  bio TEXT,
  links JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  referral_code_used TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_profiles_account_fk FOREIGN KEY (module_account_id, module) REFERENCES module_accounts(id, module) ON DELETE CASCADE,
  CONSTRAINT module_profiles_username_chk CHECK (username_norm IS NULL OR username_norm ~ '^[a-z0-9._]{3,30}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS module_profiles_username_idx ON module_profiles(module, username_norm) WHERE username_norm IS NOT NULL;
ALTER TABLE module_profiles ADD COLUMN IF NOT EXISTS mail_local TEXT;
ALTER TABLE module_profiles DROP CONSTRAINT IF EXISTS module_profiles_mail_chk;
ALTER TABLE module_profiles ADD CONSTRAINT module_profiles_mail_chk CHECK (mail_local IS NULL OR mail_local ~ '^[a-z0-9._-]{3,30}$');
CREATE UNIQUE INDEX IF NOT EXISTS module_profiles_mail_idx ON module_profiles(module, mail_local) WHERE mail_local IS NOT NULL;

ALTER TABLE module_auth_events DROP CONSTRAINT IF EXISTS module_auth_events_event_chk;
ALTER TABLE module_auth_events ADD CONSTRAINT module_auth_events_event_chk
  CHECK (event IN ('signup','login','logout','continue','password_reset_requested','password_reset_completed','oidc_login','link','clerk_login','clerk_user_created','clerk_user_deleted','step_up','profile_updated'));

INSERT INTO service_table_ownership (service_key, table_name) VALUES ('identity', 'module_otps'), ('identity', 'module_profiles')
ON CONFLICT (service_key, table_name) DO NOTHING;
