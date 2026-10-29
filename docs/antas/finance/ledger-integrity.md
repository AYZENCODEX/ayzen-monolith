# Finance and ledger integrity

Finance gates require balanced debits and credits, immutable posted
transactions, correct opening-balance arithmetic, idempotent retries, and
reconciliation with no unexplained balance.

`scripts/antas/finance/reconcile.mjs` is intentionally safe by default: it
validates the ledger contract and does not invent database balances when no
provider-backed ledger is available.