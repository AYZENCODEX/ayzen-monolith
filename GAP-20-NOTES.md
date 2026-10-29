# VLT-GAP-20 A-B -- Performance / query regression (Hardening H3)

**Gates:** `pnpm capture:vault-perf` (20-A, reviewed, run only to re-baseline) and `pnpm validate:vault-perf` (20-B, blocking in `.github/workflows/ci.yml` and `ci/enforcement-pipeline.yml`, after GAP-19). Evidence: `reports/antas/vault/gap/VLT-GAP-20/baseline.json` (A) and `gate.json` (B). Config: `scripts/antas/vault/gap/gap-configs/vault-perf.json`. Engine: `perf-common.mjs` (profile + `judge`). Ledger re-sealed, GAP-13/14/16 ci-wiring evidence and the GAP-17 map regenerated.

## 20-A  capture
Runs the FROZEN pre-extraction routes and the CURRENT routes under the GAP-15 deterministic fakes, 8 route groups (entity/secret, local account, KYC, game/marketplace, security, backup/restore, snapshot/trash, share/attachment) x 4 scenarios (empty, 1 row, 2 rows, admin). 588 cells. Per cell: DB round trips, per-"op table" shapes, boundary calls, handler time (median of 7 reps, old/new interleaved). Proves the capture is real: 15-A freeze still verifies, no load errors, deterministic, every OLD route reached, non-vacuous, unmeasurable routes declared.

## 20-B  judge
V1 every OLD route served - V2 no cell with more DB statements - V3 no new/grown query shape - V4 no more boundary calls - V5 no N+1 introduced/worsened (statements for 2 rows vs 1 row) - V6 counts equal the 20-A capture (drift) - V7 handler p50/p95/p99/total within tolerance (re-measured up to 2x if ONLY timing fails) - V8 stale allowances rejected - V9 non-determinism. 10 judge self-checks (control + 9 planted regressions) each caught by the intended rule.

## Result
761 DB statements OLD = 761 current, same shapes, same boundary calls, no latency regression. 0 introduced N+1.
Pre-existing, unchanged by the extraction (backlog, not fixed here): `DELETE /vault/trash` and `POST /vault/health-check` issue 2 extra statements per extra row, identically in OLD and current.

## Limits
- In-memory fakes: no Postgres latency, plans, locks, indexes, payload size. Time = CPU/await cost of the code path.
- Only branches the canned rows reach are profiled. Checked by hand: an extra query planted on `GET /kyc-entries/:id` fails 20-B (V2/V3/V6); one planted in the `data_entity_id` re-read branch is NOT seen (rows carry no data_entity_id).
- `GET /vault/gas-overview` never answers under the fakes (declared, not measured). `db-throws` is not profiled (GAP-15-C covers it).
- 1 vs 2 rows only: fan-out that depends on large data volumes is not measured.
- Judge mutations are planted on profiles, not on source.
- Workflow: a reviewed change to a Vault query count -> `pnpm capture:vault-perf`, add an `intentional_changes` entry if the judge should accept it, `pnpm validate:vault-perf`, `pnpm seal:vault-evidence`. Open GAP-17/21 items are unchanged.
