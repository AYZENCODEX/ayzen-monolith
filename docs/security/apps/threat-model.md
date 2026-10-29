# Per-app threat model

Assets include identities, sessions, business records, secrets, event payloads,
workflow state, and administrative controls. Trust boundaries exist between
clients, gateway, app APIs, services, databases, EventBus, workers, external
providers, Telegram, and Admin. Primary controls are default-deny policy,
tenant checks, service audience checks, safe URLs, redaction, idempotency,
outbox consistency, audit, and replay approval.