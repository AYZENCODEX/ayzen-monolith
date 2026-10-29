-- FIN-WP-1 F3: a Finance chart of accounts is seeded per book, so account codes must be unique per
-- (user, book), not per user. The old UNIQUE(user_id, code) index made POST /finance/books fail on
-- seeding. Create the new index first so uniqueness is never unenforced, then drop the old one.
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_user_book_code_idx ON finance_accounts (user_id, book_id, code);
DROP INDEX IF EXISTS finance_accounts_user_code_idx;

-- FIN-WP-1 F4: optional client request key for POST /finance/entries/:id/repayments. Additive and
-- nullable; the partial unique index only constrains rows that carry a key.
ALTER TABLE finance_repayments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS finance_repayments_entry_idem_idx
  ON finance_repayments (entry_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
