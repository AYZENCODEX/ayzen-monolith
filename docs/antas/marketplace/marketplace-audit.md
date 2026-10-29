# Marketplace audit (pre-extraction)

Status: AUDIT (documentation only). Static inspection of the uploaded archive `AYZEN-projects-PRJ07-codebase.zip`
(repo tree `AYZEN4X1-finance-fin02czip`, no `.git`, so commit SHA is `UNAVAILABLE`). Nothing was executed against a
database, nothing was built, no source was changed. Every number below is a static count; "verify" marks a reading that
still needs a run. Companion files: `marketplace-target-tree.md`, `ANTAS_MKT_ROADMAP.md`,
`marketplace-route-owner-map.csv`.

Decisions recorded from the owner (applied throughout):

| # | Decision |
|---|---|
| D1 | Fee policy gets one owner; hard-coded fee constants are removed. Behavior is preserved until an admin changes a fee (see F03). |
| D2 | Credits and wallet money moves go through a contract (ports), not direct SQL on `credits`, `builtin_wallet_tokens` or `marketplace_wallets`. |
| D3 | Vault calls a Marketplace wallet contract instead of writing `marketplace_wallets` / `marketplace_transactions` itself. |
| D4 | Polymarket is a **sub-module of Marketplace** (`marketplace/polymarket/`). |
| D5 | No schema change. Marketplace DDL stays in the startup array in `lib/schema-migrations.ts` for now. |

## 1. Scope inventory

| Item | Count |
|---|---|
| Route files (`routes/marketplace*.ts`) | 18 files, 138 routes, about 3,800 lines |
| Polymarket route file (`routes/polymarket.ts`) | 1 file, 5 routes, 210 lines |
| Total routes in scope | 143 (full list with proposed owners: `marketplace-route-owner-map.csv`; frozen surface `reports/antas/marketplace/marketplace-frozen-routes.json`) |
| Largest file | `marketplace.ts`: 1,082 lines, 38 routes (user, admin and order logic mixed) |
| Raw SQL calls in routes | 199 `pool.query` and 154 `client.query` (353) |
| Hand-written transactions (`BEGIN` statements) | 16 (spot 4, marketplace 3, wallet 2, one each in azn, bundles, cart, nft, offers, reports, usdt); every one has COMMIT, ROLLBACK and `release()` in a `finally` (MKT-01a) |
| `FOR UPDATE` locks | 21 (spot 11, bundles 3, cart 2, offers 2, marketplace 2, reports 1) |
| Tests that cover Marketplace | **0** |
| `any` usages in Marketplace routes | 172 (incl. Polymarket) |
| `e.message` sent or used in error paths | 127 sites in 16 files |
| Marketplace tables (DDL in `lib/schema-migrations.ts`) | 27 (26 Marketplace plus `polymarket_trades`, the only one with a Drizzle schema); 42 `REAL` (float32) columns among them |
| Frontend | 12 user pages, 3 admin pages, 37 files mention marketplace; URL paths must stay frozen |

Route files by size and risk (routes / lines / raw SQL / transactions):

