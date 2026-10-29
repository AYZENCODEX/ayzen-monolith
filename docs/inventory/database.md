# Database inventory

The project uses PostgreSQL through `lib/db` and Drizzle migrations. The
current cluster contains domain-owned table groups including:

- users, sessions, OTP, passkeys, JWT signing keys, OIDC clients;
- workspaces, organizations, RBAC, resource grants, temporary access;
- finance, credits, wallets, invoices, accounting and reports;
- vault records, attachments, snapshots, sharing and backup audit;
- mailbox, email accounts, messages, send queue and delivery state;
- workflow definitions/runs, scheduler and engine audit;
- notifications, preferences, activity and telemetry;
- event outbox, processed consumers, dead letters and service boundaries;
- Telegram bot registry and update receipts.

The `service-boundaries` registry (`artifacts/api-server/src/lib/service-boundaries.ts`,
`OWNED_TABLES`) is the ownership guard, exposing `getTableOwner()` and
`assertTableOwnedBy()`. Physical database splitting is deferred until scale,
compliance, isolation, or reliability data justifies it.

## Ownership coverage (Phase 0 finding)

The schema (`lib/db`) defines **178** tables (`pgTable(` call sites). The
`OWNED_TABLES` registry declares an owner for roughly **40–45** of them across
all 15 domains — meaning **most tables in the schema do not yet have a
recorded owner**. This is expected for a Phase-0-stage system (the registry
currently lists each domain's core tables, not every table), but it is a real
gap, not a documentation gap: any table missing from `OWNED_TABLES` is
invisible to `assertTableOwnedBy()` and can be queried by any domain without
triggering a boundary violation.

Runtime enforcement is even thinner than declaration: `assertTableOwnedBy()`
is only actually called from two files in the whole codebase today
(`lib/workspace-service.ts` for `workspaces`/`workspace_members`, and
`lib/telegram-gateway.ts` for `telegram_update_receipts`). Every other
domain's ownership is declarative only — nothing prevents a route handler in
one domain from importing `@workspace/db` (as 253 files across the codebase
already do) and querying a table owned by another domain.

**Recommendation for Phase 1:** treat "expand `OWNED_TABLES` to cover all 178
tables" and "call `assertTableOwnedBy` from every domain's data-access layer,
not just two" as concrete, checkable Phase 1 tasks rather than assuming the
registry's existence already satisfies "no shared database access" (Core
Principle 4).