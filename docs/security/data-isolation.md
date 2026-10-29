# App data isolation

Logical ownership is enforced before physical database separation. Each
resource has an owning app/domain, tenant scope, policy gate, and audit trail.
Cross-app data access requires a governed API or minimized event contract.