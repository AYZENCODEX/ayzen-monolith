# ANTAS MKT - MARKETPLACE MODULARIZATION ROADMAP

Same goal as the Finance (FIN) and Projects (PRJ) extractions: real extraction, traceable OLD -> NEW, thin route adapters,
no scaffold-only modules. Marketplace starts from a harder position than either: **no tests, raw SQL in every handler,
`REAL` money columns, and shared money tables**. So this roadmap puts a safety net and a boundary gate before any move, and
puts the money-critical packages last, one at a time.

Companion files: `marketplace-audit.md` (findings F01-F14, risks MR-01..06), `marketplace-target-tree.md`,
`marketplace-route-owner-map.csv` (143 routes -> owner -> phase).

Basis: static inspection of `AYZEN-projects-PRJ07-codebase.zip` (no `.git`, SHA `UNAVAILABLE`). Nothing here is a PASS claim.

## Absolute rule

`TARGET DIRECTORY EXISTS` is not `MODULE EXTRACTED`.

```text
OLD HANDLER -> SYMBOL LIST -> CHARACTERIZATION TEST -> ACTUAL EXTRACTION -> NEW OWNER
-> ROUTE REWIRED (thin) -> OLD SQL GONE FROM ROUTE -> BOUNDARY SCAN -> PASS
```

No feature redesign. No schema change (D5). The 143 route paths, methods and response shapes are frozen. A move that needs a
behavior change is split into a separate, listed behavior change (BC-n) with its own test and owner sign-off.

## Decisions (recorded)

| # | Decision | Consequence |
|---|---|---|
| D1 | One fee-policy owner; hard-coded fee constants removed | MKT-03 builds `kernel/domain/fee-policy.ts`; defaults equal today's constants (5, 2.5, 3, 0.1), so behavior is unchanged until an admin saves a different fee. See BC-1. |
| D2 | Credits and token-wallet money go through ports | `credits-port`, `token-wallet-port` in `kernel/ports`; no route or use case writes `credits` or `builtin_wallet_tokens` directly. |
| D3 | Vault calls a Marketplace wallet contract | `marketplace/wallet/contract.ts`; Vault repositories stop writing `marketplace_wallets` / `marketplace_transactions` (MKT-04b). |
| D4 | Polymarket is a Marketplace sub-module | `marketplace/polymarket/`, phase MKT-12. |
| D5 | No schema change; DDL stays in `lib/schema-migrations.ts` | Table ownership lives in the boundary manifest. |

## Behavior changes (the only ones allowed)

| ID | Change | Phase | Gate |
|---|---|---|---|
| BC-1 | P2P order fee and `enabled` come from the fee policy. Resolution order: `marketplace_market_configs[market]` -> legacy `marketplace_settings` (P2P only) -> constant default. Today the P2P path ignores `marketplace_settings` (audit F03). | MKT-03 | Before enabling, query the saved `marketplace_settings` / `marketplace_market_configs` rows on the real database. If a non-default fee is stored, the owner decides whether it takes effect. |
| BC-2 | Error responses stop returning `e.message` (127 sites). | MKT-14, optional | Owner sign-off; frontend checks. Default: not done, messages preserved. |
| BC-3 | Rounding of REAL money in one place. | not planned | Needs a data decision; out of scope under D5. |
| BC-4 | Make AZN and USDT buy concurrency-safe: lock or guard the listing inside the transaction, guard the seller `locked_balance` debit (MKT-ISSUE-6). | MKT-09, only after 01b reproduces the race | Owner sign-off; tests change from "defect pinned" to "defect fixed". |
| BC-5 | Make P2P buy atomic: one transaction, guarded debit (MKT-ISSUE-7). | MKT-07, only after 01b reproduces the failure | Owner sign-off; same test change. |

## One generic validator, config-driven

Reuse the Projects pattern instead of one bespoke script per phase:

```text
scripts/antas/marketplace/boundaries.manifest.json   routes -> owner, tables -> owner, allowed edges, known external consumers, issues
scripts/antas/marketplace/validate-boundaries.mjs    static scan: route adapters have no pool/SQL, table writers are owners, edges are allowed, route list == 143
scripts/antas/marketplace/generate-inventory.mjs     writes docs/antas/marketplace/marketplace-inventory.md and reports/antas/marketplace/marketplace-migration-map.json
scripts/antas/marketplace/validate-boundaries.mjs --self-test   detector checks (a planted violation must fail)
```

