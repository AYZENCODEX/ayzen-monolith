-- W1-P1: per-module accounts + module user IDs (req 1).
-- One row per (AYZEN user, module). module_uid is the display/lookup ID (SYL-000001);
-- internal foreign keys stay integers (ADR A1). Format: <PREFIX>-<6+ digit zero-padded seq>.
-- Idempotent and additive only (no drops, no data rewrites). The same statements run at boot from
-- artifacts/api-server/src/lib/schema-migrations.ts. Existing users are backfilled by
-- scripts/src/backfill-module-accounts.mjs (dry-run by default), not by this file.

CREATE TABLE IF NOT EXISTS module_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  module_uid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'signup',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT module_accounts_module_chk CHECK (module IN ('sylo','ryft','fyra','verve','skarn','warde','wisp','zynth')),
  CONSTRAINT module_accounts_status_chk CHECK (status IN ('active','suspended','closed')),
  CONSTRAINT module_accounts_source_chk CHECK (source IN ('backfill','signup','lazy','admin')),
  CONSTRAINT module_accounts_uid_chk CHECK (module_uid ~ '^[A-Z]{3}-[0-9]{6,}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS module_accounts_user_module_idx ON module_accounts(user_id, module);
CREATE UNIQUE INDEX IF NOT EXISTS module_accounts_module_uid_idx ON module_accounts(module_uid);
CREATE UNIQUE INDEX IF NOT EXISTS module_accounts_module_seq_idx ON module_accounts(module, seq);
CREATE INDEX IF NOT EXISTS module_accounts_user_id_idx ON module_accounts(user_id);

-- One sequence per module so each module's IDs start at 000001 independently.
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_sylo;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_ryft;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_fyra;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_verve;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_skarn;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_warde;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_wisp;
CREATE SEQUENCE IF NOT EXISTS module_uid_seq_zynth;

-- Pad to 6 digits; once a module passes 999999 the number simply grows (lpad would truncate).
CREATE OR REPLACE FUNCTION ayzen_format_module_uid(p_prefix TEXT, p_seq BIGINT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_prefix || '-' || CASE WHEN p_seq > 999999 THEN p_seq::text ELSE lpad(p_seq::text, 6, '0') END
$$;

-- Idempotent, concurrency-safe provisioning. Returns the existing row if (user, module) already has
-- one; otherwise allocates the next number from the module's sequence. Sequence gaps (a lost race,
-- a rolled-back transaction) are expected and harmless: uniqueness is what matters, not density.
CREATE OR REPLACE FUNCTION ayzen_provision_module_account(p_user_id INTEGER, p_module TEXT, p_source TEXT DEFAULT 'signup')
RETURNS module_accounts
LANGUAGE plpgsql AS $$
DECLARE
  v_prefix TEXT;
  v_seq BIGINT;
  v_row module_accounts;
BEGIN
  v_prefix := CASE p_module
    WHEN 'sylo' THEN 'SYL' WHEN 'ryft' THEN 'RFT' WHEN 'fyra' THEN 'FYR' WHEN 'verve' THEN 'VRV'
    WHEN 'skarn' THEN 'SKR' WHEN 'warde' THEN 'WRD' WHEN 'wisp' THEN 'WSP' WHEN 'zynth' THEN 'ZYN'
    ELSE NULL END;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'unknown module: %', p_module USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM module_accounts WHERE user_id = p_user_id AND module = p_module;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  v_seq := nextval(format('module_uid_seq_%s', p_module)::regclass);
  INSERT INTO module_accounts (user_id, module, module_uid, seq, source)
  VALUES (p_user_id, p_module, ayzen_format_module_uid(v_prefix, v_seq), v_seq, p_source)
  ON CONFLICT (user_id, module) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    -- Lost a race with a concurrent provision for the same (user, module): return the winner.
    SELECT * INTO v_row FROM module_accounts WHERE user_id = p_user_id AND module = p_module;
  END IF;
  RETURN v_row;
END
$$;

INSERT INTO service_table_ownership (service_key, table_name)
VALUES ('identity', 'module_accounts')
ON CONFLICT (service_key, table_name) DO NOTHING;
