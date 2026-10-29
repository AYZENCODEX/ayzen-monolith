# VLT-GAP-13 C–D — what changed

C (CI enforcement): the route-thinness scan is now a blocking step in both pipelines.
- package.json: validate:vault-routes, :self-test, :ci-wiring, :gate
- .github/workflows/ci.yml (validation job, build `needs` it) and ci/enforcement-pipeline.yml run all four
- scripts/antas/vault/gap/validate-vlt-gap-13-C.mjs: fails if a step is missing, has continue-on-error / if / `|| true`,
  the job is skippable, a paths filter exists, steps are split across jobs, or `build` no longer waits on the gate job.

D (prove CI fails): scripts/antas/vault/gap/validate-vlt-gap-13-D.mjs -> reports/.../VLT-GAP-13/gate.json
- real scan of the real tree (fresh route-thinness.json): 16 files, 144 handlers, 0 violations
- scope check: every vault* route on disk/mounted is scanned, else it needs a documented exclusion
- 11 violations planted in COPIES of real route files (R1,R2,R2b,R3,R4,R4b,R5,R6,R7,R8,R9); each must make the
  scanner exit non-zero AND report the planted file:line:rule. Unmodified copy must pass.
- bypass flags/env (--force, --skip, VALIDATION_DISABLED, ANTAS_BYPASS…) and empty/missing scope fail closed
- also runs scanner --self-test and the 13-C validator

Validators were themselves negative-tested (continue-on-error, removed step, `|| true`, neutered scanner,
db import in vault-shares.ts, new unscanned vault route): each made the right validator fail.

OPEN ITEM from C–D is now closed by E (below): marketplace-vault.ts was extracted and the scanner scope widened.