Checks every phase must keep green: route count and (method, path) list equal the frozen 143; no `pool`/`client.query`/SQL string in
`routes/*` for migrated routes; table writes only from the owner sub-module; `domain` imports nothing outside `domain`;
no file outside `marketplace/wallet` writes `marketplace_wallets` / `marketplace_transactions` (after MKT-04b);
`lib/wallet-crypto.decryptPhrase` has exactly one caller (after MKT-12); every stale manifest entry fails the scan.

## Phase overview

| Phase | Goal | Routes | Risk | Size |
|---|---|---|---|---|
| MKT-00 | Inventory, frozen route list, baseline record | 143 frozen | low | S |
| MKT-01 | Characterization safety net: 01a static pins (DONE in code), 01b-1 and 01b-2a DB suites written, NOT RUN; 01b-2b not started | - | medium | L |
| MKT-02 | Boundary manifest, validator, CI wiring, per-route auth classification | - | low | M |
| MKT-03 | Kernel: tx helper, pool seam, money helper, fee policy (BC-1), ports | - | medium | M |
| MKT-04 | Wallet module and contract; Vault switched to the contract (04b) | 5 | high | M |
| MKT-05 | Low-risk reads and no-money features | 44 | low | L |
| MKT-06 | Catalog writes | 8 | medium | M |
| MKT-07 | Orders core (escrow, confirm, dispute, admin resolve) | 16 | highest of P2P | L |
| MKT-08 | Checkout: coupons, cart, offers, bundles | 28 | high | L |
| MKT-09 | Fixed-price markets: AZN, USDT, NFT | 15 | high | M |
| MKT-10 | Vault and Game market adapters | 10 | medium | S |
| MKT-11 | Spot trading and staking | 12 | highest | L |
| MKT-12 | Polymarket sub-module | 5 | high (real money, key material) | M |
| MKT-13 | External consumers rewired to contracts | - | medium | S |
| MKT-14 | Hardening and close-out | - | low | M |

Order is deliberate: tests and gate first (00-03), shared money contract next (04), then ascending money risk (05-09), then the two
engines (11, 12). Money-critical phases are never combined in one change.

## MKT-00 - Inventory and baseline

Sources: all `routes/marketplace*.ts`, `routes/polymarket.ts`, `lib/schema-migrations.ts` (Marketplace DDL), `routes/index.ts` registration order (the 19 routers).

**Status: DONE in code (2026-10-23). See `reports/antas/marketplace/mkt-00-evidence.json`.** Baseline typecheck/build: UNAVAILABLE in the sandbox, recorded as such in `mkt-00-baseline.json`.
Do: generate inventory and migration map; freeze the 143 (method, path) list with registration order (order matters for overlapping paths such as `/marketplace/listings/featured` vs `/marketplace/listings/:id`); record baseline typecheck/build result in the repo itself (not a scratch copy); list the DB columns each handler reads and writes.
Done when: inventory, map and frozen list exist and are generated by script; baseline result recorded with its honest status (the frozen install problem noted for Projects applies here too).

## MKT-01 - Characterization safety net

**Status: 01a DONE in code (2026-10-23); 01b NOT STARTED.** 01a is `scripts/antas/marketplace/characterization/` (`pnpm test:marketplace-static`, plain `node --test`, 23 tests, no install): it pins fee constants, percent and rounding expressions, status literals, ordered write statements, transaction and `FOR UPDATE` order, debit guards, response shapes and the REAL columns of the 143 routes, and names the money-safety facts (good: wallet, NFT, cart, offers, bundles, spot; defective: MKT-ISSUE-6 and MKT-ISSUE-7). Mutation-checked: a changed fee, a removed status guard and a lock-order change fail; a comment-only change does not. 01b needs a Postgres and the real checkout (see `marketplace-characterization-plan.md`); it cannot run in the sandbox that produced 01a, so nothing in this roadmap treats the money flows as characterized until 01b passes.

