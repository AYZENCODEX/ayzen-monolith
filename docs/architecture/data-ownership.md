# Domain data ownership — phases 1–15

The shared PostgreSQL cluster remains the deployment default. Ownership is a
logical boundary first; a separate database is only introduced after a
measured migration gate.

| Domain | Owner | Resources | Current migration mode |
| --- | --- | --- | --- |
| Identity | Identity | users, credentials, sessions, MFA, OIDC clients | compatibility adapter → controlled read/write cutover |
| Authorization | Authorization | policies, roles, permissions, policy audit | modular monolith |
| Workspace | Workspace | workspaces, memberships | modular monolith |
| Finance / RYFT | Finance | accounts, transactions, ledger, finance audit | isolated service seam; ledger cutover pending |
| Vault / SYLO | Vault | encrypted records, versions, access audit | isolated service seam; encrypted data cutover pending |
| Mail / WISP | Mail | mailboxes, messages, threads, attachment metadata | isolated service seam; mailbox cutover pending |
| Notification | Notification | templates, preferences, deliveries | isolated service seam; delivery cutover pending |
| Workflow / SKARN | Workflow | definitions, versions, executions, steps, schedules | isolated service seam; worker cutover pending |

No extracted service is allowed to write another domain's resources. During
the compatibility period, the gateway can route a domain back to the
monolith by removing that domain's `*_SERVICE_URL`; this is the rollback path,
not a second writer.