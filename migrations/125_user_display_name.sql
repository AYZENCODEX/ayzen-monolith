-- Signup collects a display name next to the username. Additive, idempotent;
-- the same statement runs at boot from artifacts/api-server/src/lib/schema-migrations.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
