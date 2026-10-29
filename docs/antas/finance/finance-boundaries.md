# Finance module boundaries

## Scope and compatibility

Finance remains inside the existing API server. Its Express routes are
compatibility adapters: retain their paths, methods, request/response shapes,
authorization, ownership checks, transaction behavior, and public-token
semantics. This boundary map is not approval to cut over `/api/finance` to the
separate service or to change the database.

`financeLedgerEntriesTable` is the current kind-based ledger used by the
Finance UI. Journal postings are a separate accounting representation written
by the accounting layer; do not treat them as a replacement source of truth.
Both the monolith and extracted service have monetary-storage differences, so
no cross-store conversion or data migration is implied here.

## Canonical owners

| Responsibility | Canonical owner | Compatibility consumers / notes |
|---|---|---|
| Pure invoice line totals, discounts, tax, and rounding | `artifacts/api-server/src/finance/domain/invoice-totals.ts` | Imported directly by the invoice owners (the `lib/finance-invoice.ts` re-export was removed in WP-8). |
| Pure invoice numbering and amount-in-words formatting | `artifacts/api-server/src/finance/domain/invoice-format.ts` | Imported directly by `invoices/*`. |
| Pure schedule/recurrence calendar math (month-end clamping for amortization due dates and recurring-rule next-run dates) | `artifacts/api-server/src/finance/domain/recurrence-dates.ts` | `domain/schedules.ts` and `jobs/recurring.ts`. Local-timezone semantics unchanged. |
| Read-only Finance reports and dashboard use cases | `artifacts/api-server/src/finance/application/reports.ts` | `routes/finance.ts` delegates while preserving route paths, methods, auth, and formatting. |
| Payment-method persistence, public-safe listing, labels, and QR generation | `artifacts/api-server/src/finance/payment-methods/payment-methods.ts` | Reached by the routes through `application/payment-methods.ts`. |
| Invoice persistence, lifecycle, token/URL helpers, and recurring invoice orchestration | `artifacts/api-server/src/finance/application/invoices.ts`, `application/payment-agreements.ts`, `invoices/*` | Routes import `application/*`; `jobs/recurring.ts` uses `invoices/rule-invoice.ts`. |
| Books, system accounts, journal postings, repayments, and accounting schedules | `artifacts/api-server/src/finance/ledger/*`, `schedules/*`, `domain/schedules.ts` | Application use cases, jobs and the wallet bridge; ledger modules never import `lib/`, `routes/` or `application/`. |
| Wallet/deposit-to-ledger integration | `artifacts/api-server/src/finance/integrations/wallet-bridge.ts` | Wallet routes and deposit watcher. Existing unique source identifiers and duplicate-event handling stay intact; entry and journal are one transaction (F26). |
| Net-worth and goal calculations/snapshots | `artifacts/api-server/src/finance/networth/networth.ts` | Routes through `application/networth.ts`; the net-worth job and notifications import the owner. |
| Finance parsing and insight use cases | `artifacts/api-server/src/finance/ai/finance-ai.ts` | Routes through `application/ai.ts`. Provider behavior is unchanged. |
| Receipt-token creation and public URLs | `artifacts/api-server/src/finance/receipts/receipt-tokens.ts` | `application/receipts.ts` and notifications import the owner. |
| Finance notifications | `artifacts/api-server/src/finance/notifications/notify.ts` | Finance routes and the daily digest job import the owner; |
| Fee, recurring, reminder, digest, net-worth and report jobs | `artifacts/api-server/src/finance/fees/late-fees.ts`, `artifacts/api-server/src/finance/jobs/*` | Scheduler registration stays in `index.ts`, which imports the job owners. |
| Persistence schema | `lib/db/src/schema/finance.ts` plus the ordered SQL migrations | API-server Finance routes and jobs. No schema migration is included. |
| HTTP and public-link contracts | `routes/finance.ts` and `routes/finance-invoices.ts` | Frontend, endpoint registry, auth/policy middleware, and public invoice/receipt clients. Keep as adapters. |
| Finance event contract | `packages/events` | Existing event producers/consumers retain their current ownership and payloads. |
| Extracted Finance transport boundary | `services/finance/src/index.mjs` | Owns only its implemented account/transaction subset; it is not a canonical replacement for the monolith API. Keep gateway opt-in disabled until route and money-semantic parity is proven. |

## Import rules

- The `finance/domain` layer is pure: no database, ORM, HTTP framework, route,
  provider, filesystem, UI, or service-bootstrap dependency.
- Finance routes may call the API-server Finance application/library owners
  and shared database schema. They do not become a second implementation of
  domain calculations.
- Finance domain and library modules must not import Finance route handlers.
  The three existing job/notification-to-`routes/notifications` imports are
  explicitly recorded legacy edges; do not add more. They are not evidence of
  a cycle or permission to move Finance behavior into a route.
- `finance/notifications/notify.ts` retains one of those pre-existing
  notification-route edges after extraction; the relocation does not authorize
  additional edges.
- No Finance module may import the extracted service implementation. The
  service is a downstream boundary, not a dependency of the monolith.
- Relative import cycles that include Finance sources are forbidden.

The blocking `validate:finance-boundaries` CI check scans the API-server and
extracted-service Finance sources for pure-domain imports, duplicate
invoice-total implementations, broken compatibility exports, unapproved
route edges, local import cycles, and the single-owner/consumer wiring for
extracted reports and payment methods. It writes its current result to
`reports/antas/finance/fin-01-dependency-scan.json`. It does not assert route
parity or ledger equivalence for the separate service; those still block
cutover.

`pnpm --filter @workspace/api-server test:finance-db` targets the Replit
development database only. It creates a uniquely named isolated schema,
applies only allowlisted Finance table DDL without data backfills or a public
schema fallback, runs the Finance database tests, and drops the schema.
The per-area implementation map and remaining gates are tracked in
`docs/antas/finance/finance-target-tree-status.md`.

## Explicit non-goals

This boundary definition does not claim route parity, ledger reconciliation,
provider-backed behavior, rollback/concurrency proof, or production readiness.
Those remain separate gates. Do not delete or redirect legacy Finance routes
until the affected consumers and financial behavior have executable proof.
