# Boundary findings (cross-domain imports, shared access, non-deployable modules)

Phase 0 tasks: identify direct cross-domain imports, identify shared utility
packages, identify shared database access, identify modules that cannot
currently be deployed independently. This is what the scan found.

## 1. Direct cross-domain imports (confirmed by grep, not inferred)

| From domain | File | Imports directly from | Target domain |
| --- | --- | --- | --- |
| Vault | `routes/vault.ts` | `createNotification` from `./notifications` | Notification |
| Vault | `routes/vault.ts` | `sendToUser` from `../lib/telegram` | Telegram Gateway |
| Vault | `routes/vault.ts` | `syncOnVaultUpdate`, `syncOnVaultStatusChange`, `syncOnVaultDelete`, `delistVaultMarketplaceListings` from `../services/sync` | Marketplace |
| Finance | `routes/finance-invoices.ts` | `sendInvoiceEmail`, `sendPaymentAgreementEmail`, `sendPaymentAgreementReadyEmail`, `sendPaymentDisputedEmail` from `../lib/email` | Mail |
| Finance | `routes/finance-invoices.ts` | `sendToUser`, `sendToUserWithButton` from `../lib/telegram` | Telegram Gateway |
| Notification | `lib/notification-bus.ts` | `createNotification` from `../routes/notifications`, `sendToUser` from `./telegram`, `sendNotificationEmail` from `./email` | Telegram Gateway, Mail (Notification itself fans out via direct calls, not events) |

None of these are technically forbidden yet — Phase 1 ("No importing another
domain's private implementation," "No direct access to another domain's
repository") has not been enforced. They are exactly the pattern Phase 1's
rules are designed to close: today Vault, Finance and Notification each reach
directly into another domain's route/lib file rather than going through a
public application API or an event. Each of these is a concrete refactor
target for Phase 7 (Modular Monolith Internal APIs).

## 2. Shared database access

- `lib/db` (published internally as `@workspace/db`) exports every table for
  every domain from one package. **253 files** import it directly.
- The ownership registry (`service-boundaries.ts`) exists but is only
  enforced (called at runtime) in **2 of 15 domains** — see
  `docs/inventory/database.md` for the full finding. In practice, any file
  that imports `@workspace/db` can currently query any table, regardless of
  declared ownership.

## 3. Shared utility packages

Two different kinds of "shared" exist today, and Phase 2 should not conflate
them:

- **Already package-ized** (`packages/*`): `auth-client`, `config`,
  `contracts`, `event-client`, `events`, `logger`, `reliability`,
  `service-runtime`, `telegram`, `telemetry`, `tracing` — these are proper
  independent packages a future extracted service can depend on without
  pulling in the monolith.
- **Still monolith-internal** (`artifacts/api-server/src/lib/sub-engines`,
  `new-engines`, `mega-engine`): cache, feature flags, rate limiting, queueing,
  blob storage and the AI gateway all live here and are imported broadly
  across domains (see `docs/inventory/engines.md`), but are not published as
  packages. A future extracted service cannot depend on them without either
  duplicating the logic or reaching back into the monolith — which Phase 2
  explicitly should prevent by promoting the reusable pieces into
  `packages/*` before any domain that depends on them is extracted.

## 4. Modules that cannot currently be deployed independently

Every domain except the API Gateway itself. Concretely:

- `services/<domain>` packages (finance, vault, mail, notification, workflow,
  ai, marketplace, search) are transport stubs — `src/index.mjs` plus a
  `README.md` and `package.json`, no business handlers, no owned-schema
  adapter (confirmed by file listing: 3 files each). The gateway's default
  route target for every one of these families remains the monolith
  (`docs/architecture/service-split.md`'s routing table).
- All 17 scheduled jobs (`docs/inventory/scheduled-jobs.md`) run in-process
  inside `artifacts/api-server`; there is no separate worker deployment.
- The engines (`mega-engine`, `new-engines`, `sub-engines`, `acie`) are not
  independently deployable and are not on the roadmap's extraction list —
  they are expected to remain inside the monolith or be absorbed into shared
  packages, not extracted as services themselves.

This confirms the domain-map's per-domain "extraction difficulty" column and
directly supports `extraction-candidates.md`'s ranking: extraction readiness
in this codebase is currently a spectrum from "scaffolded, not real"
(Finance, Vault, Mail, Notification, Workflow, AI, Marketplace, Search) to
"not even scaffolded" (Identity, Authorization, Analytics, Search-Knowledge's
route logic, Event Bus's HTTP surface).
