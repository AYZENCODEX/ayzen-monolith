# Event producer/consumer inventory

The event bus (`artifacts/api-server/src/lib/event-bus`) provides
`publishEvent()` (producers) and `subscribe(eventType, consumer, handler)`
(consumers), with outbox, idempotency, retry, and dead-letter support
(preserved strengths noted in the roadmap's Phase 6).

## Producers (call `publishEvent`)

| File | Domain |
| --- | --- |
| `lib/scheduler/worker.ts` | Workflow (durable scheduler — 8 call sites, the single largest producer) |
| `lib/workflow/run-store.ts` | Workflow (6 call sites) |
| `lib/scheduler/job-store.ts` | Workflow (4 call sites) |
| `lib/mega-engine/domain-events.ts` | Platform — `registerAyzenDomainEvents()`, the registration point every domain's declared events (per `domain-service-contracts.ts`) route through |

## Consumers (call `subscribe`)

| File | Domain |
| --- | --- |
| `lib/acie/index.ts` | ACIE / Intelligence — the only engine that actively consumes domain events today |
| `lib/workflow/triggers.ts` | Workflow |
| `lib/workflow/schedule-triggers.ts` | Workflow |
| `lib/sub-engines/integration.ts` | Sub-Engines platform layer |
| `lib/mega-engine/audit-integration.ts` | Mega Engine — audit trail |

## Declared event surface (from `DOMAIN_SERVICE_CONTRACTS`)

Every domain's intended event names are declared in
`lib/domain-service-contracts.ts` (`SERVICE_EVENTS`), independent of whether a
concrete `publishEvent`/`subscribe` call exists yet for that name:

- Identity: `oidc.login`, `oidc.session.created`, `oidc.session.revoked`, `oidc.logout`
- Workspace: `organization.member.invited/joined/role_changed/removed`
- Finance: `credits.consumed`, `credits.consumption_failed`
- Vault: `vault.share.created`, `vault.share.revoked`
- Workflow: `workflow.started/completed/failed/cancelled/timed_out`
- Mail **and** Notification both declare: `notification.requested/delivered/failed`
- AI: `ai.action.requested/completed/failed`
- Marketplace: `project.lifecycle.changed`
- Telegram Gateway: `telegram.notification.requested`
- Authorization, Search/Knowledge, Analytics, Event Bus itself: none declared

## Findings

1. **Concentration risk:** almost all concrete event production today comes
   from the Workflow/scheduler subsystem (18 of 19 non-infrastructure
   `publishEvent` call sites). Finance, Vault, Mail, Marketplace and AI have
   *declared* event names in the contract registry but few or no
   corresponding `publishEvent` call sites found in this scan — their event
   surfaces are largely aspirational/contract-only right now, not yet wired
   into the domain code that would raise them. Phase 6 should verify this
   gap per domain rather than assume "declared" means "implemented."
2. **Shared event names across domains:** Mail and Notification both declare
   `notification.requested/delivered/failed`. Confirm in Phase 2 (Internal
   Platform Contracts) which domain is the actual producer and which is the
   consumer for each of these three names — as written, the contract
   registry does not distinguish producer from consumer, only "this domain's
   event surface."
3. Only one engine (ACIE) and one platform layer (`sub-engines/integration.ts`,
   `mega-engine/audit-integration.ts`) consume events today, matching the
   roadmap's target diagram (events flow to ACIE / Notification / Workflow)
   only partially. **Confirmed:** Notification is not wired to the event bus
   at all — `lib/notification-bus.ts` is invoked as a direct synchronous
   function call from other domains, and it in turn directly imports
   `createNotification` from `../routes/notifications`, `sendToUser` from
   `lib/telegram`, and `sendNotificationEmail` from `lib/email`. This is a
   concrete cross-domain coupling (see `boundary-findings.md`) as well as an
   event-architecture gap: today's "notification fan-out" is a chain of
   direct calls across Notification, Telegram Gateway and Mail, not an event
   consumer, despite `notification.requested/delivered/failed` being declared
   as the event surface for both domains.
