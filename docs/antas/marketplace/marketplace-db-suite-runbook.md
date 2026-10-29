# Marketplace DB suite: runbook for the first real run (MKT-01b)

Nothing in the DB suite has been executed yet. This page is for the person who runs it first.

## Prerequisites
- The real checkout, `pnpm install --frozen-lockfile` done.
- A **test** PostgreSQL reachable through `DATABASE_URL` (the runner connects with `buildPoolConfig()` from `@workspace/db`). It creates one schema named `marketplace_test_<time>_<random>`, creates the Marketplace tables from `lib/schema-migrations.ts` plus three stand-in tables (`users`, `credits`, `credit_transactions`) inside it, runs the tests with `search_path` pinned to that schema and drops it. It refuses to start unless `DATABASE_URL_TARGET=replit-test`, which the script sets. Do not point it at a database you cannot afford to touch: it only touches its own schema, but the check is yours to make.

## Run
```text
pnpm --filter @workspace/api-server test:marketplace-db 2>&1 | tee marketplace-db-run.txt
```
Expected shape: 32 tests in 5 files (cart 5, p2p-orders 9, race-defects 4, txn-hygiene 1, wallet-and-markets 13). A green run means the current code does what the tests say, defects included: several tests are named `DEFECT PINNED` and pass BECAUSE the defect exists today (MKT-ISSUE-5, 7, 8, 9). When a fix lands, those tests must be changed on purpose.

## What to send back
1. The whole `marketplace-db-run.txt`.
2. The `# MKT-ISSUE-…` lines (the `t.diagnostic` output of the race tests). They say `REPRODUCED` or `not reproduced in this run` for issues 7, 6 (azn and usdt) and 5. Run the race file two or three times if all say "not reproduced": a race is timing dependent.
3. `node --version` and the PostgreSQL version.

## If it does not start or fails early
| Symptom | Likely cause | What to do |
|---|---|---|
| `Marketplace database tests require DATABASE_URL_TARGET="replit-test"` | the script was bypassed | run through `pnpm ... test:marketplace-db` |
| `Marketplace test database setup failed: ... connect` | no DATABASE_URL, or the test database is not reachable | set it, retry |
| `test schema is missing tables: ...` | `MIGRATIONS` changed shape (a statement no longer matches the runner's three patterns) | send the message; the fix is in `kind()` of the runner |
| `relation "xyz" does not exist` inside a test | the routes touch a table or column the stand-ins or the Marketplace DDL do not provide | send the full error; the stand-in in `standins.mjs` needs that column |
| An error mentioning `identity-service`, JWT, `authorization_audit_log` or `users` columns when a router loads | the stub hook did not take effect: the REAL `middlewares/auth` was loaded | retry with `MKT_STUB_ORDER=first pnpm --filter @workspace/api-server test:marketplace-db`; if that also fails send both outputs |
| `ERR_MODULE_NOT_FOUND` for a `.ts` path | extensionless import resolution (tsx not active in the child process) | send the message |
| A single test fails with a different number or message than expected | either the code differs from the reading in the test, or the test is wrong | **do not change the route**; send the failure, the expected value in the test and the actual one |
| Tests in `race-defects` say `not reproduced` every time | the race window was too small on this machine | not a failure; say so when you send the output |

## After a green run
MKT-01b-2b (offers accept, bundles buy, spot, staking, AZN cancel, vault/game) and then MKT-04 (wallet module and contract). MKT-04 changes who writes `marketplace_wallets`, so it should not start before this suite has passed once on the real checkout.
