# Projects modularization status (PRJ-00 to PRJ-05)

All 47 routes now run through `projects/{domain,application,security,infrastructure}`; the three route files are thin
adapters (projects.ts 1302 -> 377 lines, project-dates.ts 161 -> 84, project-templates.ts 282 -> 120) with no DB access.
`pnpm validate:projects-boundaries` (blocking in CI) pins the route surface, authorization wiring, cross-module
contracts, table access and layering. Evidence per phase is in `reports/antas/projects/prj-0N-evidence.json`.

| Phase | Status | Notes |
|---|---|---|
| PRJ-00 inventory and baseline | partial | `projects-inventory.md` and `reports/antas/projects/projects-migration-map.json` are now generated (`node scripts/antas/projects/generate-inventory.mjs`; 47 routes, 36 module files, 47 tests, 22 outside files touching Projects tables). Still missing: a real typecheck/build/test result in the repo itself; it exists only for a scratch copy installed with `--no-frozen-lockfile`, and the repo's frozen install still fails. |
| PRJ-01 boundaries and contract | done | D1 (Vault pinned import) and D2' (Projects owns its P&L) confirmed. |
| PRJ-02 dates | done | Cron now reads the dates repository. |
| PRJ-03 ratings, templates, core CRUD | done | ai-actions' project insert left as is (undecided). |
| PRJ-04 ROI / P&L | done, redefined | Projects keeps its own math; one isolated ledger read (D2'). Original plan (call Finance) found non-equivalent. |
| PRJ-05 enrollment, legacy retirement | done | teams.ts, bulk.ts enrollment writers and services/sync.ts kept separate by decision (PRJ-06). |
| PRJ-06 decisions and fixes | done | Route order, PRJ-ISSUE-1 and PRJ-ISSUE-3 fixed; the rest kept by decision. |
| PRJ-07 enrollment billing | done | Team and bulk enroll now charge credits like single enroll. |
| After PRJ-07 | done in code, unrun on a database | PRJ-ISSUE-2 fixed (`formatCreatedProject`); PRJ-00 inventory and migration map generated. |
| PRJ-08b team enroll | done in code, unrun on a database | `application/team-enrollment.ts` owns the team enrollment writes and billing (rules unchanged: existing row of any status is left alone; leader is charged per row created). `routes/teams.ts` keeps authn, the leader PDP decision, `team_members` reads, notifications (now sent after the enrollment loop), broadcast and activity log, and no longer writes Projects tables. Only `services/sync.ts` (deletes) and `ai-actions.ts` (project insert) remain outside the module as writers. |
| PRJ-08a bulk enroll | done in code, unrun on a database | PRJ-ISSUE-4 fixed: `application/bulk-enrollment.ts` plans with `domain/bulk-enroll-plan.ts` (skip active and banned, reactivate cancelled/disqualified, create the rest), checks and charges credits only for rows it writes. `routes/bulk.ts` no longer touches Projects tables. Response keeps `enrolled` (rows written) and adds `created`, `reactivated`, `skipped`. No schema change, so a concurrent identical request can still race. |

## Decisions taken in PRJ-06

1. Unreachable `GET /projects/mine/enrolled-entities`: fixed (route order).
2. Team and bulk enrollment paths: kept separate; made billable in PRJ-07.
3. `ai-actions` project creation: kept separate.
4. Receipt currency: kept raw sums with the `$` label.
5. PRJ-ISSUE-1 (unescaped `deadline`/`startedAt` SQL) and PRJ-ISSUE-3 (prototype-key status check): fixed.

## Still open

1. PRJ-ISSUE-2 is fixed in code (`POST /projects` builds its response from the typed insert row). Run `POST /projects` with `projectType` or `deadline` once on a real database to confirm 201.
2. Fix the frozen install and rerun the baseline in the repo itself.
3. PRJ-ISSUE-4 is fixed in code (see PRJ-08a). Optional: add a unique index on `project_enrollments (project_id, user_id, vault_entry_id)` after de-duplicating existing rows (schema change, needs a decision and a backup).
4. Billing assumptions now implemented as: leader pays for team enroll; same price as single enroll; bulk checks and charges only the rows it will write (not the requested count). Confirm.
5. Team page: show the out-of-credits message instead of the generic failure toast (frontend, optional).
