# AYZEN domain map

Source of truth for this table is code, not opinion: `SERVICE_DESCRIPTORS` and
`DOMAIN_SERVICE_CONTRACTS` (`artifacts/api-server/src/lib/architecture/domains.ts`,
`.../lib/domain-service-contracts.ts`) plus `OWNED_TABLES`
(`.../lib/service-boundaries.ts`). Every field below is either read directly
from those registries or derived from a repository scan (route/lib file
counts, migration counts, event registrations). This satisfies the Phase 0
Definition of Done: every domain has an owner, dependencies, data ownership,
API surface, event surface, extraction difficulty, and operational
importance.

| Domain | Owner (process today) | Dependencies (calls out to) | Data ownership (declared tables) | API surface | Event surface (produces / consumes) | Extraction difficulty | Operational importance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| API Gateway | `apps/api-gateway` (own process) | Routes to monolith or service URL per `routeEnv` | `service_registry`, `service_table_ownership` | `/health`, `/live`, `/ready`, `/metrics`, `/internal/routes` | none / none | Low (already a separate process) | Critical — single public edge |
| Telegram Gateway | `artifacts/api-server` (transport stub also in `apps/telegram-gateway`) | Identity (auth context), Workspace, Notification, Workflow | `telegram_bots`, `telegram_update_receipts` | `/api/telegram`, webhook receiver | produces `telegram.notification.requested` | Low-medium (webhook verification + idempotent update claim already isolated) | High — external channel, abuse surface |
| Identity | `artifacts/api-server` | none (root of trust) | `users`, `user_sessions`, `passkeys`, `otp_codes`, `jwt_signing_keys`, `oidc_clients` | `/api/auth`, OIDC discovery/authorize/token/userinfo/JWKS (30+ route files under `routes/oidc-*.ts`) | produces `oidc.login`, `oidc.session.created`, `oidc.session.revoked`, `oidc.logout` | High (every other domain depends on it; must ship first) | Critical — platform root of trust |
| Authorization | `artifacts/api-server` | Identity (actor), Workspace (resource scope) | `roles`, `permissions`, `role_permissions`, `user_roles`, `authorization_audit_log` | PEP/PDP middleware (`lib/policy/*`), no direct public routes | produces none registered yet | Medium (logic is centralized in `lib/policy`, but is called from nearly every route file) | Critical — every mutation passes through it |
| Workspace | `artifacts/api-server` | Identity | `workspaces`, `workspace_members`, `organizations`, `organization_members` | `/api/workspaces`, `/api/organizations` | produces `organization.member.invited/joined/role_changed/removed` | Low (one of two domains that already calls `assertTableOwnedBy` at runtime) | Critical — tenancy boundary for every domain |
| Finance / RYFT | `artifacts/api-server` | Identity, Workspace, Vault (wallet bridge), AI (credit metering) | `finance_ledger_entries`, `finance_accounts`, `finance_invoices` (16 of 104 migrations touch finance — largest single migration family) | `/api/finance` (`routes/finance*.ts`, 9 files) | produces `credits.consumed`, `credits.consumption_failed` | High (9 route files, 10 `lib/finance-*` cron jobs, deepest migration history) | High — revenue-bearing |
| Vault / SYLO | `artifacts/api-server` | Identity, Notification (`createNotification` imported directly into `routes/vault.ts`), Marketplace (`delistVaultMarketplaceListings` in `services/sync.ts`) | `vault_entries`, `vault_security`, `vault_attachments`, `vault_snapshots` | `/api/vault` (11 route files, incl. `vault.ts` at 108K — largest single route file in the repo) | consumes vault mutations internally to raise `vault.share.created`/`vault.share.revoked` | High — largest route surface, encryption/backup lifecycle, and a confirmed direct cross-domain import into Notification | Critical — user data custody |
| WISP / Mail | `artifacts/api-server` | Identity, Notification | `mail_messages`, `email_accounts`, `ayzen_mailbox` | `/api/mail`, inbound webhook, send queue | produces `notification.requested/delivered/failed` (shared event names with Notification domain — see gap below) | Medium-high (SMTP/IMAP provider integration adds external-system risk) | High — customer-facing delivery guarantees |
| Notification | `artifacts/api-server` | Identity, Workspace, Telegram Gateway, Mail | `notifications`, `notification_preferences` | `/api/notifications` | consumes `notification.requested`; produces `notification.delivered/failed` | Low-medium (already a clean fan-in consumer of other domains' events) | High — user-visible but degrades gracefully (Phase 25 pattern) |
| Workflow / SKARN | `artifacts/api-server` | Identity, Workspace, Notification, AI | `workflow_run`, `scheduled_job`, `scheduled_job_attempt` | `/api/workflows` | produces `workflow.started/completed/failed/cancelled/timed_out`; consumes scheduler triggers (`lib/workflow/triggers.ts`, `schedule-triggers.ts`) | High — is itself both the largest event **producer** (`run-store.ts`, `scheduler/worker.ts`, `scheduler/job-store.ts` account for 18 of the 19 non-bus `publishEvent` call sites) and a consumer | High — durable execution guarantees |
| AI / ZYNTH | `artifacts/api-server` | Identity, Finance (credit charge), Workflow | `ai_actions`, `mcp_agents` | `/api/ai`, `/api/mcp*`, `/api/tools` | produces `ai.action.requested/completed/failed` | Medium (contained route surface, but overlaps `mega-engine`/`new-engines`/`sub-engines` internal platforms — see engine inventory) | Medium-high — cost-bearing (credits), model/tool dependency |
| Marketplace | `artifacts/api-server` | Identity, Workspace, Vault, Finance | `marketplace_listings`, `marketplace_orders` | `/api/marketplace` (13 route files: cart, offers, spot, nft, usdt, wallet, coupons, reviews...) | produces `project.lifecycle.changed` | High (13 route files; widest surface of any domain after Vault) | Medium — growth surface, not yet revenue-critical path |
| Search / Knowledge | `artifacts/api-server` | reads across domains for indexing | `search_index` | `/api/search` | none registered | Low (small, mostly read-only) | Low-medium |
| Analytics | `artifacts/api-server` | reads across domains for telemetry | `request_metrics`, `user_activity` | `/api/analytics` | none registered | Low | Low — internal/product telemetry only |
| Event Bus | `artifacts/api-server` (`lib/event-bus/*`) | none (infrastructure) | `event_outbox`, `event_processed`, `event_processing`, `event_dead_letter` | internal only | provides publish/subscribe/dead-letter/idempotency primitives used by all producers/consumers above | Low (already isolated as a `packages/events` + `lib/event-bus` pair) | Critical — every async guarantee in the system depends on it |

## Notes on "extraction status" vs. reality

The registry (`SERVICE_DESCRIPTORS.extractionStatus`) currently marks Finance,
Vault, Workflow, Mail, Notification, AI, Marketplace and Search as
`independent_process`, each with a scaffolded package under `services/<name>`.
Repository inspection shows those packages are transport stubs only
(`src/index.mjs` + health checks, ~3 files each) — no business handlers, no
owned-schema adapter. Per `current-state.md` and Phase 0's own scope ("map
before changing runtime boundaries"), **none of these domains can currently
deploy independently**; the gateway's default routing target for every family
remains the monolith. This is recorded explicitly as a Phase 0 finding in
`extraction-candidates.md` so Phase 1+ does not mistake scaffold presence for
extraction completion.

Domain ownership is distinct from process ownership. Multiple domains may share
one process while still keeping data, permissions, and event ownership clear.