# Finance target tree status

**FINAL (FIN-WP-9, 2026-10-20): the in-API-server extraction is complete in code. Verification is not: the final pack is BLOCKED.**
This records the current source tree. It claims no PASS for WP-1 to WP-8 and does not claim the separate Finance service is done (WP-10).
Numbers below come from `node scripts/antas/finance/measure-final-state.mjs` (log: `reports/antas/finance/wp9-logs/measure-final-state.json`).

## Final state

| Measure | Value |
|---|---|
| Route handlers | 109 (`finance.ts` 86, `finance-invoices.ts` 23), all adapters over `finance/application/*` |
| Direct `db.*` in the two route files | 6 lines, 0 writes; all are one-column `userId` SELECTs for PDP ownership lookups |
| Target-tree source files | 51 in 13 directories, 7079 lines (plus 23 test files under `finance/`) |
| Legacy `lib/finance-*` or `invoice-pdf` files | 0 (only `finance-accounting.db-runner.mjs` and `finance-accounting.db.test.ts` keep the old name; they are test infrastructure) |
| Real importers of the 14 removed modules | 0 (2 string-fixture lines in `tools/lineage-builder/test/lib.test.mjs` are ignored on purpose) |
| Boundary scan | PASS, 55 Finance sources, 0 findings, no import cycles, one approved legacy route edge (`notifications/notify.ts` to `routes/notifications`) |

## Final owners

| Directory | Files | Lines | Owns |
|---|---|---|---|
| `finance/domain/` | 5 | 350 | Pure code: invoice totals and formatting, recurrence dates, schedule math (golden-fixture gated), late-fee formula |
| `finance/ledger/` | 5 | 693 | Books, system accounts, journal posting and cascades, repayments (incl. installment payment), balances |
| `finance/schedules/` | 2 | 161 | Amortization and depreciation persistence |
| `finance/invoices/` | 6 | 633 | Invoice links, events, store, rule invoices, PDF, formatting |
| `finance/fees/` | 1 | 148 | Late-fee sweep |
| `finance/jobs/` | 8 | 771 | Recurring, report-schedule, late-fee, reminder, invoice-reminder, digest, net-worth schedulers and due-rule selection |
| `finance/integrations/` | 2 | 155 | Wallet bridge and the one-off journal repair CLI |
| `finance/application/` | 17 | 3440 | Use cases behind the HTTP routes (17 modules: reports, networth, ai, assets, books-accounts, currencies, entries, goals-budgets, journal, parties, receipts, recurring, report-schedules, invoice-branding, invoices, payment-agreements, payment-methods) |
| `finance/networth/` | 1 | 154 | Net-worth calculation |
| `finance/ai/` | 1 | 181 | Quick-entry parsing, SMS parsing, anomaly and query helpers |
| `finance/receipts/` | 1 | 33 | Receipt tokens |
| `finance/notifications/` | 1 | 218 | Finance notification helpers |
| `finance/payment-methods/` | 1 | 142 | Payment-method CRUD, labels, QR |

The file-by-file map from the legacy files to these owners is `reports/antas/finance/fin-final-migration-map.csv`.

## What is still outside the extraction

| Area | State |
|---|---|
| `services/finance` (account and transaction subset, integer cents) | Unchanged; WP-10 is optional and needs a separate decision. Gateway routing stays opt-in; no consumer is migrated. |
| Frontend | Unchanged; still a client of the same HTTP contracts. One client action is missing for the F22 appeal path (risk R-07). |
| Schema | Two migrations landed during the work although schema changes were out of the original scope: 122 (per-book account index, repayment idempotency key) and 123 (money columns to double precision, with rounding). See `finance-risk-register.md` R-04 and R-05. |

## Verification boundary