| File | Routes | Lines | pool.query | client.query | BEGIN | Money moves |
|---|---|---|---|---|---|---|
| marketplace.ts | 38 | 1082 | 59 | 27 | 3 | escrow, fees, disputes, refunds |
| marketplace-spot.ts | 12 | 492 | 17 | 42 | 4 | order book, fills, staking |
| marketplace-cart.ts | 9 | 269 | 13 | 11 | 1 | checkout |
| marketplace-azn.ts | 5 | 230 | 15 | 10 | 1 | AZN market buy |
| marketplace-offers.ts | 8 | 220 | 11 | 11 | 1 | accept creates order |
| marketplace-usdt.ts | 5 | 213 | 13 | 10 | 1 | USDT market buy |
| marketplace-wallet.ts | 5 | 188 | 9 | 13 | 2 | deposit, withdraw |
| marketplace-reviews.ts | 7 | 168 | 11 | 0 | 0 | none |
| marketplace-nft.ts | 5 | 166 | 11 | 10 | 1 | NFT buy |
| marketplace-bundles.ts | 5 | 150 | 7 | 13 | 1 | bundle buy |
| marketplace-coupons.ts | 6 | 118 | 9 | 0 | 0 | none |
| marketplace-alerts.ts | 6 | 107 | 7 | 0 | 0 | none |
| marketplace-analytics.ts | 6 | 105 | 6 | 0 | 0 | none |
| marketplace-reports.ts | 5 | 102 | 5 | 7 | 1 | none |
| marketplace-discovery.ts | 4 | 65 | 5 | 0 | 0 | none |
| marketplace-game.ts | 5 | 47 | 0 | 0 | 0 | already thin (Vault use case) |
| marketplace-vault.ts | 5 | 46 | 0 | 0 | 0 | already thin (Vault use case) |
| marketplace-market-config.ts | 2 | 46 | 0 | 0 | 0 | none |
| polymarket.ts | 5 | 210 | 0 | 0 | 0 | real on-chain USDC (Drizzle, not pool) |

## 2. Findings

Severity is about extraction risk, not a security rating. "Verify" means the reading comes from code, not from a run.

**F01 (high) No tests.** (Update after MKT-01a and MKT-03: 26 static pins and 20 kernel unit tests exist, but no handler has been executed by any test.) There is no Marketplace test of any kind. Finance and Projects were moved behind characterization
tests; here the safety net has to be built first (MKT-01) or every later move is blind.

**F02 (high) Business logic, SQL and HTTP are in the same handler.** 353 raw SQL calls and 16 transactions sit directly in
route files. There are no repositories, no use cases and no domain functions to reuse.

**F03 (high) Fee logic is duplicated and partly dead.** Constants found: `PLATFORM_FEE_PCT = 5` in `marketplace.ts`,
`marketplace-cart.ts`, `marketplace-bundles.ts` and `marketplace-offers.ts`; `FEE_PCT = 2.5` in `marketplace-azn.ts` and
`marketplace-usdt.ts`; `3` in `marketplace-nft.ts`; `0.1` in `marketplace-spot.ts`. An admin fee surface exists in two places:
`marketplace_market_configs` (by design only `vault` and `game`, read by the Vault use case through `lib/market-config.ts`) and
`marketplace_settings`. In the code, `marketplace_settings` is read only by `GET /marketplace/settings` and written by
`PATCH /marketplace/settings`; the P2P order path (`POST /marketplace/listings/:id/buy`, cart, offers, bundles) uses the constant 5. So the
P2P fee and `enabled` that an admin saves look write-only as far as order creation is concerned (verify). Correction to an
earlier chat remark: AZN, NFT and USDT never had an admin fee surface by design, so they are duplication, not a bypass.

**F04 (high) Money is stored as `REAL` (32-bit float).** `price_azn`, `fee_pct`, `fee_azn`, `seller_receives`, `balance` and
`locked_balance` are `REAL`, and handlers compute `price * feePct / 100` in JavaScript with inconsistent rounding (only the cart
rounds, with `toFixed(4)`). No schema change is allowed by D5, so the extraction must first record the current arithmetic in tests
and only then centralize it in `kernel/domain/money.ts`. Any rounding fix is a separate, explicit behavior change.

**F05 (high) Direct writes to shared money tables.** Routes read or write `credits` (about 17 references), `marketplace_wallets`
(about 36) and `builtin_wallet_tokens` (about 11, owned by the wallet feature). `services/credit-meter` is used in two files only.
There is no single ledger contract (D2).

**F06 (high) Vault writes Marketplace tables.** `vault/infrastructure/repositories/vault-market-repository.ts` and
`game-repository.ts` insert and update `marketplace_wallets` and `marketplace_transactions` for `market_type` `vault` and `game`.
`marketplace-vault.ts` and `marketplace-game.ts` are thin adapters over `vault/shared/marketplace/use-cases.ts` (197 lines), and
Marketplace routes import `vault/security/market-listing-ownership` and `game-ownership` (D3).

