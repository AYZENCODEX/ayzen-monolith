# Connector standard

Connectors are explicit transport adapters, not a bypass around application
boundaries. Each connector must declare its provider, audience, scopes,
tenant/resource scope, timeout, retry policy, and idempotency behavior.

Connector execution must go through the shared connector registry and return a
normalized result. Secrets are read from the deployment secret manager and
never placed in source, logs, event payloads, or release artifacts.

Every mutating connector call records an audit event and uses a stable
idempotency key. Retries are limited and safe to replay. A connector may call
another application only through the API gateway or governed event bus; direct
cross-application database access is not supported.