- **Ran in WP-9 (this revision):** boundary scan PASS; provenance verify, 0 drift; static tests 85 of 85 (`domain` 23 across five files, `route-security` 59, `ledger-compat` 3); import and re-export integrity check, 0 findings over 740 files (mutation-checked); measurement script.
- **Not run at this revision:** `pnpm typecheck`, `pnpm build`, `pnpm test:finance-db`, the three static tests that need installed packages (`finance-ai`, `express-async-errors`, `process-guards`), any staging walk-through. Last full DB run: 176 of 176 on a local Postgres 16.15 at WP-6b, which predates WP-7 and WP-8. Last clean `tsc -p artifacts/api-server --noEmit`: also WP-6b.
- **Evidence:** 7 of 31 evidence files are PASS (FIN-02, 02B to 02F, WP-0). WP-1 to WP-8 are BLOCKED. See `finance-evidence-index.md`.
- **Risks:** `finance-risk-register.md`.

## Next safe sequence

1. In a real checkout: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`, `pnpm --filter @workspace/api-server test:finance-static` and `test:finance-db`. Fix what they show.
2. Commit, so the evidence can name a SHA, and regenerate `fin-provenance-manifest.json`.
3. Staging: apply migrations 122 and 123 (backup first), walk through the checklist in the risk register, run the wallet repair once.
4. Owner decisions: CI wiring for the Finance tests (R-11), client appeal action (R-07), WP-10.

---

# Per-package log (history)

The sections below record each package as it was written. Where they mention a legacy shim or a "not moved yet" item, the final state above supersedes them.

## WP-1 additions (safety gate)

- `finance/route-security.test.ts` (static, no database): every Finance route is authenticated or on the seven-route token allowlist; callers come from the authenticated request, never from body/query/params; id routes reference the caller's `userId`; the 10 report routes call `application/reports` with no direct `db.*`; routes with direct `db.*` may not exceed 59. Run with `pnpm --filter @workspace/api-server test:finance-static`.
- `finance/ledger-invariants.db.test.ts` and `finance/jobs/due-rules.db.test.ts` (isolated Replit schema, registered in `test:finance-db`): cross-user isolation, journal guards, repayment duplicates/clamping/concurrency, delete scoping, adjustment netting, unknown/custom account posting, per-user recurring-rule selection, `recordRepayment` replay/conflict/concurrency/rollback, and per-book chart seeding. Written but not yet executed.
- Findings F1 to F5: `finance-safety-findings.md`. F1 (run-now scope), F2 (unknown account codes), F3 (per-book accounts index) and F4 (atomic, idempotent repayment), F5 (atomic entry and journal deletes) F6 (atomic installment payment and agreement verification) and F7 (atomic goal contributions) are fixed; `finance/jobs/due-rules.ts` owns due-rule selection; F7 (goal contribute lost update) is fixed; no finding is open. Migration `122_finance_multi_book_accounts_and_repayment_idempotency.sql` must be applied before deploying.
- Still not proven: authenticated HTTP responses for any route, non-journal rollback, provider behavior, parity with `services/finance`.

## WP-2 additions (non-money use cases, slice 2a)

New owners under `finance/application/`: `parties.ts`, `currencies.ts`, `report-schedules.ts`, `goals-budgets.ts`, plus `getProjectInvestments` in `reports.ts`. The 19 routes that used them (`/finance/investments`, `/parties` x4, `/currencies` x2, `/report-schedules` x4, `/goals` x5, `/budgets` x3) are thin adapters: HTTP validation and ownership middleware stay in the route, database work moved unchanged. `routes/finance.ts` is 2,222 lines (2,957 originally). Routes with no direct `db.*` call: 50 of 109 (was 29). Not moved yet: books/accounts, receipts, AI, invoice-branding and the report-schedule cron. `/finance/investments` joins `projects`, which the isolated schema lacks, so it has the static adapter gate only.

## WP-2b additions (non-money use cases, slice 2b)

New owners: `finance/application/books-accounts.ts` (9 route handlers), `application/receipts.ts` (mint/revoke link, public lookup, public view shape, PDF rendering), `application/ai.ts` (quick-entry preview/commit, receipt scan, SMS token and webhook ingest), `application/invoice-branding.ts` (2) and `finance/jobs/report-schedule.ts` (cron moved byte-for-byte except import paths; `lib/finance-report-schedule-cron.ts` is now a re-export and `index.ts` imports the owner). Routes keep HTTP validation, the PDP ownership middleware and response formatting. The SMS webhook receives its in-app notification as a callback so `application/*` does not import `routes/*`. `finance/ai/finance-ai.ts` still owns parsing and detection; the three read-only AI routes call it directly. `routes/finance.ts` is 1,968 lines (2,222 before); routes with direct `db.*`: 46 of 109 (was 59).

Not moved: entries, journal, assets, recurring, invoices, payment agreements (money-critical, WP-3 onward). Finding F8 (non-transactional book delete) is recorded, not fixed.

## WP-3 additions (ledger core)

`finance/ledger/books.ts` (listBooks, resolveBookId), `system-accounts.ts` (SYSTEM_ACCOUNTS, ensureSystemAccounts), `journal.ts` (posting maps, postJournal and the entry/adjustment/repayment/late-fee posters, journal and ledger-entry cascade deletes, `FinanceDbTransaction`), `repayments.ts` (principal repayment, idempotent recordRepayment, payAmortizationInstallment) and `balances.ts` (computeAccountBalances). Dependency direction: books <- system-accounts <- journal <- repayments; balances <- books, system-accounts. `lib/finance-accounting.ts` keeps amortization/depreciation (WP-4) and re-exports everything it used to export. Also in this step: F8 (transactional book delete).

## WP-4 additions (schedules and assets)

`finance/domain/schedules.ts` (`buildAmortizationRows`, `buildDepreciationRows`: no DB, clock or framework; only imports `./recurrence-dates`), `finance/schedules/amortization.ts`, `finance/schedules/depreciation.ts` (also `postDepreciationJournal`), `finance/application/assets.ts` (asset CRUD with owners, amortization list/generate, depreciation list/generate/post). `lib/finance-accounting.ts` now contains no implementation, only re-exports of its original 34 symbols. Golden fixture re-capture: `scripts/antas/finance/schedule-golden-capture.mjs` (run only against the baseline revision).

## WP-5a additions (recurring rules and manual journal)

New owners: `finance/application/recurring.ts` (list, create, update, delete, run-now; `runRecurringNow` loads the sweep on demand so the CRUD use cases do not pull in invoice, email or Telegram modules), `finance/application/journal.ts` (list, get, create manual, delete manual) and `finance/jobs/recurring.ts` (the daily sweep and cron, moved unchanged except import paths; `lib/finance-recurring-cron.ts` is now a re-export and `index.ts` still imports through it). Routes keep HTTP validation, the PDP ownership middleware and response formatting (`fmtJournalEntry`, date serialisation). Behavior change: F13, manual journal delete is one transaction. `jobs/recurring.ts` still imports `lib/finance-invoice` (`createAndSendRuleInvoice`) until WP-6. Routes with direct `db.*`: 31 of 109 (was 39). Not moved: the 17 entry handlers (WP-5b).

## WP-5b additions (ledger entries)

New owner: `finance/application/entries.ts` (13 route handlers: entries list/create/update/delete, repayments list/add, attachments list/upload/get/delete, invoice lines list/replace, CSV import; `assertEntryOwnership` moved here). Routes keep HTTP validation (ids, required fields, the positive-amount rule on create, the Idempotency-Key header and its 409/replay mapping), the PDP ownership middleware and response formatting (`fmtEntry`, `fmtRepayment`, dates, raw attachment streaming). Attachment functions carry an `Entry` infix (`listEntryAttachments` ...) because the vault module already owns `listAttachments` and friends. The notification modules (Telegram, email, SSE) are loaded on demand inside `createEntry` and `addRepayment` so the use cases and their isolated-schema tests do not load them. Behavior change: F14, invoice-line replacement is one transaction. The F4 and F5 static gates now inspect `application/entries.ts` for the write path. Routes with direct `db.*`: 18 of 109 (was 31). `routes/finance.ts` is 1,447 lines (1,833 originally). Remaining routes holding logic are in `finance-invoices.ts` (WP-6) and the handful of report/export, net-worth and AI read routes that call owners directly.

## WP-6a additions (invoices)

`finance/invoices/{links,events,store,rule-invoice,pdf,format}.ts` (moved from `lib/finance-invoice.ts` and `lib/invoice-pdf.ts`, which are now pure re-export shims with no importers) and `finance/application/invoices.ts` (11 route handlers: list, create, line-item edit, detail, creditor PDF, send, cancel, reopen, public view, public PDF, submit-payment). Routes keep auth, id parsing, body-shape validation, the PDP ownership checks and their ordering, the PDF streaming call and date formatting. Behavior changes F15 to F18 (see `finance-safety-findings.md`). Verified with DB tests that were run (`fin-wp6a-evidence.json`).

## WP-6b additions (payment agreements)

New owner: `finance/application/payment-agreements.ts` (6 route handlers: public agreement view, passkey options, passkey verify, evidence PDF, creditor verify, creditor dispute; plus the lookups the routes need before their PDP checks: `findAgreementByToken`, `findAgreementInvoiceOwner`). The routes keep authentication, id and body-shape validation, every PDP ownership check and its order (payer ownership, challenge ownership, creditor-side invoice ownership), the WebAuthn config read from the request, the in-memory challenge consumption, the evidence URL and response formatting. The WebAuthn verification is injectable (`deps.verifyAuthentication`) so the database behavior can be tested without a hardware key. Behavior changes (see `finance-safety-findings.md`): F19 (confirmation is conditional on `submitted`, counter and flip in one transaction, WebAuthn errors stay 401 but database errors are 500), F20 (dispute is one locked transaction and never un-settles an invoice), F21 (verify refuses a claim larger than the remaining balance, 409), F22 (a paid invoice cannot be cancelled, 400). `routes/finance-invoices.ts` is 570 lines (was 772) and no longer imports the ledger, mailers or receipt PDF theme (boundary check `wp6b-route-imports`). Routes with direct `db.*`: 2 of 109 (was 8). Not moved: the payment-method routes (`PUT /finance/payment-methods/:id` still resets defaults inline). DB tests: `wp6b-use-cases.db.test.ts`, written in the same session and **not run** (no Postgres was available).

## WP-7 additions (fees, jobs, wallet bridge)

New owners: `finance/domain/late-fees.ts` (pure accrual arithmetic, golden-compared with the original), `finance/fees/late-fees.ts` (`runFinanceLateFeeSweep`), `finance/jobs/late-fee.ts`, `reminder.ts`, `invoice-reminder.ts`, `digest.ts`, `networth.ts` (schedulers; digest and net-worth moved byte-for-byte except imports) and `finance/integrations/wallet-bridge.ts`. `ledger/journal.ts` gains `postEntryJournalInTx` and `postLateFeeAccrualJournalInTx`. The six legacy `lib/finance-*` files are pure re-exports with no importers. The jobs load `lib/create-notification` instead of `routes/notifications`, so two route-import exceptions were removed from the validator. Sweeps take optional `now`, `userIds` and injected senders (tests; the scheduled call passes nothing). Behavior changes F23 to F26 (see `finance-safety-findings.md`): atomic, claim-guarded late-fee accrual with its journal; claim-first reminders; claim-first invoice nudges with restore; atomic wallet entry plus journal. DB tests (`wp7-use-cases.db.test.ts`) are written and **not run**.

## WP-8 additions (shims retired)

All `lib/finance-*.ts` compatibility re-exports and `lib/invoice-pdf.ts` are deleted; nothing imports them (tests included). `routes/finance.ts` and `routes/finance-invoices.ts` import Finance code only through `finance/application/*`: new entry points `application/networth.ts` and `application/payment-methods.ts`, plus re-exports in `application/ai.ts` (`detectAnomalies`, `answerFinanceQuery`, `detectRecurringCandidates`), `application/assets.ts` (`payAmortizationInstallment`) and `application/invoices.ts` (`iso`). Rewired importers: `index.ts`, `ledger-invariants.db.test.ts`, `reports.db.test.ts`, `lib/finance-accounting.db.test.ts`. The DB runner and its test keep their `finance-accounting` file names in `lib/` (not shims). Validator checks `wp8-shims-removed`, `wp8-no-legacy-importers`, `wp8-routes-import-application-only`; the old per-package shim and compatibility-adapter checks were removed with the shims. No behavior change.
