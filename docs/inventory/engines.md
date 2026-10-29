# Engine inventory

"Engines" are internal platform capabilities layered inside the monolith,
distinct from domain modules (Finance, Vault, etc.). They are shared
infrastructure that many domains call into, which makes them a different kind
of extraction risk: extracting a domain is a data/ownership problem, but
extracting (or even isolating) an engine is a fan-in problem — many domains
would need to switch to a client library at once.

| Engine | Location | File count | Purpose | Consumed by |
| --- | --- | --- | --- | --- |
| Mega Engine | `artifacts/api-server/src/lib/mega-engine` | 13 | Cross-cutting audit, lifecycle, retention, capacity, readiness and domain-event registration (`domain-events.ts` calls `registerAyzenDomainEvents()`, imported by `domain-service-contracts.ts`) | Every domain indirectly, via the event registry it seeds |
| New Engines | `artifacts/api-server/src/lib/new-engines` | 20 | Graph/time-series/provenance/lineage/digital-twin/decision/optimization/remediation primitives — a generic data-modeling toolkit | AI/ZYNTH, Workflow, Analytics |
| Sub-Engines | `artifacts/api-server/src/lib/sub-engines` | 17 | Platform utilities: AI gateway, blob storage, cache, feature flags, rate limiting, queue, permission graph, workflow designer, disaster recovery, event replay | Nearly all domains (this is the broadest fan-in of the three) |
| ACIE (Intelligence) | `artifacts/api-server/src/lib/acie` | 6 | Intelligence/analysis engine; the only engine with a direct event `subscribe()` call (`acie/index.ts`), consuming domain events to build derived insight | Intelligence Console (per the roadmap's target architecture); currently a monolith module |
| Scheduler | `artifacts/api-server/src/lib/scheduler` | 2 (`cron-parser.ts`, `worker.ts`/`job-store.ts` — see scheduled-jobs.md) | Cron parsing and durable scheduled-job dispatch, the largest single source of `publishEvent` calls in the repo | Workflow, Finance cron jobs, Vault cron jobs, Mail scheduling |

## Extraction implication

`sub-engines` is the highest-risk shared dependency for Phase 7+ (Modular
Monolith Internal APIs): it is imported broadly enough that it behaves like an
undeclared internal platform package rather than a domain module. Phase 2
(`packages/*`) should absorb the reusable pieces of `sub-engines` (cache,
feature-flags, rate-limit, queue) into real shared packages with their own
contracts, rather than leaving them as monolith-internal files that every
future extracted service would otherwise have to re-implement or reach back
into the monolith for.
