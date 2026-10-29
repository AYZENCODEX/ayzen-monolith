# Finance evidence index

Generated 2026-10-20 (FIN-WP-9) from the `reports/antas/finance/*-evidence.json` files; regenerate rather than edit by hand. Status is copied from each file. **7 PASS, 24 BLOCKED** of 31. A BLOCKED file means its own stated checks did not all run or could not be bound to a commit; it does not mean the code is known to be wrong.

How to read PASS: FIN-02, 02B to 02F and WP-0 passed their own gates (02B/02C by promotion, see their `promotion` block). No WP-1 to WP-9 package has a PASS, and the final pack (`finance-final-validation.json`) is BLOCKED.

| Evidence file | Phase | Status | Commit | notRun items | Date |
|---|---|---|---|---|---|
| `fin-00-a-evidence.json` | FIN-00-A: Finance source inventory and baseline | BLOCKED | 023e9989c6 | 4 | 2026-10-14 |
| `fin-01-evidence.json` | FIN-01: Finance module boundaries | BLOCKED | a5df0e678e | 0 | 2026-10-14 |
| `fin-02-evidence.json` | FIN-02: Invoice-total domain extraction | PASS | a5df0e678e | 0 | 2026-10-14 |
| `fin-02b-evidence.json` | FIN-02B: Extract pure invoice formatting (formatInvoiceNumber, amountInWords) into finance/domain | PASS | UNAVAILABL | 5 | 2026-10-16 |
| `fin-02c-evidence.json` | FIN-02C: Extract pure schedule/recurrence calendar math into finance/domain | PASS | UNAVAILABL | 4 | 2026-10-16 |
| `fin-02d-evidence.json` | FIN-02D: Extract Finance leaf owners and isolate Replit database tests | PASS | 93ed605401 | 0 | 2026-10-16 |
| `fin-02e-evidence.json` | FIN-02E: Extract read-only Finance report use cases | PASS | none | 0 | 2026-10-17 |
| `fin-02f-evidence.json` | FIN-02F: Extract payment-method persistence and QR logic | PASS | none | 0 | 2026-10-17 |
| `fin-03-evidence.json` | FIN-03: Money-critical path characterization | BLOCKED | a5df0e678e | 0 | 2026-10-15 |
| `fin-04-evidence.json` | FIN-04: Finance integrations and consumer migration | BLOCKED | a5df0e678e | 0 | 2026-10-14 |
| `fin-f10c-evidence.json` | F10c: Out-of-order depreciation posting | BLOCKED | none | 0 | - |
| `fin-f11-f12-evidence.json` | F11-F12 | BLOCKED | none | 0 | - |
| `fin-f9-f10-evidence.json` | FIN-F9-F10-follow-up: F9 rollback proof, F10a confirmation, F10b atomic depreciation post | BLOCKED | none | 3 | 2026-10-19 |
| `fin-wp0-evidence.json` | FIN-WP-0: Closure items before any further Finance extraction | PASS | 93ed605401 | 2 | 2026-10-17 |
| `fin-wp1-evidence.json` | FIN-WP-1: Safety gate (FIN-03 prerequisites): static authorization gate, ledger invariant suite, findings | BLOCKED | 93ed605401 | 6 | 2026-10-17 |
| `fin-wp1-f5-evidence.json` | FIN-WP-1-F5: Fix F5: atomic journal deletion and entry delete cascade | BLOCKED | 93ed605401 | 3 | 2026-10-17 |
| `fin-wp1-f6-evidence.json` | FIN-WP-1-F6: Fix F6: atomic, claim-first installment payment and payment-agreement verification | BLOCKED | 93ed605401 | 3 | 2026-10-17 |
| `fin-wp1-f7-evidence.json` | FIN-WP-1-F7: Fix F7: atomic goal contributions | BLOCKED | 93ed605401 | 3 | 2026-10-18 |
| `fin-wp1-fixes-evidence.json` | FIN-WP-1-FIXES: Fix F1 (run-now scope) and F2 (unknown account codes dropped silently) | BLOCKED | 93ed605401 | 4 | 2026-10-17 |
| `fin-wp1-fixes2-evidence.json` | FIN-WP-1-FIXES-2: Fix F3 (per-book account uniqueness) and F4 (atomic, idempotent repayments) | BLOCKED | 93ed605401 | 5 | 2026-10-17 |
| `fin-wp2a-evidence.json` | FIN-WP-2a: Non-money use cases: parties, currencies, report schedules, goals, budgets, investments | BLOCKED | 93ed605401 | 4 | 2026-10-17 |
| `fin-wp2b-evidence.json` | FIN-WP-2b: Non-money use cases, slice 2b: books/accounts, receipts, AI, invoice-branding, report-schedule job | BLOCKED | 93ed605401 | 4 | 2026-10-18 |
| `fin-wp3-evidence.json` | FIN-F8-and-WP-3: F8 fix (transactional book delete) and WP-3 ledger core split | BLOCKED | 93ed605401 | 4 | 2026-10-18 |
| `fin-wp4-evidence.json` | FIN-WP-4: Schedules and assets: pure schedule math, DB-backed schedules, asset use cases | BLOCKED | 93ed605401 | 5 | 2026-10-19 |
| `fin-wp5a-evidence.json` | FIN-WP-5a: Recurring rules and manual journal: application use cases, recurring sweep job, F13 | BLOCKED | 93ed605401 | 4 | 2026-10-19 |
| `fin-wp5b-evidence.json` | FIN-WP-5b: Ledger entries: entries, repayments, attachments, invoice lines, CSV import as application use cases; F14 | BLOCKED | 93ed605401 | 3 | 2026-10-19 |
| `fin-wp6a-evidence.json` | FIN-WP-6a: Invoices: 11 handlers to application/invoices, lib/finance-invoice + lib/invoice-pdf moved to finance/invoices/*; F15 to F18; test-harness repair | BLOCKED | 93ed605401 | 4 | 2026-10-20 |
| `fin-wp6b-evidence.json` | FIN-WP-6b: Payment agreements: 6 handlers to application/payment-agreements; F19 to F22; first real run of the WP-6b DB suite | BLOCKED | 93ed605401 | 6 | 2026-10-20 |
| `fin-wp7-evidence.json` | FIN-WP-7: Fees, jobs and wallet bridge: six legacy lib files moved to finance/fees, finance/jobs, finance/integrations; F23 to F26 | BLOCKED | 93ed605401 | 4 | 2026-10-20 |
| `fin-wp8-evidence.json` | FIN-WP-8: Retire the lib/finance-* shims; routes import application/* only | BLOCKED | 93ed605401 | 4 | 2026-10-20 |
| `fin-wp9-evidence.json` | FIN-WP-9: Close-out (FIN-06): final scan, evidence index, final status, risk register | BLOCKED | 93ed605401 | 13 | 2026-10-20 |

Other evidence in the same folder: `fin-00-a-migration-map.csv` (baseline map), `fin-final-migration-map.csv` (final map, WP-9), `fin-01-dependency-scan.json` (output of the boundary scan, rewritten on each run), `fin-provenance-manifest.json` (git blob hashes of Finance-owned files), `FIN-00-A.md`, `finance-final-validation.json` and `wp9-logs/` (raw outputs of the WP-9 runs).

## Evidence gaps that apply to every row

- No commit SHA exists for the working tree (no `.git`). The base SHA `93ed60540127c1a4819cf957bfc4ba415199bf48` comes from FIN-02D; later work is uncommitted and bound only by content hash.
- The newest full DB run (176/176, local Postgres 16.15) and the newest clean `tsc -p artifacts/api-server --noEmit` predate WP-7 and WP-8 (see `fin-wp6b-evidence.json`).
- No staging run exists for any package.
