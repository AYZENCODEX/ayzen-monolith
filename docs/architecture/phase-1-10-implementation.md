# AYZEN phases 1–10 implementation

| Phase | Evidence |
| --- | --- |
| 1 | Domain ownership and boundaries in `docs/architecture/domain-map.md` and `artifacts/api-server/src/lib/architecture/domains.ts`. |
| 2 | pnpm workspace, gateway/runtime packages, shared event and Telegram contracts, and service package layout. |
| 3 | Security boundary, RS256/JWKS/OIDC/session controls, service-request signatures, tenant policy, and safe error rules. |
| 4 | Identity/OIDC/session implementation remains owned by the monolith and is extraction-ready. |
| 5 | Personal/organization workspace and membership isolation remain server-side and are extraction-ready. |
| 6 | Central policy engine and policy audit controls are reused by HTTP, Telegram, and AI paths. |
| 7 | Public API gateway with request limits, timeouts, route metadata, and reversible monolith fallback. |
| 8 | Shared eight-bot registry, reusable Telegram contracts, and the thin `apps/telegram-gateway` transport boundary. |
| 9 | Webhook secret verification, update normalization, durable claim in the monolith handler, account linking, capability metadata, and explicit authorization context contract. |
| 10 | Versioned event envelope contract, registered event vocabulary, schema/ownership registry in the monolith, and durable outbox/dispatch implementation. |

The gateway and Telegram process do not contain domain SQL. Business behavior
remains in the compatibility monolith until the migration gates are complete.