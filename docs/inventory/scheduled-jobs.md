# Scheduled jobs / workers inventory

17 files matched a cron/scheduler naming pattern under
`artifacts/api-server/src/lib`. All currently run in-process inside the
monolith — there is no separate worker deployment yet (Phase 9, Background
Worker Separation, has not happened).

| Job file | Domain | Trigger |
| --- | --- | --- |
| `airdrop-reminder-cron.ts` | Marketplace | cron |
| `dr-test-cron.ts` | Platform / disaster recovery | cron |
| `emergency-access-cron.ts` | Vault | cron |
| `finance-digest-cron.ts` | Finance | cron |
| `finance-invoice-reminder-cron.ts` | Finance | cron |
| `finance-late-fee-cron.ts` | Finance | cron |
| `finance-networth-cron.ts` | Finance | cron |
| `finance-recurring-cron.ts` | Finance | cron |
| `finance-reminder-cron.ts` | Finance | cron |
| `finance-report-schedule-cron.ts` | Finance | cron |
| `mail-schedule-cron.ts` | Mail | cron |
| `vault-backup-key-rotation-cron.ts` | Vault | cron |
| `vault-backup-schedule-cron.ts` | Vault | cron |
| `vault-health-cron.ts` | Vault | cron |
| `vault-snapshot-trash-cron.ts` | Vault | cron |
| `vault-trash-cron.ts` | Vault | cron |
| `scheduler/cron-parser.ts` + `scheduler/worker.ts` + `scheduler/job-store.ts` | Workflow (generic durable scheduler used by Workflow/SKARN) | durable job queue, not a fixed cron — this is the engine the domain-specific cron files above could eventually migrate onto |

Finance owns 6 of the 17 standalone cron jobs and Vault owns 5 — the same two
domains that dominate migration count and route-file count. This reinforces
the domain-map finding that Finance and Vault are the two heaviest domains to
extract (most schema, most routes, most background jobs, all coupled
together).

## Phase 0 relevance

Per Core Principle/Phase 9, background workers need to be separable from
request-serving processes before any domain is extracted as its own service.
Today every cron job above runs inside the same process as the HTTP API
(`artifacts/api-server`). None of them are candidates for "already
independently deployable" — they are flagged as **not currently deployable
independently** in `extraction-candidates.md`.
