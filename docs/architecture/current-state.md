# AYZEN current state

AYZEN is a modular monolith with a reversible gateway-led extraction path.
`artifacts/api-server` owns current business behavior and database access.
`apps/api-gateway` is the public HTTP boundary and falls back to the monolith
until a service URL is deliberately enabled.

The monolith already contains identity/OIDC, workspace and organization
membership, policy authorization, finance, vault, mailbox/mail delivery,
notifications, workflows, AI, marketplace, search, analytics, Telegram
webhooks, structured telemetry, and a durable event bus.

The independently runnable service packages are transport boundaries. A
package is not considered an extracted domain until its handlers, owned schema
adapter, authorization checks, contracts, migration gates, and rollback path
are complete.

See [`deep-audit-2026-09-22.md`](./deep-audit-2026-09-22.md) for a static
code-health audit (test coverage, file-size concentration, migration
integrity, and security-hygiene findings). Note its snapshot note — it
predates this copy's `packages/authorization`, `packages/capabilities`, and
related additions.