**F07 (medium) Other code touches Marketplace tables.** `services/admin-wallet.ts` (updates `marketplace_transactions.admin_credited`,
reads `marketplace_fee`), `routes/search.ts` (reads `marketplace_listings`), `vault/infrastructure/repositories/snapshot-sections-repository.ts` (reads `polymarket_trades`),
`routes/nft-subscriptions.ts` (writes `marketplace_activity_log` and `nft_market_categories`), `lib/service-boundaries.ts` (names
`marketplace_listings` / `marketplace_orders`), `lib/market-config.ts`. The MKT-00 scan found 8 such files (`marketplace-inventory.md`); an earlier remark that `services/sync.ts` touches the tables was wrong, it only carries action names with the text `marketplace_listings`. Each needs a contract or a recorded exemption (MKT-13).

**F08 (medium) DDL lives in a startup array, no Drizzle schema.** The 26 Marketplace tables are created by
`CREATE TABLE IF NOT EXISTS` in `lib/schema-migrations.ts`, not in `lib/db/src/schema`. This stays (D5); table ownership is
recorded in the manifest instead.

**F09 (medium) Authorization is uneven (verify per route).** The MKT-00 scan finds 26 of 143 routes behind an ownership gate (`requireOwnership` factories), 101 authenticated, 20 admin, 17 public and 5 inline-auth. The
rest rely on `requireAuth` plus in-handler checks. The 17 public routes (no `requireAuth`) look intentional (discovery, listing reads, seller ratings, view counters, stats, bundles list); the 5 Polymarket routes authenticate inline. MKT-02 must classify every route, not infer.

**F09b (update, MKT-02) Access review.** 143 routes: 26 owner-gated, 61 authenticated, 8 authenticated with an ownership predicate in the handler SQL (heuristic), 20 admin, 16 public reads, 1 public write, 5 Polymarket routes whose first statement is the inline `requireUser` call (verified). 7 routes were read by a person: `favorite`, two `report` routes and the Vault/Game cancel routes are fine; `POST /marketplace/listings/:id/view` is a public counter (MKT-ISSUE-1); `POST /marketplace/nft/listings/:id/like` has a lost-update race (MKT-ISSUE-5). Details: `marketplace-boundaries.md`.

**F15 (high) AZN and USDT buy are not concurrency-safe (MKT-ISSUE-6, code reading, not reproduced).** `POST /marketplace/azn/buy` and `/usdt/buy` read the listing with `pool.query` before `BEGIN`, take no row lock, update the listing by `id` only (no `status='active'` or remaining-amount guard) and decrease the seller's `locked_balance` with no guard. The buyer-side debit is guarded (`balance >= $1`). NFT buy has a `status='active'` guard with a 409; cart checkout, offer accept and bundle buy use `FOR UPDATE` inside a transaction.

**F16 (high) P2P buy is not atomic (MKT-ISSUE-7, code reading, not reproduced).** `POST /marketplace/listings/:id/buy` checks the buyer's `credits.azn_balance` with a read, inserts the order, then runs `UPDATE credits SET azn_balance = azn_balance - $1` as a separate statement with no transaction and no balance predicate.

**F17 (medium) One transactional handler leaks an open transaction (MKT-ISSUE-8).** A path-by-path scan of all 16 transactional handlers (MKT-01b) found one early `return` between `BEGIN` and `COMMIT` with no `ROLLBACK`: `PATCH /admin/marketplace/orders/:id` answering 404 for an unknown order. The pooled connection goes back idle in transaction. An earlier statement in this audit and in the MKT-01a evidence that every `BEGIN` has a `ROLLBACK` was a per-handler count and is corrected here.

**F18 (high) NFT sale can credit nobody (MKT-ISSUE-9, code reading).** `POST /marketplace/nft/buy` credits the seller with an `UPDATE marketplace_wallets` whose row count is never checked, and minting an NFT listing does not create the seller's `nft` wallet row (only the buyer's wallet is ensured). A seller without that row is paid nothing while the buyer is debited and the NFT is marked sold. AZN and USDT sellers always have a wallet row (they lock funds to list), and the P2P path upserts `credits`.

