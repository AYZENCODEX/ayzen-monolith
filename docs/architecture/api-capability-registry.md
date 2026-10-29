# API capability registry

The capability registry is the shared map between website/API behavior and
Telegram commands. It lives in `packages/capabilities/src/index.mjs` and is
exposed for internal inspection at `GET /internal/capabilities`.

Each capability declares:

- owning domain
- HTTP method and route
- status: `available`, `partial`, `missing`, `deprecated`, or `internal`
- required permission scope
- audit event

Bots must resolve a command through this registry before calling a domain API.
`available` capabilities may be called. `partial` and `missing` capabilities
must produce a technical-gap/remediation item instead of hidden business logic
inside a bot handler.

The registry describes the current compatibility monolith and extracted service
seams. It does not claim that a route has passed a data cutover. Gateway
routing remains reversible through the existing service URL migration gates.