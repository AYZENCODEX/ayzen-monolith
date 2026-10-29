# VLT-GAP-16 C–D — what changed

C (CI enforcement): the duplicate/legacy scan is a blocking step in both pipelines.
- package.json: validate:vault-duplicates, :self-test, :ci-wiring, :gate
- .github/workflows/ci.yml (validation job, build `needs` it) and ci/enforcement-pipeline.yml run all four
- scripts/antas/vault/gap/validate-vlt-gap-16-C.mjs (-> reports/.../VLT-GAP-16/ci-wiring.json): fails if a step is missing, has
  continue-on-error / if / `|| true`, the job is skippable, a paths filter exists, steps are split across jobs, or `build` stops waiting.

D (prove CI fails): scripts/antas/vault/gap/validate-vlt-gap-16-D.mjs -> reports/.../VLT-GAP-16/gate.json
- real scan of the real tree, fresh duplicate-scan.json: 666 files, all totals 0
- scope: scanner file count == files on disk; every vault/ file and every Vault-owned route in scope; thresholds
  (<=1 statement / <=60 chars) and allowlist sizes (1 shim, 3 primitives) pinned so loosening requires editing the gate
- 13 violations planted in COPIES of the real src tree (D1 x3, L2 x2, L1 x2, C1 x2, S1 x4); each must make the scanner exit
  non-zero AND report the planted file:line:rule. 2 negative controls must still pass (near-duplicate with a different literal;
  aliased import from the approved lib/password owner). Unmodified copy passes.
- bypass flags/env, `--root` without a value, empty scope, scope without vault/, missing dir fail closed
- also runs scanner --self-test (14 cases) and the 16-C validator

Scanner changes made for C-D: `--root` needs a value; empty / vault-less scope fails closed; aliased imports from the approved
security owner are honoured (found while designing the gate).

Validators were negative-tested: continue-on-error, removed step, `|| true`, scan script replaced (each failed 16-C);
D1 rule neutered, S1 check disabled, threshold loosened (each failed 16-D). Removing only the first empty-scope guard is an
equivalent mutant (the vault/ guard also fails closed); removing both made 16-D fail.

Documented scope exclusion: routes/marketplace.ts and the non-Vault marketplace-* routes. Known, out of scope: marketplace.ts
GET /marketplace/vault-items (read-only listing on vault_entries/local_accounts, no duplicate anywhere) and routes/search.ts,
sync.ts, projects.ts, two-factor.ts + services/sync.ts, which also read vault_entries directly.
