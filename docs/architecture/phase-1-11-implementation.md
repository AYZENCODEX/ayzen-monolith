# AYZEN phases 1–11 implementation

Status: **foundation and shared Telegram platform implemented; provider
configuration and domain-specific backend readiness remain explicit gates**.

| Phase | Evidence |
| --- | --- |
| 1 — Repository boundaries | Workspace packages, service entrypoints, `scripts/validate-domain-boundaries.mjs`, and ADRs enforce public service seams and forbid private cross-domain imports. |
| 2 — Central identity | `packages/auth-client` validates the shared JWT/service boundary and now provides stable Telegram identity-link records. `services/identity` remains the reversible compatibility adapter. |
| 3 — Domain authorization | `packages/authorization` defines capability scopes, sensitive step-up rules, and Telegram command authorization. Resource ownership remains in the responsible domain. |
| 4 — Capability registry | `packages/capabilities` catalogs method, route, status, permission, and audit event. The gateway exposes it at `/internal/capabilities`. |
| 5 — Database ownership | `packages/domain-boundaries` and the API-server ownership registry declare table owners and fail closed on cross-domain ownership violations. |
| 6 — Data migration | `packages/migration` provides cutover states, required gates, checksums, reconciliation reports, journals, and reversible gateway fallback. |
| 7 — Runtime foundation | `packages/service-runtime` provides health/readiness/version manifests, request limits, auth, context propagation, rate limiting, and graceful shutdown. |
| 8 — API gateway | `apps/api-gateway` is the public edge with routing, limits, CORS/security headers, request context, timeouts, circuit fallback, and route metadata. |
| 9 — Event architecture | `packages/events` and `packages/event-client` provide versioned envelopes, ownership, idempotent delivery, retry, dead-letter, replay, and the transactional monolith outbox. |
| 10 — Product API completion | The capability registry distinguishes available versus partial operations; extracted service seams only expose domain-owned handlers and the monolith remains the fallback until gates pass. |
| 11 — Telegram gateway | `apps/telegram-gateway` verifies webhook secrets, normalizes updates, forwards only transport data, retries failed forwards, exposes failure receipts, deduplicates successful updates, tracks failures, and uses the common Telegram SDK. |

## Verification

```text
node scripts/validate-phase-1-11.mjs
```

This verifies the shared contracts and transport boundaries without pretending
that production credentials, domain data cutovers, or external Telegram
provider configuration are complete. Product bots use the expanded command
registry in `infrastructure/platform/telegram-command-registry.json`; commands
are translated to registered capabilities and dispatched to APIs/workflows by
the handler rather than implementing business rules in the transport.