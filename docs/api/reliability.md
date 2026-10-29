# API reliability

The API layer uses bounded timeouts, retry policies, circuit breakers,
bulkheads, request limits, and explicit fallback rules. Mutating operations
must declare idempotency or be rejected by the owning service.