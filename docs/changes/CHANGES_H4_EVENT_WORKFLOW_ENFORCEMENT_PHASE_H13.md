# AYZEN — Event & Workflow Enforcement Roadmap (Season 2, Track H), Phase H13: `workflow_schedules` scheduler

## Numbering note

Same caveat the wiring audit that spawned this phase already flagged:
`AYZEN_H4_Event_Workflow_Enforcement_Roadmap_Season2.md` was not present in
the snapshot this work was done against, so "H13" is this doc's own guess
at the next open slot, not a number pulled from the roadmap itself.
Whoever owns that roadmap should confirm or renumber.

## Scope, as inherited from the wiring audit

`AYZEN-event-workflow-notification-scheduler-policy-wiring-audit.md`, §4:
*"Scheduler — does not exist anywhere in the new services architecture."*
`services/workflow` had declared `workflow_schedules` in `ownedResources`
since before that audit, with no storage, no routes, and nothing anywhere
that ever fired a workflow on a cron/interval basis. The audit's own
recommendation was explicit about what closing this gap requires:
schedule storage, CRUD routes on `services/workflow`, and a cron-trigger
process — "most naturally a third responsibility on `apps/worker`
alongside its existing lag/stall monitors."

## What shipped in this phase

### 1. Schedule storage, CRUD, and internal firing routes — `services/workflow`

`services/workflow/src/schedules.mjs` (new) holds the pure record shape
and rules — `createSchedule`, `applyScheduleUpdate`, `isDue`,
`buildExecutionForSchedule`, `advanceSchedule` — kept separate from HTTP
plumbing the same way `./execution-event-handlers.mjs` already splits
that concern. `services/workflow/src/index.mjs` wires it in:

- `POST /api/workflows/:id/schedules` / `GET /api/workflows/:id/schedules`
  — create/list, gated by the same `enforceWorkflowOwner` check the
  workflow-definition routes already use (a schedule is "run this
  workflow automatically," so the same policy that restricts who may
  execute a workflow directly restricts who may make it execute itself)
- `GET /api/workflows/schedules/:id` / `PATCH .../:id` / `DELETE .../:id`
  — read/update/deactivate a single schedule, same ownership gate
- `GET /internal/workflows/schedules` / `POST /internal/workflows/schedules/:id/fire`
  — unregistered-by-registration, not by authentication: same convention
  as the existing `/internal/audit` route (`matchCapabilityRoute`'s
  "not_gated," never "denied," for an unlisted `/internal/*` path). These
  two exist only for the poller below to call.

Fire-time dedup reuses the existing shared-Postgres idempotency store
(H6.3), keyed on `schedule.id` + the exact due `nextRunAt` slot, so two
worker replicas racing to fire the same due schedule produce one
execution, not two — the same mechanism `POST .../executions` already
relies on for the identical reason.

`workflow_schedules` was already listed in `ownedResources`; nothing
there needed to change.

### 2. Cron parsing and next-occurrence arithmetic — `packages/workflow`

`schedules.mjs` needed one primitive that turned out not to exist
anywhere in the new architecture: standard 5-field cron parsing and "next
occurrence after this instant." (The legacy monolith has its own,
unrelated `artifacts/api-server/src/lib/scheduler/cron-parser.*` — per
the wiring audit, that whole legacy scheduler "has no relationship to the
extracted-services architecture at all," so this is a fresh, small
implementation rather than reaching into the monolith.)

New: `packages/workflow/src/cron.mjs`, exporting `parseCron` and
`nextRunAfter`, re-exported from `packages/workflow/src/index.mjs`.
Supports `*`, stepped wildcards, lists, ranges, stepped ranges, and
month/day-of-week names; day-of-month and day-of-week combine with OR
when both are restricted, matching cron(5)'s own convention; day 7 is
accepted as an alias for Sunday. All arithmetic is UTC, minute
resolution, and always strictly after the `from` instant — a schedule
computed at exactly its own matching instant is never immediately "due"
again for that same instant.

### 3. The poller that actually fires schedules — `apps/worker`

Routes existed after (1) but nothing called them. New:
`apps/worker/src/schedule-trigger.mjs` — polls
`GET /internal/workflows/schedules` every `SCHEDULE_POLL_MS` (default
30s, one poll immediately on boot), and calls
`POST .../schedules/:id/fire` for each active schedule returned, letting
that route's own `isDue()` check decide rather than duplicating due-window
arithmetic in the poller. Every call is a signed internal HTTP call via
`createServiceRequestHeaders`, the same pattern `./approval.mjs` and
`./index.mjs`'s `callInternalService` already use — the coarse capability
gate (H4) still requires a recognized service identity on every route,
`/internal/*` included; only fine-grained capability *registration* is
skipped for these two routes, not authentication.

Wired into `apps/worker/src/index.mjs` as a third periodic background
responsibility alongside the existing H11.2 lag/stall monitors — same
reasoning: the worker is already the one long-running process built for
this, and a fourth process for one poll loop would be needless
operational surface. Multiple worker replicas each run this poller
independently with no locking of their own; the idempotency store in (1)
is what makes that safe. Metrics (`polls`/`fired`/`errors`) are exposed
on the existing `GET /internal/worker/metrics` route under a `schedules`
key.

## Files changed in this phase

- `packages/workflow/src/cron.mjs` (new) — cron parsing / next-occurrence
- `packages/workflow/src/index.mjs` — re-exports `parseCron`/`nextRunAfter`
- `packages/workflow/test/cron.test.mjs` (new) — 10 tests
- `services/workflow/src/schedules.mjs` (new) — record shape and rules
- `services/workflow/src/schedules.test.mjs` (new) — 12 tests
- `services/workflow/src/index.mjs` — schedule storage, CRUD routes,
  internal fire route
- `apps/worker/src/schedule-trigger.mjs` (new) — the cron-trigger poller
- `apps/worker/src/schedule-trigger.test.mjs` (new) — 5 tests
- `apps/worker/src/index.mjs` — starts the poller, surfaces its metrics

## Verification

- `node --test` green on all three affected packages/services, including
  every pre-existing test file in each (`services/workflow`: 4 existing +
  12 new; `apps/worker`: 22 existing + 5 new; `packages/workflow`: 36
  existing + 10 new) — no regressions.
- `node scripts/validate-event-wiring.mjs` still passes against the
  existing 5-entry baseline (`scripts/event-wiring-baseline.json`)
  unchanged — this phase is a missing-resource/routing gap, not an
  event-wiring one, so it correctly doesn't touch that gate. The one new
  `publish()` call this phase adds (`workflow.started` from the `/fire`
  route) publishes an event type `services/workflow` already declares
  emitting and already publishes from its direct-execute route, so it
  introduces no new emitted-event finding.

## Not done, still open

- No admin UI for schedules — CRUD is API-only, same as the rest of
  `services/workflow` at this phase.
- No catch-up/backlog replay after worker downtime: a schedule missed
  while every worker replica was down resumes from the next real
  occurrence after the worker comes back, not a queued run for the
  missed slot. Documented as a deliberate choice in
  `schedules.mjs`'s `advanceSchedule` — a backlog-replaying scheduler is
  a real, different design.
- The wiring audit's other two open items (§5, the non-enforcing
  fine-grained policy gate; and the five baselined event findings in its
  §-table) are untouched by this phase and still need their own
  decisions.
