# Marketplace characterization plan (MKT-01b, DB-backed suite)

Status: PLAN. Nothing in this file has been executed. MKT-01a (static pins) exists and runs; this part needs a real Postgres and
the real checkout (`pnpm install --frozen-lockfile`), which the sandbox that produced the roadmap does not have. Pattern to copy:
Finance's `test:finance-db` (`DATABASE_URL_TARGET=replit-test`, a runner that creates tables from the app's own DDL).

## Harness

1. Local Postgres, a throwaway database, tables created from `lib/schema-migrations.ts` (the Marketplace DDL, 26 tables) plus `users`, `credits`, `builtin_wallet_tokens`, `wallets`, `vault_entries` as the routes need them.
2. Start the Express app in-process (no network), obtain session cookies for fixtures: buyer, seller, second buyer, admin.
3. Every test runs the **current** route (unmodified code) over HTTP and asserts HTTP status, response keys (compare with `pins.json` `responses`) and database rows.
4. Money invariants checked after each money test: sum of AZN across `credits.azn_balance` + `marketplace_wallets.balance + locked_balance` before equals after plus platform fees; no negative balance except where a defect is being pinned; `locked_balance` returns to its starting value after settle or cancel.

## Flows (route -> assertions)

| Flow | Routes | Must assert |
|---|---|---|
| P2P buy -> admin approve -> confirm | `POST /marketplace/listings/:id/buy`, `PATCH /admin/marketplace/orders/:id`, buyer confirm | order row with `fee_pct`, escrow debit, seller credited `price - fee`, status sequence |
| P2P dispute -> refund / force-complete | `PATCH /admin/marketplace/orders/:id/resolve-dispute` | refund returns escrow; force-complete fee uses `order.fee_pct ?? 5` |
| Cart checkout, offer accept, bundle buy | cart, offers, bundles | same order columns as P2P for equal input; locks; rollback on insufficient balance |
| AZN / USDT / NFT buy | `/marketplace/{azn,usdt,nft}/buy` | fee 2.5 / 2.5 / 3, partial fill, wallet legs, `marketplace_transactions` row |
| Wallet deposit / withdraw | `/marketplace/wallet/:type/*` | guarded debit, transaction row, `UNIQUE(user_id, market_type)` |
| Spot place / match / cancel | `/spot/orders`, `/spot/orders/:id` | price-time order, partial fills, fee 0.1, locked amounts, cancel unlocks |
| Staking | `/spot/staking/*` | stake locks balance, unstake pays reward rule |
| Vault and game buy | `/marketplace/vault/buy`, `/marketplace/game/buy` | ownership transfer, wallet and transaction rows |
| Admin settings and market config | `/marketplace/settings`, `/admin/marketplace/market-configs` | stored values (needed for BC-1) |

## Defect-reproduction tests (they are expected to demonstrate, not to pass a fix)

| Issue | Test | Expected today |
|---|---|---|
| MKT-ISSUE-7 | two parallel `POST /marketplace/listings/:id/buy` by one buyer with balance for one | both succeed; `azn_balance` negative |
| MKT-ISSUE-7 | force the `UPDATE credits` to fail after the insert | order row exists without escrow |
| MKT-ISSUE-6 | two parallel `POST /marketplace/azn/buy` of the same sell listing | both succeed; seller `locked_balance` negative; listing amount from the last writer |
| MKT-ISSUE-6 | same for USDT | same |
| MKT-ISSUE-5 | two parallel NFT likes by different users | one like lost |
| MKT-ISSUE-1 | 100 anonymous `POST /marketplace/listings/:id/view` | `view_count` +100 |

When a defect test shows the defect, record it in the manifest as CONFIRMED and take the owner's decision on BC-4 / BC-5. When it does not reproduce, record that and keep the pin.

## Done when

The suite passes on the real checkout against unmodified code; each later phase names the tests that guard it; the defect tests have a recorded outcome.

## Status update (MKT-01b-1, 2026-10-24)

Written, not run. Files: `artifacts/api-server/src/marketplace/characterization/`. Run on the real checkout with
`pnpm --filter @workspace/api-server test:marketplace-db` (a test Postgres through `DATABASE_URL`; the runner creates and drops its own
schema, and refuses to run unless `DATABASE_URL_TARGET=replit-test`). Covered so far: P2P buy, approve, reject, dispute refund and
force-complete, guard rejections, the MKT-ISSUE-7 forced failure; the race and public-write tests for MKT-ISSUE-7, 6, 5 and 1; MKT-ISSUE-8.
01b-2a adds: wallet summary, deposit and withdraw (plus guarded races), USDT buy, NFT buy (plus status-guard race and MKT-ISSUE-9), cart checkout. Not covered yet (01b-2b): offers accept, bundles buy, spot, staking, AZN partial fill and cancel, vault and game. Authorization, notifications and the credit meter are stubbed. Send back the TAP output; the `t.diagnostic` lines report
whether each race reproduced.

First-run instructions and a troubleshooting table: `marketplace-db-suite-runbook.md`.
