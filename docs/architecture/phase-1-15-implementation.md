# AYZEN phases 1–15 implementation

Status: **implemented as a reversible hybrid-architecture foundation**.

This document maps the Advanced Hybrid Monolith roadmap phases 1–15 to the
code that now enforces the boundaries. The service packages are independently
runnable and gateway-addressable. The compatibility monolith remains the
fallback until a domain's data migration gate is approved.

| Phase | Implementation |
| --- | --- |
| 1 — Domain boundaries | `packages/domain-boundaries`, `artifacts/api-server/src/lib/architecture/domains.ts`, and `scripts/validate-domain-boundaries.mjs` define public operations, owned resources, event ownership, and forbidden private/database imports. |
| 2 — Platform contracts | `packages/contracts`, `packages/events`, `packages/errors`, `packages/config`, `packages/logger`, `packages/telemetry`, `packages/tracing`, `packages/auth-client`, and `packages/event-client` provide versioned API, auth, tenant, trace, idempotency, error, service, and event contracts. |
| 3 — Runtime context | `packages/tracing` propagates request, trace, correlation, and causation IDs; `packages/service-runtime` applies them to every service request and response. |
| 4 — Auth boundary | `packages/auth-client` validates RS256 JWTs with issuer/audience checks and cached `kid`-selected JWKS keys; `createConfiguredAuthenticator` lets every extracted service enforce the same boundary. |
| 5 — Data ownership | Domain-owned resource lists are published in `@ayzen/domain-boundaries`; service manifests expose ownership; financial, vault, mail, notification, and workflow handlers only mutate their own process-local stores. The monolith remains the compatibility data owner until cutover. |
| 6 — Reliable events | `packages/events` validates versioned envelopes and owners; the monolith keeps its durable transactional outbox; `packages/event-client` adds idempotent consumption, retention, replay, dead-letter capture, and HTTP event publication. |
| 7 — Internal APIs | Each extracted domain exposes public operations through its service entrypoint. Private persistence is not imported across service boundaries; the gateway never calls repositories. |
| 8 — API gateway | `apps/api-gateway` owns routing, request limits, CORS, timeouts, context propagation, metrics, and reversible monolith fallback. |
| 9 — Workers | `apps/worker` is a separate event/job runtime with queue intake, event validation, processing metrics, and dead-letter visibility. The monolith event dispatcher remains available during migration. |
| 10 — Identity | `services/identity` is an independently runnable compatibility adapter for login/session/OIDC/JWKS routes, with identity-owned resource metadata and a rollback switch through `IDENTITY_SERVICE_URL`. |
| 11 — Notification | `services/notification` owns notification creation/delivery metadata, tenant filtering, idempotency, audit records, and `notification.requested` events. |
| 12 — WISP Mail | `services/mail` owns mailbox message/thread metadata, delivery requests, tenant filtering, idempotency, audit records, and WISP/mail events. Mailbox storage remains distinct from notification delivery. |
| 13 — RYFT Finance | `services/finance` owns accounts and integer-cent transactions, checks tenant scope, uses idempotency keys, emits finance events, and records an immutable-style audit stream. |
| 14 — SYLO Vault | `services/vault` owns encrypted secret records and access audit. AES-256-GCM envelope records never place plaintext in logs or events; `SYLO_MASTER_KEY` enables stable key material and the route switch is reversible. |
| 15 — SKARN Workflow | `services/workflow` owns workflow definitions and executions, prevents cancellation of terminal executions, uses idempotency, emits lifecycle events, and exposes state for worker-driven continuation. |

## Operational contract

Every extracted service exposes:

- `/health`, `/live`, `/ready`
- `/metrics`
- `/internal/manifest`
- `/internal/health`
- structured request/audit logs
- request/trace/correlation response headers
- gateway fallback as the rollback path

The phase 1–15 validation command is:

```text
node scripts/validate-phase-1-15.mjs
```

This gate is intentionally independent of a live database. It validates the
architecture contracts and service entrypoints without pretending that the
compatibility monolith's data cutover has already happened.