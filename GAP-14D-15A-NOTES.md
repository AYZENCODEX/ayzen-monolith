# VLT-GAP-14 D + VLT-GAP-15 A

## 14-D — architecture gate proven (counterpart of 13-D)
- `scripts/antas/vault/gap/validate-vlt-gap-14-D.mjs` → `reports/antas/vault/gap/VLT-GAP-14/gate.json`
- real scan regenerated fresh: 136 Vault files, 0 violations, 0 runtime cycles; scanner's file count must equal the .ts files on disk and every vault/ layer dir must be in the config
- 21 violations planted in COPIES OF THE REAL TREE (one line prepended/appended to real files); each must make the scanner exit non-zero AND report planted file:line:rule. Covers A0, A1 (cycle between two real entity files), A2 x2, A3 x2, A4 x7 (db value/type-only/dynamic, http x2, provider, frontend), A5 x3 (route x2, middleware), A6, A7 x2, A8. A type-only cycle must still pass; unmodified copy must pass.
- bypass flags/env, `--root` with no value, empty scope, empty Vault root, missing dir all fail closed; scanner self-test + 14-C wiring re-run
- scanner: added `--root <dir>` (scan a copy; never writes evidence for a copy)
- wiring: `validate:vault-architecture:gate` in package.json, `.github/workflows/ci.yml`, `ci/enforcement-pipeline.yml`; 14-C now also requires that step (4 steps per pipeline)
- negative-tested: neutering the A5 route rule made 14-D FAIL (A5a, A5b, scanner self-test); continue-on-error on the gate step made 14-C FAIL

## 15-A — freeze pre-extraction fixtures + census (detection only, like 13-A/14-A)
- `scripts/antas/vault/gap/validate-vlt-gap-15-A.mjs` (`--freeze` writes, plain run verifies), config `gap-configs/vault-equivalence.json`, explanations `gap-configs/vault-equivalence-explained.json`
- 9 groups / 31 frozen pre-extraction files (entity+secret, account, KYC, game/marketplace, security, backup, snapshot/trash, + share/attachment and health). Task map: 2,6→entity-secret; 3; 4; 5; 7; 8; 9.
- `reports/.../VLT-GAP-15/fixtures/contract-fixtures.json` (+ `.sha256` seal): routes, status codes, error messages/codes, events, audit actions, side-effect call counts per frozen file; 30 of 31 baseline copies re-verified against the sha256 their own gap recorded (the 31st, marketplace-vault.pre-extraction.ts, has no manifest hash — seal only)
- `equivalence-census.json`: old contract vs current code per group. Result: 0 unexplained contract differences, 0 side-effect call-count drops. 3 differences were reviewed and explained (marketplace 409 messages are now built from `${done.asset}`); an explanation only counts while its `requires` text still exists in the named current file. `createNotificationProvider` is counted as `createNotification` (port alias from 14-B).
- Coverage matrix (heuristic: does existing executable evidence mention the dimension at all) → **24 uncovered cells** left for 15-B..D, e.g. share/attachment has no old-vs-new replay at all; events/audit not signalled for account, KYC, game, security, backup, snapshot; health has no db/events/audit.
- A does NOT claim equivalence (`equivalence_proven: false`). Replay + comparison is 15-B..D.

## Not verified
No node_modules / DB: tsc and the test suite were not run (the scanners only needed `typescript`, borrowed from the global install for this run). Contract extraction is literal/text based — it proves no literal was lost, not that behaviour matches; that is what the replay (15-B+) is for.
