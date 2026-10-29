# Finance extraction: remaining-work scope

Status: living scope document, section 1 re-measured on 2026-10-20 in WP-9 with `scripts/antas/finance/measure-final-state.mjs`. **WP-0 to WP-9 are done in code; the extraction is complete in code. Only FIN-02 to FIN-02F and WP-0 have PASS evidence; WP-1 to WP-9 and the final pack are BLOCKED** (see section 2 and `finance-final-validation.json`). Open items: `finance-risk-register.md`.
Basis: static count of the `AYZEN4X1-finance-fin02czip` tree (no `.git`; commit SHA `UNAVAILABLE`).
Extends `finance-target-tree.md` and `finance-target-tree-status.md`. No PASS is claimed here.

## 1. Where we are

Counted from the tree on 2026-10-20 (route counts by grep of `router.<verb>(`, line counts by `wc -l`, tests as run on a local Postgres 16, not in the Replit checkout). The earlier version of this table stopped at WP-2b and is replaced.

| Measure | Done | Total | Note |
|---|---|---|---|
| Target-tree source files in place | **51** | 51 | 13 directories, 7,079 lines: `domain` 5, `ledger` 5, `application` 17, `invoices` 6, `jobs` 8, `schedules` 2, `fees` 1, `integrations` 2, `networth`, `ai`, `receipts`, `notifications`, `payment-methods` 1 each. The earlier count of 48 was stale: WP-8 added `application/networth.ts` and `application/payment-methods.ts`, and WP-7 added the `integrations/repair-wallet-journals.ts` CLI |
| Route handlers whose logic is extracted | **109** | 109 | `finance.ts` 86 + `finance-invoices.ts` 23. 17 report, net-worth and payment-method adapters + 92 from WP-2 to WP-6 (WP-2 40, WP-4 8, WP-5 26, WP-6 17, investments 1; see the handler count check below) |
| Route handlers still holding logic | **0** | 109 | The routes keep authentication, id and body validation, PDP ownership checks and response formatting only |
| Routes with direct `db.*` calls | 2 of 109 (ratchet) | | No route writes: all 6 remaining `db.*` lines in the two route files are one-column `userId` ownership lookups for the PDP checks (`finance.ts` 204, 217, 317; `finance-invoices.ts` 128, 136, 194; re-measured in WP-9). The ratchet counts `PUT /finance/payment-methods/:id` and one false positive (the helper block after `DELETE /finance/books/:id`) |
| Legacy lib files | **0** | | WP-8 deleted 13 `lib/finance-*.ts` re-export shims and `lib/invoice-pdf.ts` (14 files; earlier text said 14 plus `invoice-pdf`, which double-counted); only the DB-test runner and its test (`finance-accounting.db-runner.mjs`, `finance-accounting.db.test.ts`) keep the old name. Boundary checks `wp8-*` enforce it |
| Work packages | **WP-0, 2 to 9 done in code**; WP-1 half (1a done, 1b open) | 10 (WP-0 to WP-9) | WP-10 optional. About 90 percent of the extraction is in code by package count. **WP-7 and WP-8 are unrun: no DB driver or `tsc` in the session** |
| DB tests (isolated schema, local Postgres 16) | 176 of 176 pass | | Full finance DB suite after WP-6b and the two owner decisions; static suite 71 of 71; boundary scan PASS (58 Finance sources, 0 findings); `tsc` on api-server exit 0 |
| Phases with PASS evidence | FIN-02, 02B, 02C, 02D, 02E, 02F, WP-0 | | 02B/02C promoted in WP-0 (indirect proof, see their `promotion` block). **WP-1 to WP-6b evidence files are all BLOCKED**: not run in the Replit checkout, no commit SHA, full `pnpm typecheck` and `pnpm build` not run, no staging walk-through |

## 2. Work packages

Rule for every package: baseline test first, move code unchanged, rewire consumers, leave a re-export shim,
extend `validate-boundaries.mjs` owner table, write `fin-<id>-evidence.json`. Status stays BLOCKED until
typecheck, build and `test:finance-db` exit 0 in a real checkout.

