# Finance target directory tree

Status: PROPOSAL (documentation only). No source was moved and no directory was
created in the repo. Basis: static inspection of the uploaded archive (no `.git`,
so commit SHA is `UNAVAILABLE`). Nothing below is a PASS claim; each extraction
still needs its own baseline tests, rewiring and boundary-scan run.

Extends `docs/antas/finance/finance-boundaries.md`. Finance stays inside
`artifacts/api-server`; routes remain compatibility adapters; no schema change;
`services/finance` is not a dependency.

## Target tree

Legend: `[EXISTS]` already in place · `[MOVE]` existing code to relocate, then
re-export from the old path · `[SPLIT]` large file divided by responsibility ·
`[STAYS]` not moved.

```text
artifacts/api-server/src/
├── routes/                                   [STAYS] thin HTTP adapters
│   ├── finance.ts                            [SPLIT -> handlers call finance/application/*]
│   ├── finance-invoices.ts                   [SPLIT -> handlers call finance/application/*]
│   ├── wallets.ts                            [STAYS] wallet routes; call finance/integrations/wallet-bridge
│   └── payments.ts, subscriptions.ts, marketplace-wallet.ts, admin-wallet.ts
│                                             [STAYS] outside Finance ownership until FIN-01 review
│
├── lib/                                      compatibility re-export shims only after migration
│   ├── finance-invoice.ts                    [EXISTS] already re-exports invoice-totals
│   ├── finance-accounting.ts                 [SPLIT -> finance/ledger/*, finance/schedules/*]
│   └── finance-*.ts, invoice-pdf.ts          [MOVE -> see mapping; old path becomes re-export]
│
└── finance/
    ├── domain/                               pure: no DB, HTTP, fs, provider
    │   ├── invoice-totals.ts (+ .test.ts)    [EXISTS]  FIN-02 done
    │   ├── invoice-format.ts                 [EXISTS] formatInvoiceNumber, amountInWords (FIN-02B; pdf duplicate removed)
    │   └── schedules.ts                      [MOVE] pure parts of generateAmortizationSchedule /
    │                                                 generateDepreciationSchedule (verify purity first)
    ├── ledger/                               journal + balances (kind-based ledger stays authoritative)
    │   ├── books.ts                          listBooks, resolveBookId
    │   ├── system-accounts.ts                ensureSystemAccounts
    │   ├── journal.ts                        postJournal, postEntryJournal, postEntryAdjustmentJournal,
    │   │                                     postRepaymentJournal, postLateFeeAccrualJournal,
    │   │                                     deleteJournalForEntry
    │   ├── repayments.ts                     applyPrincipalRepayment (moved in FIN-03; confirm location)
    │   └── balances.ts                       computeAccountBalances
    ├── schedules/                            DB-backed amortization/depreciation
    │   ├── amortization.ts                   listAmortizationForEntry (+ generate persistence)
    │   └── depreciation.ts                   listDepreciationForAsset, postDepreciationJournal
    ├── invoices/
    │   ├── tokens-and-links.ts               generateInvoiceToken, generateAgreementToken,
    │   │                                     financeInvoiceUrl, financePaymentAgreementUrl
    │   ├── events.ts                         logInvoiceEvent, getClientIpLocal
    │   ├── line-items.ts                     getInvoiceLineItems, replaceInvoiceLineItems
    │   ├── lookup.ts                         getInvoiceByToken
    │   ├── recurring.ts                      createAndSendRuleInvoice
    │   ├── pdf.ts                            [MOVE] lib/invoice-pdf.ts
    │   └── payment-qr.ts                     generatePaymentQrDataUrl, generateInvoicePayLinkQrDataUrl
    ├── receipts/
    │   └── receipt-tokens.ts                 generateReceiptToken, financeReceiptUrl, ensureReceiptToken
    ├── payment-methods/
    │   └── payment-methods.ts                listActivePaymentMethods + payment-methods route logic
    ├── networth/
    │   └── networth.ts                       [MOVE] lib/finance-networth.ts
    ├── fees/
    │   └── late-fees.ts                      late-fee logic currently in lib/finance-late-fee-cron.ts
    ├── notifications/
    │   └── notify.ts                         [MOVE] lib/finance-notify.ts
    ├── ai/
    │   └── finance-ai.ts                     [MOVE] lib/finance-ai.ts (provider behavior unchanged)
    ├── integrations/
    │   └── wallet-bridge.ts                  [MOVE] lib/finance-wallet-bridge.ts
    ├── jobs/                                 scheduler registration stays in API server
    │   ├── recurring.ts, reminder.ts, invoice-reminder.ts, late-fee.ts,
    │   ├── networth.ts, digest.ts, report-schedule.ts
    │   └── (each [MOVE] from lib/finance-*-cron.ts, thin: call the owner modules above)
    └── application/                          use cases extracted from the route files
        ├── entries.ts          17 handlers    /finance/entries
        ├── books-accounts.ts    9 handlers    /finance/books, /accounts
        ├── journal.ts           4 handlers    /finance/journal
        ├── reports.ts          10 handlers    /finance/reports, summary, analytics, projections,
        │                                      export, insights   (read-only: extract FIRST)
        ├── assets.ts           8 handlers     /finance/assets, depreciation, amortization
        ├── recurring.ts         5 handlers    /finance/recurring
        ├── goals-budgets.ts     8 handlers    /finance/goals, budgets, net-worth(3 -> networth/)
        ├── parties.ts           4 handlers    /finance/parties
        ├── currencies.ts        2 handlers    /finance/currencies
        ├── receipts.ts          2 handlers    /finance/receipt
        ├── report-schedules.ts  4 handlers    /finance/report-schedules
        ├── ai.ts                9 handlers    /finance/ai
        ├── invoices.ts         11 handlers    /finance/invoices
        ├── payment-agreements.ts 6 handlers   /finance/payment-agreements
        └── invoice-branding.ts  2 handlers    /finance/invoice-branding

lib/db/src/schema/finance.ts                  [STAYS] 24 finance_* tables, no schema change
packages/events                               [STAYS] Finance event contract
scripts/antas/finance/                        [EXISTS] validate-boundaries.mjs, reconcile.mjs
reports/antas/finance/                        [EXISTS] evidence per sub-phase
```