**01b-1 (2026-10-24): WRITTEN, NOT RUN.** `marketplace/characterization/`: runner (`pnpm --filter @workspace/api-server test:marketplace-db`, throwaway schema, `DATABASE_URL_TARGET=replit-test`), a resolve hook that swaps four modules for stubs (auth, PEP middleware, notification bus, credit meter), a harness mounting the REAL routers, and three test files: P2P order lifecycle (9 tests incl. MKT-ISSUE-7 forced failure), race and public-write defects (ISSUE-7, 6, 5, 1; outcomes reported through `t.diagnostic`), and MKT-ISSUE-8. Verified without a database: syntax, DDL column and NOT NULL check of every fixture statement (with negative controls), stub export coverage, the stub hook under a simulated loader. Not verified: everything that needs Postgres, `tsx`, `pg` and express. Authorization, notifications and the credit meter are stubbed, so this suite does not characterize them. **01b-2a (2026-10-25): WRITTEN, NOT RUN.** `wallet-and-markets.db.test.ts` (wallet summary, deposit, withdraw, guarded-race tests, USDT buy partial and full fill and rejections, the USDT MKT-ISSUE-6 race, NFT buy and its status-guard race, MKT-ISSUE-9) and `cart.db.test.ts` (checkout, rollbacks, 409 reasons, parallel checkout). 01b-2b (offers accept, bundles buy, spot, staking, vault/game, AZN listing create and cancel) waits for the first real run of 01b-1 and 01b-2a.