| WP | Scope | Handlers / files | Depends on | Risk |
|---|---|---|---|---|
| **WP-0 Closure (DONE)** | Promote FIN-02B/02C with a note citing the FIN-02D full run; fix commit provenance (`.git` or confirmed baseline SHA); decide the failing `capability-gate` test (baseline vs separate fix); assign the unplaced `/finance/investments` handler to a target module | 0 handlers | none | low |
| **WP-1 Safety gate (FIN-03)** (1a written, 1b open) | **1a (done):** static gate `finance/route-security.test.ts` (15 tests, run and mutation-tested) covering authentication, allowlisted token routes, caller scoping, report-route thickness and a direct-DB-route ratchet; ledger suite `finance/ledger-invariants.db.test.ts` (32 tests), `finance/jobs/due-rules.db.test.ts` (2 tests) and `finance/application/wp2-use-cases.db.test.ts` (12 tests), both registered in the DB runner and **not yet executed** covering cross-user book and balance isolation, journal guards, repayment duplicates, clamping, concurrency and delete scoping; findings F1 to F5 in `finance-safety-findings.md` (**F1 to F7 fixed**, none open). **1b (open):** authenticated HTTP-level contract and cross-user tests (needs an auth harness: users table in the isolated schema or module mocking); a rollback test for non-journal paths; (no open safety finding) | tests only | none | medium (needs real DB) |
| **WP-2 Non-money use cases** (**2a and 2b done, unrun**) | **2a (done):** `application/parties`, `currencies`, `report-schedules`, `goals-budgets` and `getProjectInvestments` in `reports` (19 handlers); `wp2-use-cases.db.test.ts` characterizes them (unrun); static adapter gate and ratchet 78 to 59. **2b (done, unrun):** `application/ai` (6 routes rewired; the other 3 were already thin), `invoice-branding` (2), `receipts` (4), `books-accounts` (9, includes the book delete, moved unchanged; finding F8 open), `jobs/report-schedule` (cron, with `lib/` re-export shim); `wp2b-use-cases.db.test.ts` (unrun); static gate, validator owner checks, ratchet 59 to 46 | 0 handlers left | WP-1 contract and auth tests for the touched routes | low-medium |
| **WP-3 Ledger core** (**done, unrun**) | `lib/finance-accounting.ts` split verbatim into `ledger/books`, `system-accounts`, `journal`, `repayments`, `balances` (`applyPrincipalRepayment` and `recordRepayment` live in `ledger/repayments`; `payAmortizationInstallment` moved with them; late-fee accrual and cascade deletes are in `journal`). Legacy path is a re-export shim with the identical 34-symbol surface; 10 consumers rewired; schedules stay for WP-4. Static compat test, validator `wp3-*` checks. F8 fixed first. | 0 handlers, about 12 functions | WP-1 complete | **high, money-critical** |
| **WP-4 Schedules and assets** (**done, unrun**) | Pure math extracted to `domain/schedules.ts` and held to **443 golden cases captured from the original code** (digest per case, bit-identical, mutation-tested incl. a float-order change); persistence in `schedules/amortization` and `schedules/depreciation`; `application/assets` (10 routes: assets 4, amortization 3, depreciation 3; `payAmortizationInstallment` stays the ledger owner). `lib/finance-accounting.ts` is now a pure re-export shim (34 symbols). F9 and F10a fixed; F10b and F11 were recorded open here; both are fixed in code since (see finance-safety-findings.md). Ratchet 46 to 39. | 0 handlers left | WP-3 | high |
| **WP-5 Entries and recurring** (**5a and 5b done, unrun**) | **5a (done, unrun):** `application/recurring` (5 handlers: CRUD + run-now), `application/journal` (4), `jobs/recurring` (the sweep and cron, moved byte-for-byte except import paths; `lib/finance-recurring-cron.ts` is a re-export shim); F13 fixed (manual journal delete atomic); `wp5a-use-cases.db.test.ts` (unrun); static gate, validator `wp5a-*` checks, ratchet 39 to 31 (run-now never called `db.*`, so 8 not 9). **5b (open):** `application/entries` (17 handlers: entries CRUD, repayments, attachments, invoice-lines, import, export) | 26 handlers (9 done, 17 open) | WP-3, WP-4 | **high** |
| **WP-6 Invoices** (**6a and 6b done and DB-tested on a local Postgres, not yet in the Replit checkout**) | **6a (done, DB-tested):** `finance/invoices/{links,events,store,rule-invoice,pdf,format}` from `lib/finance-invoice.ts` and `lib/invoice-pdf.ts` (both now re-export shims, no importers left); `application/invoices` (11 handlers); F15 to F18; `wp6a-use-cases.db.test.ts`; ratchet 18 to 8. **6b (done, DB-tested locally):** `application/payment-agreements` (6 handlers: public view, passkey options and verify, evidence PDF, verify, dispute); F19 to F22 (F22 is in `application/invoices#cancelInvoice`); `wp6b-use-cases.db.test.ts` (37 tests, race and rollback cases; 176/176 in the full DB suite; see `fin-wp6b-evidence.json`); owner decisions after 6b: submit counts pending claims, and a paid invoice can be cancelled as an appeal with a reason that reverses the payment (see F21 and F22); `passkey_credentials` stand-in in the DB runner; boundary checks `wp6b-*`; ratchet 8 to 2. The two remaining routes with direct `db.*` are `PUT /finance/payment-methods/:id` in `finance-invoices.ts` and the false-positive helper block after `DELETE /finance/books/:id` in `finance.ts` | 17 handlers (17 done) | WP-1, WP-3 | high |
| **WP-7 Fees, jobs, wallet** (**done in code, DB tests written, unrun**) | **Done:** `domain/late-fees` (pure formula, held to a verbatim copy of the original over about 17,000 grid cases), `fees/late-fees` (sweep; F23), `jobs/late-fee`, `jobs/reminder` (F24), `jobs/invoice-reminder` (F25), `jobs/digest`, `jobs/networth`, `integrations/wallet-bridge` (F26); the six `lib/finance-*` files are re-export shims with no importers; `ledger/journal` gains `postEntryJournalInTx` and `postLateFeeAccrualJournalInTx`; validator `wp7-*` checks; `wp7-use-cases.db.test.ts` (written, not run: no DB driver in the session) and a `wallets` stand-in in the DB runner. **Original scope:** `fees/late-fees` (`finance-late-fee-cron.ts`, 157; pure accrual formula can be split earlier), `jobs/*` from the remaining crons (reminder 86, invoice-reminder 108, digest 40, networth 38), `integrations/wallet-bridge` (101) | 0 handlers | WP-3, WP-6 | medium-high |
| **WP-8 Retire shims (FIN-05)** (**done in code, unrun**) | Consumer scan found 5 importers outside the shims (`index.ts` for the recurring cron, `ledger-invariants.db.test.ts`, `reports.db.test.ts`, `lib/finance-accounting.db.test.ts`; the rest were already on the owners) and rewired them; all 14 shims and `invoice-pdf` deleted; routes now import Finance code only through `finance/application/*` (new thin entry points `application/networth.ts` and `application/payment-methods.ts`, re-exports added to `application/ai.ts`, `assets.ts`, `invoices.ts`; an unused `resolveBookId` import was dropped from `routes/finance.ts`); validator: shim checks replaced by `wp8-shims-removed`, `wp8-no-legacy-importers`, `wp8-routes-import-application-only`; `ledger-compat.test.ts` reduced to ownership checks; 7 static gates | all | WP-2 to WP-7 | medium |
| **WP-9 Close-out (FIN-06)** (**done; final pack BLOCKED**) | Final boundary scan (PASS, 55 sources, 0 findings), evidence index (`finance-evidence-index.md`), target-tree status updated to final, remaining-risk register (`finance-risk-register.md`, 19 items), final migration map (`fin-final-migration-map.csv`), `finance-final-validation.json`, raw logs in `reports/antas/finance/wp9-logs/`; new tools `measure-final-state.mjs` and `check-import-integrity.mjs`. Verified: static tests 85/85, provenance 0 drift, import integrity 0 findings over 740 files. **Not run: `pnpm typecheck`, `pnpm build`, `test:finance-db`, staging (no package registry, no Postgres in the session).** Edited only docs, reports and two scripts; no source, CI or package file | docs | WP-8 | low |
| **WP-10 Service parity (FIN-04)** | Optional, separate decision: `services/finance` covers a small account/transaction subset with different storage semantics (integer cents vs `real`). Gateway stays opt-in. Not required to finish the in-API-server extraction | | WP-9 | high |