## Deliberately NOT created

| Candidate | Reason |
|---|---|
| `reconciliation/` | No reconciliation implementation in the API server. Only `scripts/antas/finance/reconcile.mjs`, a contract check that reports `UNVERIFIED`. Document as absent. |
| `payments/` (provider flows) | `routes/payments.ts` is 26 lines; no Finance provider adapter was found. Revisit only if inspection shows provider code. |
| `fees/` beyond late fees | No commission/fee engine found; only late-fee accrual. |
| `contracts/` | Public schemas already live in `lib/api-zod` and `packages/events`. A second copy would be a duplicate owner. |
| `infrastructure/` repositories | The code uses Drizzle directly. Introduce repositories only if an extraction needs a seam; not as a blanket rewrite. |

## Import rules (additions to the existing boundary doc)

1. `domain` imports nothing from `ledger`, `application`, `routes`, DB or providers.
2. `ledger`, `schedules`, `invoices`, `receipts`, `networth`, `fees` may import `domain` and the shared DB schema, never `application` or `routes`.
3. `application` may import every module above; `routes` may import only `application` (and middleware).
4. `jobs` and `notifications` must not import `routes`. The three existing legacy edges to `routes/notifications` stay recorded, not extended.
5. Old `lib/finance-*.ts` paths survive only as re-exports until every consumer is migrated and a scan proves no importers remain.
6. Relative import cycles including Finance sources are forbidden (already enforced by `validate:finance-boundaries`; extend its owner table per extraction).

## Extraction order (each step = its own sub-phase, tests before and after)

1. `domain/invoice-format.ts`: DONE (FIN-02B, status BLOCKED pending typecheck in a real checkout). `domain/schedules.ts`: NOT pure as written (generators interleave DB deletes with the math); defer to FIN-03.
2. `application/reports.ts` and read-only report queries (no money movement).
3. Low-risk leaf modules: `receipts`, `networth`, `notifications`, `ai`, `payment-methods`.
4. `ledger/*` and `schedules/*` split of `finance-accounting.ts`: money-critical, needs the DB invariant suite first.
5. `invoices/*` and the invoice/agreement handlers.
6. `application/entries.ts`, `recurring`, `assets`, then `jobs/*`.
7. Retire old `lib/` paths only after a consumer scan (FIN-05).

Steps 4 to 6 are blocked until the FIN-03 prerequisites exist: an isolated disposable
Postgres plus rollback, retry/idempotency, concurrency and authorization tests.

## Open items before any move

- Commit provenance (`.git` or a confirmed baseline SHA); current evidence cites three different SHAs.
- Schedule generators are not pure (DB delete + insert inside); splitting the math out is money-critical and waits for the FIN-03 invariant suite.
- Confirm where `applyPrincipalRepayment` now lives and which handler counts above fall into `entries` vs `reports` (counts are by route path prefix, not by function body).
- Decision on the pre-existing failing `capability-gate` test (baseline vs separate fix).