Why first: the audit found zero tests (F01).
Do:
1. Pure tests for arithmetic that is already inline: fee and net calculation per market, cart totals and rounding (`toFixed(4)`), coupon discount, offer counter rules, spot fee (`usdtAmt * FEE_PCT / 100`), staking math. Pin the current outputs, including float quirks.
2. DB-backed tests on a local Postgres (same approach as Finance's `test:finance-db`): create the Marketplace tables from `schema-migrations.ts`, seed users and credits, then call the **current route handlers** through HTTP and assert rows and balances: purchase -> confirm, purchase -> dispute -> admin refund / force-complete, cart checkout, offer accept, bundle buy, AZN/USDT/NFT buy, wallet deposit and withdraw, spot place/cancel/fill, stake/unstake, vault and game buy.
3. Money invariants as assertions on every money test: total AZN before == after (buyer, seller, platform fee), no negative balance, locked balance returns to zero after settle.
4. Response-shape snapshots for the routes the frontend uses most (listings, orders, wallet summary).
Done when: the suite passes against the unmodified code; each later phase names which tests guard it. Tests live in `marketplace/**/*.test.ts` (or the current location) and run in `test:marketplace-static` and `test:marketplace-db`.
Risk: this phase takes the longest; skipping it makes every later phase unverifiable. A path that cannot be characterized is listed in the risk register instead of being moved.

## MKT-02 - Boundary gate

**Status: DONE in code (2026-10-23). See `reports/antas/marketplace/mkt-02-evidence.json`, `docs/antas/marketplace/marketplace-boundaries.md`.** 143 routes classified; 7 read by a person (5 OK, 2 recorded issues); the 8 `in-handler-owner-sql` routes are heuristic and still need a person; CI wired. Marketplace and Polymarket were not changed.

Do: write the manifest and validator above; classify every one of the 143 routes as public, authenticated, owner-checked (PEP) or admin from the code (not from this audit's text parse); record the 17 apparent public routes and the 5 Polymarket inline-auth routes; wire `validate:marketplace-boundaries` and the static tests into CI (the Finance CI wiring is the template; add a Postgres service for the DB suite).
Done when: validator passes on the unmodified tree with every current violation listed as a known, owned issue; self-test passes; CI runs it.

## MKT-03 - Kernel

**Status: DONE in code (2026-10-23), unit-tested against fakes only. See `reports/antas/marketplace/mkt-03-evidence.json`.** Built: `marketplace/kernel/` (fee-policy, money, ports, pool, tx, market-config-repo, fee-settings-repo and four adapters). Route files now take their fee percentage from `DEFAULT_FEE_PCT` and compute fees through `feeByFraction`, `feeByProduct` and `feeRounded4` (bit-for-bit equal to the old inline expressions); `lib/market-config.ts` is a re-export. **BC-1 is implemented but not wired and not enabled** (`MARKETPLACE_FEE_FROM_CONFIG=1` is off by default and nothing calls it); its 11 wiring sites and the database check that must come first are listed in the evidence file. `withTransaction`, the ports and the adapters are not used by any handler yet. Nothing was run against a database, and the new TypeScript was not type-checked (no `tsc` in the sandbox): run `pnpm typecheck`, `pnpm --filter @workspace/api-server test:marketplace-kernel` and `pnpm test:marketplace-static` on the real checkout.

Sources: `lib/market-config.ts`, the fee constants in `marketplace.ts`, `-cart`, `-bundles`, `-offers`, `-azn`, `-usdt`, `-nft`, `-spot`.
Do: `kernel/infrastructure/{pool,tx}.ts` (withTransaction preserves the current BEGIN/COMMIT/ROLLBACK and release behavior); `kernel/domain/money.ts` reproducing today's arithmetic exactly; `kernel/domain/fee-policy.ts` (D1, BC-1); `kernel/ports/*` with adapters over `credits`, `builtin_wallet_tokens`, `lib/notification-bus`, the Vault ownership helpers; move `lib/market-config.ts` behind a re-export.
Done when: fee constants are gone from the route files; fee tests from MKT-01 still pass unchanged (defaults equal constants); the BC-1 database check is recorded.

## MKT-04 - Wallet module and contract (D2, D3)

Sources: `routes/marketplace-wallet.ts` (188 lines), the wallet and transaction writes in `vault/infrastructure/repositories/vault-market-repository.ts` and `game-repository.ts`.
Business behavior: deposit and withdraw per `market_type`; `UNIQUE(user_id, market_type)`; balance and locked balance; transaction rows with `market_type`, `listing_id`, `buyer_id`, `seller_id`, `amount`, `fee`, `net_amount`; `admin_credited` flag used by `services/admin-wallet`.
MKT-04a: move the wallet routes into `wallet/application`; create `MarketplaceWalletContract` (debit, credit, lock, unlock, record transaction).
MKT-04b: switch the Vault and Game repositories to the contract; differential test: the same operations produce identical `marketplace_wallets` and `marketplace_transactions` rows before and after.
Done when: only `marketplace/wallet/**` writes the two tables; `rg` shows no other writer (validator check).

## MKT-05 - Reads and no-money features (44 routes)

**Status: MKT-05 DONE in code (2026-10-25/28), 05a to 05g: 42 routes moved out of their route files (discovery 4, analytics 6, alerts 6, reviews 7, reports 5, and 14 out of `marketplace.ts`: settings 2, activity, stats, AZN chart, listing reads 4, search, history, favorites 3); the 2 routes of `marketplace-market-config.ts` already held no SQL. Evidence: `mkt-05a`..`mkt-05g-evidence.json`.** `marketplace.ts` is 948 lines (original 1,082) with 24 routes left: 8 for MKT-06, 16 for MKT-07. Nothing in MKT-05 was run against a database. For a file that is only partly moved, `moved-sql.pins.json` has per-route entries and the pin test checks that the moved routes no longer contain SQL; a moved route that still writes or is owner-bound keeps its class through `classOverrides`.

Sources and owners: discovery (4), search/history/stats/azn chart, analytics (6), alerts and saved searches (6), favorites, reviews (7), reports (5), settings, market-config (2), admin activity, listing GETs.
Do: one use case plus one repository per feature; routes become adapters; admin and user adapters split in `marketplace.ts` (F11).
Done when: these routes contain no SQL; MKT-01 shape snapshots pass.
Note: `GET /marketplace/settings` swallows errors and returns defaults; keep that behavior (BC-2 not applied).

## MKT-06 - Catalog writes (8 routes)

Listing create/update/delete, platform pricing, boost, feature, vault-items. Keep the PEP resource builders (`listingResource` and friends) in `catalog/security`. Ownership checks stay byte-for-byte in behavior.

## MKT-07 - Orders core (16 routes)

Sources: `marketplace.ts` buy, confirm, dispute, receipt, user order lists, admin order routes, `resolve-dispute` (refund / force-complete; the fee on force-complete uses `order.fee_pct ?? PLATFORM_FEE_PCT`).
Do: `orders/domain` state machine and fee/net split; one `purchase` use case that debits through the contract and inserts the order with `fee_pct`; admin routes become an admin adapter; notifications through `notifier-port`.
Guard: purchase -> confirm, dispute -> refund, dispute -> force-complete money invariants from MKT-01.
Done when: `marketplace.ts` no longer contains order SQL.

## MKT-08 - Checkout (28 routes)

Order of work: coupons (no money) -> cart (totals, validation, save for later) -> offers (accept) -> bundles. Cart checkout, offer accept and bundle buy each insert orders today; after this phase all four call `orders/application/purchase`. Merge only after the tests show the four paths write the same order columns for equal input; any difference is recorded as an existing quirk and kept (not silently fixed).

## MKT-09 - AZN, USDT, NFT markets (15 routes)

Per market: `domain` (price x quantity, fee), `application` (list, create, buy, cancel, stats), `infrastructure`. Keep AZN and USDT separate unless tests prove them equal. NFT keeps `nft_market_categories` ownership; `routes/nft-subscriptions.ts` rewired in MKT-13. The USDT leg uses `token-wallet-port`.

## MKT-10 - Vault and Game market adapters (10 routes)

Routes are already thin. Add `markets/{vault,game}/application/adapter.ts`, keep the listing logic in `vault/shared/marketplace/use-cases.ts`, make sure fee and enabled come from fee-policy and wallet effects from the contract (done in 03/04b). Mostly validator and test work.

## MKT-11 - Spot trading and staking (12 routes)

Highest risk: 4 transactions, 11 `FOR UPDATE`, AZN balances in `marketplace_wallets` and USDT in `builtin_wallet_tokens`, one pair (`AZN/USDT`), fee `0.1`.
Do: first split pure matching and fee math into `spot/trading/domain` with exhaustive tests; then `application` use cases (place, cancel, fill, candles, balances); then staking (stake, unstake). Keep every lock acquisition in the same order as today (lock order is behavior).
Done when: the spot DB suite (order book states, partial fills, cancel, insufficient balance, concurrent place) passes before and after.

## MKT-12 - Polymarket sub-module (D4)

Sources: `routes/polymarket.ts`, `services/polymarket-clob.ts`, `lib/db/src/schema/polymarket.ts`, the snapshot reads in `vault/application/snapshot/*`, `lib/wallet-crypto.ts` (caller side only).
PM-A (read side): `browse-markets`, `market-detail`, `list-trades`; move the CLOB client to `polymarket/infrastructure/clob-client.ts` with a re-export at the old path.
PM-B (key access): `security/request-user.ts` keeps the inline auth behavior in one place; `security/wallet-unlock.ts` becomes the only caller of `decryptPhrase`; it takes `(userId, walletId)`, checks the wallet belongs to the user, returns a signer for the call, never logs or stores it.
PM-C (trading): `domain/trade-rules` (price band, YES/NO, size, `REAL_MAX_TRADE_USDC`, `confirm: true`) as pure tests; `place-trade` use case; trade log written through `trades-repo` (Drizzle).
PM-D: `contract.ts` `listTradesForSnapshot(userId)`; the Vault snapshot reads trades through it.
Tests: pure rule tests and an adapter test with a fake CLOB client; no real order is ever placed in tests. Real-money paths are verified by the owner on staging with the existing cap.
Done when: `decryptPhrase` has one Marketplace caller; the route file has no Drizzle or crypto imports.
Security note: do not add logging around wallet unlock; do not widen the wallet lookup.

## MKT-13 - External consumers

Rewire `services/admin-wallet.ts`, `routes/search.ts`, `routes/nft-subscriptions.ts`, `lib/service-boundaries.ts`, `vault/infrastructure/repositories/snapshot-sections-repository.ts` to read models or contracts (or record an exemption in the manifest with a reason). The validator fails on any unrecorded consumer, so this phase ends the "stale entry or unknown writer" class of finding.

## MKT-14 - Hardening and close-out

Do: risk register and evidence index (same files as Finance: remaining scope, risk register, evidence index); regenerate inventory and migration map; decide BC-2; wire the DB suite into CI with a Postgres service; commit and bind provenance to a SHA; staging walk-through list for money flows.
Done when: every route is an adapter, the validator is green, the DB suite is green on the real checkout, and the register lists what is still open.

## Definition of "complete" (two separate statuses)

| Status | Meaning |
|---|---|
| Code-complete | All 143 routes are adapters; validator PASS; static and DB characterization tests PASS in the sandbox the work was done in. |
| Verified-complete | The same suite and `typecheck` / `build` are green on the real repository checkout, a commit SHA exists, migrations (none planned here) and staging flows are signed off by the owner. |

Never report Marketplace as complete without saying which of the two is meant.

## Open questions for the owner (not blocking MKT-00 to MKT-03)

1. BC-1: if a non-default `marketplace_settings.fee_pct` is already stored, should it start applying to P2P orders?
2. BC-2: stop returning `e.message` to clients?
3. Polymarket auth: keep the inline `requireUser` behavior, or move to the shared `requireAuth` middleware (behavior change, separate decision)?
4. Whether `lib/schema-migrations.ts` DDL should later move to versioned migrations (out of scope here).
