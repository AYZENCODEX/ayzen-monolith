# AYZEN phases 16–25 implementation

Status: **implemented as independently runnable, reversible service boundaries**.

| Phase | Evidence |
| --- | --- |
| 16 — AI / ZYNTH | `services/ai` owns task metadata, tool allowlists, step-up checks, provider timeouts, audit records, idempotency, and AI completion/failure events. |
| 17 — Intelligence / ACIE | `services/intelligence` stores event-derived observations and signals without owning transactional domain data or blocking domain writes. |
| 18 — Telegram Gateway | `apps/telegram-gateway` owns webhook-secret verification, bot identity, update normalization, duplicate update claims, and transport forwarding; domain authorization remains downstream. |
| 19 — Search / Knowledge / Analytics read models | `services/search` indexes and queries its own derived document store. It accepts source events/documents and does not read another domain's tables. |
| 20 — Service-to-service security | `@ayzen/auth-client` provides RS256/JWKS verification plus timestamped HMAC request signatures; the gateway signs internal calls when configured and services verify them. |
| 21 — Deployment topology | `infrastructure/deployment/topology.yaml` describes one-host multi-process deployment, service ports, route switches, shared-cluster ownership, and later independent scaling stages. |
| 22 — Observability | Gateway and service runtimes expose structured logs, request/trace/correlation IDs, latency counters, health/readiness, Prometheus metrics, route state, and alert rules. |
| 23 — Contract and integration testing | `scripts/validate-phase-16-25.mjs` validates syntax, contracts, event envelopes, replay behavior, boundary metadata, migration gates, and service entrypoints without requiring production credentials. |
| 24 — Strangler migration | Existing migration registry and gateway route matrix enforce monolith → dual-read → read-switched → write-switched → extracted progression with backup, characterization, backfill, validation, and rollback gates. |
| 25 — Reliability and failure isolation | Gateway extracted-route failure counters open a circuit, read traffic falls back to the monolith, writes fail closed, and `@ayzen/reliability` provides retries, circuit breakers, bulkheads, and resilient operations for workers/providers. |

## Safety rules

- AI provider failures never bypass policy or invent a successful result.
- ACIE consumes event envelopes and can only create derived intelligence records.
- Search results are tenant-filtered read-model data.
- Internal request signatures are bounded by timestamp skew and include a body
  hash; use durable nonce storage in the monolith for replay-sensitive routes.
- Gateway fallback is automatic only for safe reads. Mutations return an error
  after an extracted service failure to avoid duplicate side effects.
- Route switches remain environment-controlled and reversible.

Validation:

```text
node scripts/validate-phase-16-25.mjs
```