# Phase 0 — Architecture Baseline & Inventory: completion summary

Status: **complete**. This document maps every Phase 0 task, deliverable, and
Definition-of-Done item from `AYZEN_Advanced_Hybrid_Monolith_Roadmap.md` to
where it was satisfied, all grounded in a scan of the actual repository
(`artifacts/api-server`, `packages/*`, `services/*`, `migrations/*`) rather
than restated assumptions.

## Tasks

| Task | Where satisfied |
| --- | --- |
| Inventory all backend modules | `docs/architecture/domain-map.md` (15 domains, owner/dependency/data/API/event columns) |
| Inventory route modules | `docs/inventory/routes.md` + domain-map's API-surface column (150 route files scanned) |
| Inventory engines | `docs/inventory/engines.md` (Mega Engine, New Engines, Sub-Engines, ACIE, Scheduler) |
| Inventory database schemas | `docs/inventory/database.md` (178 tables, ownership coverage measured) |
| Inventory migrations | `docs/inventory/migrations.md` (104 files, grouped by domain) |
| Inventory event producers/consumers | `docs/inventory/event-flows.md` (concrete `publishEvent`/`subscribe` call sites, not just declared contracts) |
| Inventory scheduled jobs/workers | `docs/inventory/scheduled-jobs.md` (17 cron files + durable scheduler) |
| Inventory external integrations | `docs/inventory/integrations.md` |
| Identify direct cross-domain imports | `docs/architecture/boundary-findings.md` §1 (6 confirmed import sites) |
| Identify shared utility packages | `docs/architecture/boundary-findings.md` §3 (packaged vs. monolith-internal split) |
| Identify shared database access | `docs/architecture/boundary-findings.md` §2 + `docs/inventory/database.md` (253 files import `@workspace/db` directly; ownership enforced in 2 of 15 domains) |
| Identify modules that cannot currently be deployed independently | `docs/architecture/boundary-findings.md` §4 (every domain except the gateway) |

## Deliverables

| Deliverable | File |
| --- | --- |
| Domain map | `docs/architecture/domain-map.md` |
| Dependency graph | `docs/architecture/dependency-map.md` |
| Runtime graph | `docs/architecture/service-split.md` |
| Database ownership map | `docs/inventory/database.md` |
| Event-flow map | `docs/architecture/data-flow.md` + `docs/inventory/event-flows.md` |
| Extraction candidate list | `docs/architecture/extraction-candidates.md` |

## Definition of Done

> Every major backend domain has: owner, dependencies, data ownership, API
> surface, event surface, extraction difficulty, operational importance.

All 15 domains in `docs/architecture/domain-map.md`'s table carry all seven
fields, each backed by a specific source: the code-level `SERVICE_DESCRIPTORS`
/ `DOMAIN_SERVICE_CONTRACTS` / `OWNED_TABLES` registries plus a repository
scan (route/lib/migration/cron file counts and grep-confirmed import sites).

## Headline findings Phase 1+ should act on

1. **Ownership is declared for ~23% of the schema.** 178 tables exist; the
   `OWNED_TABLES` registry names an owner for roughly 40–45 of them. Phase 1
   should close this gap before treating the registry as a real boundary.
2. **Runtime enforcement covers 2 of 15 domains.** `assertTableOwnedBy()` is
   only called from `workspace-service.ts` and `telegram-gateway.ts`. The
   guard function exists everywhere; the call sites do not.
3. **`services/<domain>` packages are transport stubs, not extracted
   services**, for all 8 domains the registry marks `independent_process`
   (Finance, Vault, Mail, Notification, Workflow, AI, Marketplace, Search).
   None can currently deploy independently. Treat the roadmap's extraction
   order (Phase 11 onward) as starting from zero for business logic, not from
   a scaffolded head start.
4. **Vault and Finance are the highest-coupling, highest-churn domains** —
   confirmed direct cross-domain imports out of both, plus the largest
   migration/route/cron counts of any domain — and are ranked accordingly
   (Tier 3) in `extraction-candidates.md`, opposite the domain-map's own
   `extraction_ready`/`boundary-ready` labels, which describe the target
   registry's intent, not current coupling.
5. **Notification's "event surface" is currently synchronous direct calls**,
   not event-bus traffic — see `docs/inventory/event-flows.md` finding 3. This
   is a Phase 6/Phase 2 prerequisite for Notification's own extraction and
   for cleanly separating Mail's overlapping `notification.*` event names.
6. **Workflow is the dominant event producer today** (18 of 19 non-infra
   `publishEvent` sites), which changes the risk calculus for both Event Bus
   hardening (Phase 6) and Workflow's own extraction (Tier 3, #10) — whichever
   ships second inherits whatever load-handling gaps the first one has.

Phase 0 is a map, not a fix. None of the findings above block starting Phase
1 (Domain Boundary Enforcement); they are the concrete backlog Phase 1
should work from instead of proceeding on the target-state documents alone.