**F10 (medium) Error hygiene.** 127 `e.message` sites in 16 files, and some `catch` blocks return a default body instead of an
error (for example `GET /marketplace/settings`). Example: `PATCH /admin/marketplace/orders/:id/resolve-dispute` returns
`e.message` on a 500. Preserve first; changing responses is a listed behavior change (BC-2 in the roadmap).

**F11 (medium) User, admin and order logic mixed in `marketplace.ts`.** 11 admin routes sit among user routes; extraction has to
split admin adapters from user adapters without changing paths.

**F12 (high) Polymarket has a different shape and real money.** `routes/polymarket.ts` uses Drizzle (`db`, `walletsTable`,
`polymarketTradesTable`) while the rest uses `pool`; authenticates with an inline `requireUser` (token from `getTokenFromReq`) rather than
the `requireAuth` middleware; decrypts the user's wallet phrase just in time with `lib/wallet-crypto.decryptPhrase`; places real
orders through `services/polymarket-clob.ts` (cap `REAL_MAX_TRADE_USDC`, `confirm: true` required, `sensitiveWriteLimiter`). It is
referenced by Vault snapshot code (`vault/application/snapshot/*` carries `polymarketTrades`; `snapshot-sections-repository.ts` reads the table), `lib/api-scopes.ts` and
`lib/wallet-crypto.ts`. The frontend already nests it under the marketplace hub (`config/marketplace.ts`,
`marketplace-polymarket.tsx`), which supports D4. Its 5 routes parse as "public" only because auth is inline: verify each.

**F13 (low) `services/marketplace`** is a 107-line transport shim; the gateway stays on the monolith. Not a dependency, not touched.

**F14 (low) Ownership config exists.** `config/antas/domain-ownership.json` already lists a `marketplace` domain (api, migration
and event owner `marketplace`); the target tree below is consistent with it.

## 3. Cross-module edges (current)

```text
Marketplace routes --> credits (UPDATE credits.azn_balance)            [no contract]  -> D2
Marketplace routes --> builtin_wallet_tokens (USDT leg of spot, usdt)   [no contract]  -> D2
Marketplace routes --> services/credit-meter (2 files)
Marketplace routes --> lib/notification-bus (notifyVerveOrderResolved) , lib/policy/* (PEP)
Marketplace routes --> vault/security/{market-listing-ownership,game-ownership}
Vault repositories --> marketplace_wallets, marketplace_transactions    [direct SQL]   -> D3
services/admin-wallet --> marketplace_transactions
services/sync, routes/search, routes/nft-subscriptions, lib/service-boundaries --> Marketplace tables
Polymarket --> wallets (Drizzle), lib/wallet-crypto, services/polymarket-clob, vault snapshot (reads trades)
```

## 4. Risks that survive extraction

| ID | Risk | Mitigation in the roadmap |
|---|---|---|
| MR-01 | No concurrency guard beyond `FOR UPDATE` in some paths; `REAL` money | Characterization tests first; money helper records current arithmetic |
| MR-02 | Fee policy change alters behavior if an admin already saved `marketplace_settings.fee_pct` | Resolution order keeps old defaults; report the DB values before enabling (BC-1) |
| MR-03 | Contract move for Vault changes who writes `marketplace_wallets` | Differential test old vs new SQL effects before switching Vault |
| MR-04 | Spot engine (order matching, 11 locks) is the hardest code to move | Last of the money phases (MKT-11), own characterization suite |
| MR-05 | Polymarket decrypts wallet keys | Wallet-unlock stays one function behind one port; no logging; no key material in domain |
| MR-06 | Frontend depends on exact paths and response shapes | Frozen route list (143) and response-shape snapshots |

## 5. What was not checked

No typecheck or build was run on this tree; no database was available; the `route-owner` map is by path and file, not by a proven
call graph; PEP coverage and public routes are classified from text, not from running requests.
