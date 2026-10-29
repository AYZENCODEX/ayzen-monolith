# ADR-002: Operational HTTP contract

Every independently deployed process exposes `/health`, `/live`, `/ready`, and
`/metrics`. Requests receive a bounded `x-request-id`; logs use structured JSON
and include service, method, path, status, and duration. Health endpoints do not
depend on business data, while readiness may report dependency failure.

The contract is intentionally transport-level. Domain-specific authorization
and data ownership remain in the service that owns the domain.