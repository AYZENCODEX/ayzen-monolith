# Staging runbook

## Smoke test

```bash
curl --fail "$GATEWAY_URL/health"
curl --fail "$GATEWAY_URL/ready"
curl --fail "$GATEWAY_URL/internal/routes"
```

Verify that an unconfigured extracted route reports `x-ayzen-route-mode:
monolith` and still reaches the compatibility server. Verify that configured
routes return `extracted` only after the service's migration checklist is
approved.

## Failure tests

- Stop Redis and confirm readiness reports the dependency as unavailable.
- Stop the configured service and confirm gateway requests fail with a safe
  502/504 response, without exposing upstream stack traces.
- Deliver the same event or idempotency key twice and confirm one business
  operation.
- Terminate a worker during an outbox lease and confirm stale-lock recovery.

Record timestamps, route mode, request ID, correlation ID, and rollback action
for each test. Never paste secrets or token contents into the incident record.