# Tenant isolation

Every tenant-scoped read and write resolves ownership from authenticated
identity and workspace context. Client-supplied tenant identifiers are input
to an authorization check, never proof of access.

Cross-tenant requests must return the route's documented denial/not-found
behavior, produce no side effect, and leave an auditable decision. Admin
operations have a separate privileged boundary and are covered by the tenant
and admin regression suites.