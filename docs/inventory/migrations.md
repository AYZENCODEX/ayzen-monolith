# Migration inventory

`migrations/*.sql` (Drizzle-managed, applied via `lib/db`) contains **104**
files, numbered sequentially (`011_passkeys.sql` … `117_ayzen_mega_engine_j7_j13_hardening.sql`).
Grouping by filename keyword gives a rough domain-of-origin split — useful as
a proxy for "how much schema churn has this domain had," which correlates
with extraction risk (more churn = more coordination needed during cutover):

| Domain (by filename keyword) | Migration count |
| --- | --- |
| Vault | 20 |
| Mail | 20 |
| Finance | 16 |
| Identity / OIDC | 15 |
| Authorization (RBAC, policy, permissions, resource grants) | 8 |
| Workflow / scheduler | 5 |
| Mega Engine (event bus, scheduler, workflow platform phases) | 3 |
| Notification | 1 |
| Workspace / Organization | 1 |
| Other / unclassified by name alone | 15 |

Vault and Mail together account for ~38% of all migrations, consistent with
them also owning the two largest route surfaces (`routes/vault*.ts`,
`routes/mail*.ts` families). This is additional evidence, beyond route/lib
file counts, that Vault and Mail carry the deepest schema history and
therefore the highest data-migration risk in Phase 26 (Data Migration &
Ownership Cutover).

## Gap identified

The migration files do not carry an explicit `-- owner: <domain>` header, so
ownership above is inferred from filenames only ("other" is 15 files whose
names do not map cleanly to a single domain, e.g. cross-cutting audit-log or
platform tables). Phase 5 (Database Ownership & Data Boundaries) should add an
owner annotation convention so future migrations are self-describing, and
Phase 0's declared-ownership gap (see `docs/inventory/database.md`) should be
closed before relying on this classification for cutover planning.
