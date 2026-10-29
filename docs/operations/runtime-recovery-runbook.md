# Runtime recovery runbook

The service runtime exposes `/health`, `/live`, `/ready`, and `/metrics`.
Liveness only describes process health; readiness includes required dependency
checks. A readiness failure must not trigger a blind traffic increase.

## Recovery order

1. Check the gateway and monolith probes.
2. Check PostgreSQL, Redis/event bus, worker leases, and dead letters.
3. Correlate failures with `traceId`, `requestId`, and `correlationId`.
4. Pause the affected workflow or route family if retries could amplify load.
5. Restore the dependency or drain/restart the worker.
6. Re-run the relevant synthetic journey and record the result.

Retries must be bounded and idempotent. A dependency outage must never be
converted into a fabricated success or an unbounded retry loop.