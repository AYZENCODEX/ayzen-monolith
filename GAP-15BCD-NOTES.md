# GAP-15 B, C and D

Run in order: `pnpm validate:vault-equivalence:replay` (B), `:compare` (C), `:gate` (D). `:gate` regenerates A, B and C itself.

## Status
- 15-B PASS, 15-C PASS: 2230 old-vs-new cells equal (8 route groups x 16 scenarios, health module-level, trash-purge pairs, snapshot blob crypto with real node crypto + cross-decrypt both ways); 4/4 planted divergences detected.
- 15-D PASS: both residual dimensions are now covered by `differential-vlt-gap-15-backup.mjs` (121 cells, 14/14 planted mutants caught). `accepted_residual` stays empty.

## Closed in this round
1. backup-restore / side_effects -- `differential-vlt-gap-15-backup.mjs` runs the OLD frozen `lib/vault-backup-cloud` + `lib/vault-backup-alerts` and the NEW `vault/infrastructure/backup/{cloud,alerts}` unmocked, with a scripted `fetch` (every URL/method/header/body compared), a stateful connection table, a fake clock and recording email/telegram/notification sinks (including rejecting and synchronously-throwing sinks).
2. backup-restore / encrypted_values -- same script runs OLD `lib/vault-backup-envelope` vs NEW `vault/crypto/backup-envelope` with real node:crypto and real aes-gcm. The NEW side goes through the real key-store port + repository, so its SQL is executed against a stateful `encryption_keys` fake. Both-way cross-decrypt, ENV1/ENV2, AAD owner binding, legacy-KEK fallback, rotation, DB failures.
Run: `pnpm validate:vault-equivalence:backup`. Evidence: `reports/antas/vault/gap/VLT-GAP-15/module-differential-backup.json`. The residual text in the config no longer cites `validate-vlt-gap-07-D` (cannot run on this upload).

## Repaired older differentials (they had gone stale; now PASS again)
- differential-vlt-gap-11: `./entity` (now a directory index) mapped to the representation mock. 20 comparisons, 8/8 mutants caught.
- differential-vlt-gap-06-D: bare third-party imports reached via vault/ event code get an inert chain mock; node builtins are real. 25 scenarios, 0 diffs.
- differential-vlt-gap-09: snapshot-sections-repository mapped to the same sections mock the old side uses. 55 scenarios, 0 diffs.
06-D and 09 do not print a mutant count; I did not re-prove their sensitivity.

## Limits
Moved-module internals are the same fake on both sides in the route replay; 4 routes reach shallow paths only (allowed_shallow); stand-in values for AUTH_STEP_POLICIES / CLOUD_PROVIDERS / retention days; no-auth state not replayed. tsc and unit tests were not run (no node_modules here).
