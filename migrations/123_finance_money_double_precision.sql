-- FIN F11: Finance money columns were `real` (float32, ~7 significant digits: 1,000,000.01 was stored as
-- 1,000,000.00 and whole units were lost above 16,777,216). They become `double precision` (float64,
-- ~15 significant digits), which the pg driver still returns as a JS number, so no query or SUM() changes type.
-- Existing values are cleaned while converting: the float32 value is widened exactly, then rounded to
-- 2 decimals for money columns, 4 for unit_price, 6 for rates/quantities/percentages. This repairs float32
-- noise (99999.992 -> 99999.99); it cannot recover digits float32 had already dropped.
-- Idempotent: each block only converts columns that are still `real`, so re-running does nothing.
-- Takes a short ACCESS EXCLUSIVE lock per table (table rewrite). 16 finance_* tables hold the
-- 43 converted columns.
DO $f11_finance_ledger_entries$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('amount',2),('interest_rate',6),('interest_paid',2),('late_fee_rate',6),('late_fee_accrued',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_ledger_entries' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_ledger_entries', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_ledger_entries$;

DO $f11_finance_invoice_lines$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('quantity',6),('unit_price',4),('tax_percent',6)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_invoice_lines' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_invoice_lines', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_invoice_lines$;

DO $f11_finance_repayments$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('amount',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_repayments' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_repayments', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_repayments$;

DO $f11_finance_assets$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('total_value',2),('purchased_value',2),('interest_rate',6),('salvage_value',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_assets' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_assets', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_assets$;

DO $f11_finance_depreciation$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('depreciation_amount',2),('accumulated_depreciation',2),('book_value',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_depreciation' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_depreciation', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_depreciation$;

DO $f11_finance_asset_owners$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('ownership_percent',6)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_asset_owners' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_asset_owners', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_asset_owners$;

DO $f11_finance_recurring_rules$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('amount',2),('interest_rate',6)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_recurring_rules' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_recurring_rules', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_recurring_rules$;

DO $f11_finance_budgets$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('monthly_limit',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_budgets' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_budgets', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_budgets$;

DO $f11_finance_currency_rates$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('rate_to_base',6)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_currency_rates' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_currency_rates', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_currency_rates$;

DO $f11_finance_journal_lines$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('debit',2),('credit',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_journal_lines' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_journal_lines', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_journal_lines$;

DO $f11_finance_amortization$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('principal_due',2),('interest_due',2),('total_due',2),('remaining_balance',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_amortization' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_amortization', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_amortization$;

DO $f11_finance_goals$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('target_amount',2),('current_amount',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_goals' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_goals', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_goals$;

DO $f11_finance_net_worth_snapshots$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('net_worth',2),('total_assets',2),('total_receivable',2),('total_payable',2),('total_borrowed',2),('total_lending',2),('total_invested',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_net_worth_snapshots' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_net_worth_snapshots', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_net_worth_snapshots$;

DO $f11_finance_invoices$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('amount',2),('paid_amount',2),('discount_value',6),('tax_rate',6)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_invoices' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_invoices', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_invoices$;

DO $f11_finance_invoice_line_items$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('quantity',6),('unit_price',4)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_invoice_line_items' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_invoice_line_items', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_invoice_line_items$;

DO $f11_finance_payment_agreements$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.column_name AS col, v.digits AS digits
    FROM information_schema.columns c
    JOIN (VALUES ('amount',2)) AS v(col, digits) ON v.col = c.column_name
    WHERE c.table_schema = current_schema() AND c.table_name = 'finance_payment_agreements' AND c.data_type = 'real'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE double precision USING ROUND(%I::double precision::numeric, %s)::double precision', 'finance_payment_agreements', r.col, r.col, r.digits);
  END LOOP;
END
$f11_finance_payment_agreements$;
