-- 131_sylo_credit.sql — Sylo's own credit storefront: AZN purchase orders, saved payment methods and the price list.
-- Idempotent and additive. Balances stay in the shared `credits` table (azn_balance); everything else is Sylo-owned.
-- The same statements run at boot from artifacts/api-server/src/lib/schema-migrations.ts.

CREATE TABLE IF NOT EXISTS sylo_payment_methods (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bkash','nagad','binance','wallet')),
  label TEXT,
  account TEXT NOT NULL,
  network TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sylo_payment_methods_unique_idx ON sylo_payment_methods(user_id, kind, account);
CREATE INDEX IF NOT EXISTS sylo_payment_methods_user_idx ON sylo_payment_methods(user_id);

CREATE TABLE IF NOT EXISTS sylo_credit_pricing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  price_usd NUMERIC(12,6) NOT NULL DEFAULT 0.01,
  price_bdt NUMERIC(12,4) NOT NULL DEFAULT 1.27,
  min_azn INTEGER NOT NULL DEFAULT 100,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO sylo_credit_pricing (id, price_usd, price_bdt, min_azn) VALUES (1, 0.01, 1.27, 100)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sylo_credit_orders (
  id SERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  azn_amount NUMERIC(18,4) NOT NULL CHECK (azn_amount > 0),
  unit_price_usd NUMERIC(12,6) NOT NULL,
  unit_price_bdt NUMERIC(12,4) NOT NULL,
  total_usd NUMERIC(18,4) NOT NULL,
  total_bdt NUMERIC(18,2) NOT NULL,
  pay_kind TEXT NOT NULL CHECK (pay_kind IN ('bkash','nagad','binance','wallet')),
  pay_account TEXT NOT NULL,
  payment_method_id INTEGER,
  reference_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_note TEXT,
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sylo_credit_orders_reference_idx ON sylo_credit_orders(pay_kind, reference_id);
CREATE INDEX IF NOT EXISTS sylo_credit_orders_user_idx ON sylo_credit_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sylo_credit_orders_pending_idx ON sylo_credit_orders(created_at) WHERE status = 'pending';

INSERT INTO service_table_ownership (service_key, table_name) VALUES
  ('vault', 'sylo_payment_methods'), ('vault', 'sylo_credit_pricing'), ('vault', 'sylo_credit_orders')
ON CONFLICT (service_key, table_name) DO NOTHING;