Handler count check: WP-2 40 + WP-4 8 + WP-5 26 + WP-6 17 + investments 1 = 92; plus 10 report + 3 net-worth + 4 payment-method adapters = 17; 92 + 17 = 109 = `finance.ts` 86 + `finance-invoices.ts` 23 (grep, 2026-10-20).

### WP-0 outcome

| Item | Result |
|---|---|
| Promote FIN-02B/02C | Promoted to PASS with a `promotion` block citing the FIN-02D full run; caveat recorded (indirect, still uncommitted). |
| Commit provenance | Base SHA `93ed60540127c1a4819cf957bfc4ba415199bf48` (from FIN-02D) recorded; `scripts/antas/finance/provenance.mjs` plus `reports/antas/finance/fin-provenance-manifest.json` bind this tree's Finance files to git blob hashes so they can be verified in the checkout. A SHA for the finished work needs a commit. |
| `capability-gate` test | Stale test, not a service defect: `CAPABILITY_AUTHZ_GATE` defaults to `enforce` (H9.2), so the report-mode test expecting 200 with `scopes: []` got 403. Fixed as a separate one-line test change pinning the fine-grained gate to `off`; 11/12 before, 12/12 after. |
| `/finance/investments` | Assigned to `application/reports.ts`; first slice of WP-2. |

