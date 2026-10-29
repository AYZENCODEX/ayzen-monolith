# AYZEN Enforcement Roadmap — Track G (OIDC Enforcement), Phases G1–G2

**Roadmap:** `AYZEN_EventBus_Workflow_Enforcement_Roadmap.md`, Track G (Phases 27–29).

## Phase G1 — Wire the OIDC verification scripts into a real suite

**Starting state:** `scripts/src/run-verification-suite.mjs` already existed and was
already wired into `security.yml` (`pnpm --filter @workspace/scripts check:verification`),
but:
- Its glob (`/^test-(oidc|policy)-.+\.ts$/`) silently excluded the 5
  `test-sylo-oidc-*.ts` files (client-side login/cutover suites) — a
  regression in any of them would not fail CI.
- Every one of the 41 OIDC test scripts used a homegrown `function test(name, fn)`
  harness (try/catch + `console.log`) rather than `node:test` — functional as a
  CI gate via exit code, but not a "`node --test`-discoverable suite" as the
  roadmap specifies.

**What changed:**
1. Converted all 39 unit-test files (`test-oidc-*.ts` + `test-sylo-oidc-*.ts`,
   excluding the 2 orchestrator scripts below) from their custom harness to
   real `node:test`: removed each file's `function test(...)`/`async function
   test(...)` block and added `import { test } from "node:test";`. Node's
   `test()` has a compatible `(name, fn)` signature (sync or async), so this
   was a mechanical, behavior-preserving swap — verified by `esbuild`-parsing
   every converted file afterward (all pass, only pre-existing unrelated
   warnings).
2. Left `test-oidc-post-cutover-verification.ts` and
   `test-sylo-oidc-cutover-checklist.ts` unconverted — these are composite
   scripts that `spawnSync` the other test files as subprocesses and
   aggregate exit codes; they are not unit-test harnesses themselves.
3. Fixed `run-verification-suite.mjs`'s glob to
   `/^test-(oidc|sylo-oidc|policy)-.+\.ts$/`, closing the sylo-oidc gap — all
   41 OIDC scripts are now covered (was 36).
4. Added `oidc:test-suite` to `scripts/package.json`
   (`node --test --import tsx ./src/test-oidc-*.ts ./src/test-sylo-oidc-*.ts`)
   — a literal `node --test`-driven entry point per the roadmap's stated
   deliverable — and wired it into `.github/workflows/security.yml` as its
   own step, alongside (not replacing) the existing `check:verification` step,
   which still also covers the unrelated `test-policy-*.ts` suite.

**Known gap not touched:** the individual `oidc:test-*` scripts in
`scripts/package.json` (e.g. `oidc:test-clients`) still point at the
now-converted files in their original `scripts/src/` location — left in
place deliberately since the files weren't relocated (several sylo-oidc
files span multiple packages, e.g. `artifacts/ayzen/src/lib/oidc-client.ts`
*and* `artifacts/api-server/src/lib/...`, and one — `test-sylo-oidc-cutover-checklist.ts` —
shells out to another script — so a uniform "move beside the one file it
tests" relocation the roadmap suggests as one option wasn't a clean fit for
every file). Not moved to `artifacts/api-server/src/lib/__tests__/oidc/`.
Not run and confirmed green against a live `pnpm install` in this session —
no network-resolvable workspace install was performed here (23M source-only
checkout, no `node_modules`); the conversion was verified structurally
(no leftover harness functions, no duplicate/misplaced imports, balanced
braces, clean `esbuild` parse for every file) but not executed end-to-end.

## Phase G2 — Enforce `validate-hybrid-identity-1-15.mjs` in CI

**Starting state:** `validate-hybrid-identity-1-15.mjs` was *already* a step
in `security.yml`'s `dependency-and-source` job, running on every
`pull_request`. That part of G2 was already done before this phase.

**Actual gap:** nothing in the repo declared that job as a *required* status
check, so a red run didn't block a merge by itself — the roadmap's own gate
("PR that regresses a hybrid-identity phase requirement fails to merge")
wasn't actually true yet.

**What changed:** added `.github/settings.yml` (Probot Settings App
format) declaring branch protection on `main`:
- Required status checks: `AYZEN security gates / dependency-and-source`
  (carries both G1's OIDC suite and G2's identity validator) and
  `AYZEN CI / validate`.
- Required code-owner review, `enforce_admins: true`, no force-push/deletion.

**Known gap:** this file only takes effect if the Settings app (or an
equivalent settings-sync mechanism) is actually installed on the repo, or
someone applies it via the GitHub API/UI — nothing in-repo can itself flip
GitHub's branch-protection state. Flagging this the same way earlier
phases flag DB-only/live-environment gaps: written, not independently
confirmed live.

## Files touched
- `scripts/src/test-oidc-*.ts` (36 files) — harness → `node:test`
- `scripts/src/test-sylo-oidc-*.ts` (3 of 5 files) — harness → `node:test`
- `scripts/src/run-verification-suite.mjs` — glob widened
- `scripts/package.json` — new `oidc:test-suite` script
- `.github/workflows/security.yml` — new step calling `oidc:test-suite`
- `.github/settings.yml` (new) — branch protection as code
