# VLT-GAP-14 B + C

B = fixed the 40 baseline violations (now 0 violations, 0 runtime cycles); C = CI wiring.

## B
- A3/A4 http+db: `vault/security/request-context.ts` (VaultRequest/VaultResponse aliases) for application; structural request types in domain/entity-links and infrastructure/backup/audit; row/insert types + AUTH_STEP_POLICIES exposed by infrastructure repositories; `NEW_VAULT_FIELDS` is a const tuple, schema check in `infrastructure/repositories/entity-field-contract.ts`; analytics lazy `valueHistoryTable` import moved into its repository.
- A2: `crypto/key-store-port.ts` + `infrastructure/crypto-key-stores.ts` (registered from src/index.ts and key-rotation-cron). infrastructure/index.ts no longer re-exports application.
- A5: SSE hub -> `lib/event-hub.ts`, `createNotification` -> `lib/create-notification.ts` (routes re-export). `vault/api/index.ts` no longer imports routes (now `export {}`).
- A6: barrels `application/{entity,snapshot,game}/index.ts` (narrow public surface).
- A8: `vault/shared/sharing/entity-types.ts`; routes/vault.ts uses lib/event-hub; lib/vault-pin-guard shim goes through vault/security/pin-guard.

## C
- package.json: `validate:vault-architecture:ci-wiring`.
- `.github/workflows/ci.yml` (job validation) and `ci/enforcement-pipeline.yml` (job blocking-gates) run scanner, self-test, ci-wiring as plain blocking steps.
- `validate-vlt-gap-14-C.mjs` (adapted from 13-C) fails on missing step, continue-on-error/if/`|| true`, path filters, split jobs, or build not needing the job. Verified: adding continue-on-error to a step makes it FAIL.

## Not verified
No node_modules: tsc / test suite not run. Older sealed validators (e.g. 05-D, 01-C) not re-run. 14-D (CI-fail proof) is next.