## 3. Legacy files still owning logic

| File | Lines | Target | WP |
|---|---|---|---|
| `lib/finance-late-fee-cron.ts` | 157 | `fees/late-fees`, `jobs/late-fee` | 7 (done) |
| `lib/finance-invoice-reminder-cron.ts` | 109 | `jobs/invoice-reminder` | 7 (done) |
| `lib/finance-wallet-bridge.ts` | 102 | `integrations/wallet-bridge` | 7 (done) |
| `lib/finance-reminder-cron.ts`, `-digest-cron.ts`, `-networth-cron.ts` | 164 | `jobs/*` | 7 (done) |
| `routes/finance.ts`, `routes/finance-invoices.ts` | 1,447 + 581 | adapters over `application/*` (both are thin now apart from validation, PDP checks and the payment-method PUT) | 3 to 6, done |

## 4. Order and stop conditions

1. WP-0, then WP-1 (everything money-related waits on it).
2. WP-2 in small slices (read paths before writes).
3. WP-3, WP-4, WP-5, WP-6 one at a time; never two money-critical packages in the same sub-phase.
4. WP-7, WP-8, WP-9. WP-10 only if the service cutover is wanted.

Stop and report instead of continuing if: a baseline test cannot be written without changing behavior,
a move needs a schema change, a cycle appears in the boundary scan, or a production database would be touched.

## 5. Definition of done (extraction complete)

- 0 route handlers contain direct `db.*` calls; routes call `application/*` only.
- Every Finance owner has a single declaration in the validator owner table; no `lib/finance-*.ts` shim remains.
- WP-1 suite green on the isolated schema, plus typecheck, build and boundary scan, with a bound commit SHA.
- Each sub-phase has an evidence file with real exit codes; unrun checks listed under `notRun`.

Status at WP-9 (2026-10-20):

| Item | Status |
|---|---|
| 0 route handlers with direct `db.*`; routes call `application/*` only | **Met for writes and logic** (0 write lines; routes import Finance code only through `application/*`, checked by `wp8-routes-import-application-only`). Read-only: 6 one-column `userId` SELECTs remain for PDP ownership lookups (risk R-10). |
| Single declaration per owner; no shim | **Met** (validator owner table; 0 legacy files; 0 real importers). |
| WP-1 suite green on the isolated schema, plus typecheck, build, boundary scan, bound SHA | **Not met.** Boundary scan PASS. DB suite last green (176/176) at WP-6b on a local Postgres, not at this revision; typecheck and build not run at this revision; no commit SHA (risks R-01, R-02, R-03, R-12). |
| Evidence per sub-phase with real exit codes, unrun checks under `notRun` | **Met in form** (31 evidence files plus `finance-final-validation.json`); 7 PASS, 24 BLOCKED. |

So the extraction is complete in code, and "extraction complete" in the sense of this section is **not yet claimable** until the third row is met in a real checkout.

## 6. Size

About 15 sub-phases: WP-0 1, WP-1 2 to 3, WP-2 4, WP-3 1 to 2, WP-4 1 to 2, WP-5 2, WP-6 2, WP-7 2, WP-8 1, WP-9 1.
Roughly 55 percent of the remaining effort is in WP-3 to WP-7, the money-critical group.

## 7. Not in scope

Schema changes or data backfills; production database access; new providers; a separate `reconciliation/`,
`payments/`, `contracts/` or `infrastructure/` tree (see the target-tree "Deliberately NOT created" table).
