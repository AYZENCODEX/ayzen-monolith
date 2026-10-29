# FIN-00-A — Finance inventory and baseline

**Status: BLOCKED**

The repository inventory and declared build baseline are complete. The financial gate is blocked because no provider-backed ledger dataset or Finance-specific invariant test suite is available. No business logic was changed and no later roadmap phase was executed.

## Repository state

- Commit at inspection: `023e9989c6796476106ecb8c61a79e524fa8b5fd` (branch `main`).
- Initial tracked worktree was clean; the attached roadmap was the only untracked file.
- Frozen install and the complete declared workspace build/typecheck passed. No lockfile or package manifest changed.
- Build generated a date-only update to `infrastructure/platform/feature-circuits.json`; it was restored. No unrelated tracked diff remains.

## Inventory

- 91 Finance-named paths: api-server 16; ayzen-ui 49; assurance-docs 1; migration-registry 1; database-schema 1; migrations 17; other-finance-match 2; assurance-script 1; finance-service 3.
- 109 handler declarations in the two Finance route modules; 1 separate payment-webhook handler.
- 111 Finance route records in the endpoint registry. These are not assumed to map one-to-one to handler declarations.
- The frontend has 39 source files calling `financeApi`.
- Finance database schema: 24 table definitions and 16 Finance SQL migrations.
- Extracted service: 4 handler branches for account/transaction operations; it is not route-complete for the monolith Finance API.
- Event contract: `finance.transaction.created`; notification, search, and workflow are consumers. Search fetches the transaction by ID.

## Current ownership and consumer map

The CSV beside this report records the grouped source → owner → consumers → status map. Key finding: the gateway can forward the entire `/api/finance` prefix to `services/finance` when configured, but the service implements only a small account/transaction subset while the monolith exposes the broader Finance and invoice surface. Keep the monolith as compatibility authority until route parity and money semantics are proven.

The monolith's kind-based Finance ledger is documented as the day-to-day source of truth; `finance-accounting.ts` mirrors it into journal postings. The monolith schema stores monetary values as `real`; the extracted service uses integer `amountCents` and separate service-state collections. Currency, conversion, transaction, and source-of-truth rules remain unresolved.

## Baseline results

| Command | Exit | Result |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Installed locked dependencies; lockfile unchanged. |
| `pnpm run build` | 0 | Root typecheck and recursive builds passed; Vite reported a large-chunk warning. |
| `node --test apps/api-gateway/src/routing.test.mjs` | 0 | 10/10 passed. |
| `node --test apps/worker/src/consumers.test.mjs` | 0 | 7/7 passed. |
| `node --test services/search/src/event-handlers.test.mjs` | 0 | 6/6 passed, including Finance event lookup. |
| Finance reconciliation script in an isolated temp copy | 0 | Contract markers found; every financial check remained UNVERIFIED. |

The root package has no test or lint script; CI has no test step; the Finance service package has no test script; and no finance-specific tests were found in the monolith. No real-ledger, staging, production, or recovery checks ran. The existing ANTAS-06 reconciliation report was not overwritten.

## First extraction status

The proposed pure `computeLineItemsTotal` / `computeInvoiceTotals` extraction is complete as FIN-02. The canonical calculations live in the Finance domain module, while `lib/finance-invoice.ts` preserves the established exports. Its four characterization tests pass; see `fin-02-evidence.json`. This does not extract or prove the ledger posting, repayment, or provider paths.

## Next safe step

At the original FIN-00-A baseline, the next step was a disposable PostgreSQL fixture. A Replit-managed development database is now available for tests, and two database-backed characterizations pass; rollback, retry/idempotency, authorization, and route parity still need proof. Keep service routing and legacy consumers unchanged until those gates pass. See the current revalidation below and `fin-03-evidence.json`.

## Current checkout revalidation

Rechecked on commit `45f9ece9b535ee4cf27c605d75cd2da5dee22acc` on 2026-10-14. The tracked tree was clean before verification; the user-provided roadmap was untracked.

| Command | Exit | Result |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Installed 929 locked packages; lockfile unchanged. |
| `pnpm run build` | 0 | Workspace typecheck and recursive builds passed. Vite reported existing sourcemap and large-chunk warnings. |
| `pnpm validate:finance-boundaries` | 0 | 18 Finance sources scanned; no ownership, import, or cycle findings. |
| `pnpm --filter @workspace/api-server exec node --test --import tsx src/finance/domain/invoice-totals.test.ts` | 0 | 4/4 invoice-total characterization tests passed. |
| `node --test apps/api-gateway/src/routing.test.mjs apps/worker/src/consumers.test.mjs services/search/src/event-handlers.test.mjs packages/service-runtime/test/capability-gate.test.mjs` | 1 | 34/35 passed. The existing `SERVICE_CAPABILITY_GATE=report` test failed: actual 403, expected 200 (`packages/service-runtime/test/capability-gate.test.mjs:217`). |

The extraction remains **BLOCKED** beyond the pure invoice-total module: no usable disposable Finance database connection or ledger fixture is available, the standalone service still has only partial route coverage and different persistence/money semantics, and the unrelated shared service-runtime test failure remains recorded. No Finance business code, route, schema, or consumer was changed. The build's generated date-only update to `infrastructure/platform/feature-circuits.json` was restored.

A follow-up attempt used a throwaway local PostgreSQL cluster only. The database package's schema push reported success, but the subsequent test query failed because `finance_books` was absent. The cluster was stopped and deleted. No existing project database or production data was used, and no database-backed Finance test passed in this attempt.

The configured database secret was then checked using read-only queries only. Both connection paths failed: the API-server pool returned SQLSTATE `XX000`, and the development database query returned `ENOTFOUND` because the configured tenant/user was not found. The URL and credentials were not printed or recorded; no schema or data writes were attempted.

## Replit test database revalidation

Revalidated on 2026-10-16 local time. The user selected Replit's managed development database for tests and removed the old custom `DATABASE_URL` override. Application connections and test connections now have separate selectors: application code uses `APP_DATABASE_URL` when configured; the explicit `DATABASE_URL_TARGET=replit-test` target uses Replit's runtime-managed `DATABASE_URL`.

The attempted Finance-only Drizzle push did **not** stay Finance-only: the installed Drizzle CLI ignored the configured `tablesFilter` and applied the full application schema to the Replit development database. The existing `rate_limit_buckets` table remains; no tables were dropped and no migration/backfill scripts were run. The Finance tables were empty before the tests. Test-created rows use negative synthetic user IDs and were cleaned; a follow-up count found zero negative-user books, ledger entries, accounts, or journals. No Supabase schema or data was changed. Do not run another broad schema push against this test database.

`pnpm --filter @workspace/api-server test:finance-db` passes 2/2 database-backed tests: a balanced 125.50 journal posting and two concurrent 40.00 principal decrements against 100.00, leaving 20.00 with `partial` status. The latter preserves the existing SQL calculation while moving it from the route into `finance-accounting.ts`. These tests do not cover authenticated routes, rollback, duplicate requests, retry/idempotency, or authorization; journal posting still writes its header and lines separately, and repayment journal posting remains best-effort.

The overall modular extraction remains **BLOCKED**. The candidate Finance service still covers only a small account/transaction subset of the monolith and uses different amount/persistence semantics. Do not enable service routing, migrate consumers, or retire monolith routes. `APP_DATABASE_URL` is not yet configured, so the app currently falls back to Replit's managed database. Restore Supabase as the app database only after rotating the credential previously pasted in chat and entering the replacement through Replit Secrets. The existing unrelated `SERVICE_CAPABILITY_GATE=report` test failure (403 expected 200) remains unresolved.
