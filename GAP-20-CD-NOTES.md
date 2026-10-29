# VLT-GAP-20 C-D -- Performance gate: CI enforcement + proof the gate fails (Hardening H3)

**Gates:** `pnpm validate:vault-perf:ci-wiring` (20-C) and `pnpm validate:vault-perf:gate` (20-D), blocking in `.github/workflows/ci.yml` and `ci/enforcement-pipeline.yml` right after `pnpm validate:vault-perf` (20-B), all after GAP-19 and before GAP-18's tamper gate. Evidence: `reports/antas/vault/gap/VLT-GAP-20/ci-wiring.json` (C) and `ci-gate.json` (D). Pins: `scripts/antas/vault/gap/gap-configs/vault-perf-gate.json` (read only by C/D, so editing it does not invalidate the 20-A capture).

## 20-C  CI wiring (`validate-vlt-gap-20-C.mjs`)
package.json scripts are exactly the expected commands; each workflow runs judge -> ci-wiring -> gate as plain `- run:` steps, in that order, after the GAP-19 chaos step, in ONE job; no `continue-on-error` / `if` / `|| true` / `set +e`, no `paths` filter, triggers on `pull_request`; `build` still `needs` the job. Also: the 20-A **capture is never run in CI** (neither workflow nor any other package script may call it: a pipeline that re-baselines itself would make the drift check meaningless).

## 20-D  gate proof (`validate-vlt-gap-20-D.mjs`)
1. Real 20-B on the real tree, fresh `gate.json`: PASS, 588 cells, 0 regressions, statements OLD == current, judge self-checks 10/10.
2. Scope: 8 route groups pinned; every group captured and non-vacuous; cell count == the 20-A capture; every `routes/(vault|kyc|local-account|game|marketplace-game)*` file is in a group or a documented exclusion; timing tolerances (p50/p95/p99/total factors + slack + retries), `reps >= 5`, the 1-row/2-row scenario pair, `intentional_changes == 0` and `allowed_unmeasurable <= 1` are PINNED, so loosening means editing this gate too.
3. 12 regressions planted in **copies of the real source/config/capture** (temp tree, real 20-B run as a child, fresh `gate.json` each time); each must exit non-zero AND report the intended rule:
   - Q1 duplicate select (V2) - Q2 per-row re-read, N+1 (V2 + V5) - Q3 double `chargeCredits` (V4) - Q4 extra decrypt (V4) - Q5 route path changed (V1) - Q6 40 ms spin (V7) - Q7 a charge call removed: an "improvement" must not pass silently (V6) - Q8/Q9 extra select in a second and third group (V2)
   - G1 tolerances raised without re-capture (capture-stale) - G2 `baseline.json` hand-edited to match a planted query (V6, caught because the hand edit does not match reality) - G3 `baseline.json` deleted (fails closed)
   Negative controls that must still pass: unmodified copy; a behaviour-preserving edit (comment + dead local).
4. `--force`, `--skip-validation`, `VALIDATION_DISABLED=true`, `VAULT_BYPASS=1` against the real judge: non-zero exit, "bypass" message, `gate.json` untouched.
5. 20-C passes.

## Real defect found by 20-D, fixed
**20-A/B did not count money, authorization or activity calls.** `metricsOf` counted boundary calls only for labels `call:*` / `autostub:*`, but the fakes record `chargeCredits`, `authorize`, `authorizeMany`, `logSubjectActivity`, `syncOnVaultDelete`, `delistVaultMarketplaceListings` under their bare names. Plants Q3 (double charge) and Q7 (charge removed) were therefore invisible to V4/V6 even though the 20-B header said V4 covered "encrypt/audit/event/charge". `perf-common.mjs` now counts them (and `db.selectDistinct` as a statement; unused by Vault code today). Reviewed re-baseline: `pnpm capture:vault-perf` re-run. Effect: 84 cells' call counts changed, total boundary calls 390 -> 439 on BOTH sides, DB statements unchanged, 0 cells where current > OLD, 20-B still PASS. i.e. the extraction did not change any charge/authorize/activity call; the gate just could not see them before.

## Open tasks closed in the follow-up pass
- **Unreached `data_entity_id` branch:** new perf-only scenario `row-db-linked` (rows carry `data_entity_id`), defined in `perf-common.mjs` (GAP-15 replay untouched), run for `kyc`, `entity-secret`, `snapshot-trash` via `scenario_groups`. POST/PUT `/kyc-entries` now show 1 -> 2 statements there. 20-D plant L1 (extra query in that branch, previously invisible) is caught.
- **`routes/vault-migration.ts` was never profiled:** it has no frozen pre-extraction original (224 -> 48 lines in GAP-13), so it is a **current-only** group `migration` (pinned in `vault-perf.json` and `vault-perf-gate.json`; a route with a frozen original cannot be moved there). Perf-only scenario `row-db-import` (valid 2-entry import body) makes `POST /vault/import` execute (2 inserts) instead of failing with 400. Only drift (V6) and vanished cells protect it; OLD-vs-current parity cannot be proven. Plants M1 (extra select in export), M2 (double insert in import), M3 (route dropped) are caught.
- **General hardening:** judge now flags any captured cell that is no longer profiled (a route removed from both sides previously vanished silently).
- Capture is now 663 cells over 9 groups; 20-D: 16/16 plants, 2/2 controls, 4 bypass rejections; GAP-18 re-sealed (8/8 tampers caught).

## Still open (cannot be closed from inside the harness)
- vault-migration: current-only, no OLD parity. `GET /vault/gas-overview` never answers under the fakes (declared, identical both sides). `db-throws` scenario not profiled. Latency is in-memory code-path cost, not Postgres (needs a real-DB benchmark run outside this harness). Pre-existing per-row loops (`DELETE /vault/trash`, `POST /vault/health-check`) are a performance backlog, unchanged by the extraction.

## Also changed
`package.json` (+2 scripts), both CI files (+2 steps), `validate-vlt-gap-18.mjs` (20-C added to the regen set), `perf-common.mjs` + `baseline.json` (above). Evidence regenerated: GAP-13/14/16 ci-wiring (workflow hashes changed), GAP-17 map, ledger re-sealed.
