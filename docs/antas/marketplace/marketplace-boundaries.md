# Marketplace boundaries (MKT-02)

Status: ENFORCED BY SCRIPT on the unmodified tree. Basis: static scan, no `.git` (SHA `UNAVAILABLE`), no database, no build.
Authored rules, decisions and known issues: `scripts/antas/marketplace/boundaries.manifest.json`. Gate:
`node scripts/antas/marketplace/validate-boundaries.mjs` (`pnpm validate:marketplace-boundaries`), self-test with `--self-test`.

## What the gate does

1. Runs the MKT-00 inventory and requires the 143-route surface to equal the frozen list (path, method, file, access class).
2. Requires the tree to equal the recorded **baseline** (exact match, both ways): SQL calls per route file, table writes per route file,
   writers of `marketplace_wallets` / `marketplace_transactions`, writes to `credits` / `builtin_wallet_tokens` / `wallets`,
   outside files touching Marketplace tables, `decryptPhrase` calls in scope, route access classes, routes needing human review.
   A new violation fails. A migration that removes violations also fails until `--baseline` is re-run in the same change, so the
   diff shows the numbers going down and nothing stays stale.
3. Requires every outside file touching Marketplace tables to have a decision (`REWIRE`, `MOVE`, `EXEMPT`) and a resolving phase.
4. Requires every route needing a person to read it (`needs-review`, `public-write`, `inline-auth-unverified`) to have a recorded verdict in `routeReviews`.
5. Requires every Marketplace table to have exactly one owner sub-module in `tableOwners`.
6. Once `artifacts/api-server/src/marketplace/` exists (MKT-03), checks layering: `domain` has no DB/HTTP/fs/fetch/env and no upward imports, `application` has no express or raw SQL, routes never import `marketplace/**/infrastructure`.

PASS means "equal to the recorded baseline". It does not mean the violations are fixed: they are recorded, each with an owner and a phase.

## Recorded violations (baseline today)

| Class | Count | Resolved in |
|---|---|---|
| SQL calls in route files (`pool.query` + `client.query` + Drizzle `db.*`) | 358 in 19 files | MKT-05..MKT-12 |
| Writers of `marketplace_wallets` / `marketplace_transactions` | 8 files | MKT-04 (routes), MKT-04b (Vault), MKT-13 (`admin-wallet`) |
| Marketplace files writing `credits` / `builtin_wallet_tokens` | 6 files | MKT-03 ports, then each phase |
| Outside files touching Marketplace tables | 8 | MKT-03, 04b, 12, 13 (one exempt) |
| `decryptPhrase` calls in Marketplace scope | 2 (both in `routes/polymarket.ts`) | MKT-12 |
| Tests covering Marketplace | 0 | MKT-01 |

## Route access classes (143 routes, parsed from declarations and handler text)

| Class | Routes | Meaning |
|---|---|---|
| `admin` | 20 |  |
| `authenticated` | 61 |  |
| `in-handler-owner-sql` | 8 | authenticated, mutating, has an :id param, no PEP gate, but the handler SQL constrains by user_id/seller_id/buyer_id/owner_id = $n (heuristic, confirm in MKT-02 review) |
| `inline-auth-verified` | 5 | Polymarket route whose first statement calls requireUser(req, res) |
| `needs-review` | 6 | authenticated, mutating, has an :id param, no PEP gate and no ownership predicate found in the handler: a person must read the handler |
| `owner-gated` | 26 | route passes through a requireOwnership factory |
| `public-read` | 16 |  |
| `public-write` | 1 | no authentication and the handler writes (INSERT/UPDATE/DELETE): confirm it is intentional and rate limited |

Plain `authenticated`, `admin`, `public-read` and `owner-gated` carry the obvious meaning. `in-handler-owner-sql` is a heuristic match
(the handler SQL constrains by `user_id`, `seller_id`, `buyer_id` or `owner_id = $n`): 8 routes, still to be confirmed by a person.

## Human review result (7 routes read in MKT-02)

| Route | Verdict | Note |
|---|---|---|
| `POST /marketplace/listings/:id/favorite marketplace.ts` | OK | inserts a favorite row for the caller (user_id from the session) on any existing listing; no cross-user effect |
| `POST /marketplace/listings/:id/report marketplace-reports.ts` | OK | inserts a report row with reporter_id = caller; reporting someone else's listing is the purpose |
| `POST /marketplace/sellers/:id/report marketplace-reports.ts` | OK | same shape as the listing report |
| `POST /marketplace/nft/listings/:id/like marketplace-nft.ts` | ISSUE (MKT-ISSUE-5) | no ownership needed (any user may like), but it reads liked_by, edits the JSON array in JavaScript and writes it back without a lock or transaction, so two concurrent likes can lose one |
| `DELETE /marketplace/vault/listings/:id marketplace-vault.ts` | OK | ownership is delegated: canCancelVaultListing(req, id, listing.seller_id) (seller or admin) in vault/security/market-listing-ownership |
| `DELETE /marketplace/game/listings/:id marketplace-game.ts` | OK | ownership is delegated: canCancelGameListing(req, id, listing.seller_id) (seller or admin) in vault/security/game-ownership |
| `POST /marketplace/listings/:id/view marketplace-analytics.ts` | ISSUE (MKT-ISSUE-1) | public, unauthenticated UPDATE of view_count; no rate limit visible in the file |

## Known issues recorded (not changed)

- **MKT-ISSUE-1** (medium): POST /marketplace/listings/:id/view is public and increments marketplace_listings.view_count with no authentication and no visible rate limit; the counter can be inflated by anyone. Status: OPEN (recorded, not changed: behavior change needs owner decision). Phase: MKT-05.
- **MKT-ISSUE-2** (high): P2P order creation uses the constant 5 and ignores marketplace_settings.fee_pct and enabled (audit F03). Status: OPEN, fixed by BC-1 in MKT-03. Phase: MKT-03.
- **MKT-ISSUE-3** (medium): Authenticated mutating :id routes without a PEP gate. MKT-02 review result: 8 have an ownership predicate in the handler SQL (in-handler-owner-sql), 6 were read by a person (see routeReviews): 5 are fine (self-scoped insert or delegated Vault ownership check), 1 has a race (MKT-ISSUE-5). The 8 SQL-predicate routes are heuristic matches and keep MKT-02 review status. Status: REVIEWED for the 6 needs-review routes; the 8 heuristic routes remain to be confirmed. Phase: MKT-02 review.
- **MKT-ISSUE-4** (medium): Polymarket decrypts the wallet phrase in two places in one file (balance and trade); wallet-crypto has other callers outside Marketplace (routes/wallets.ts, vault snapshot payload). Status: OPEN. Phase: MKT-12.
- **MKT-ISSUE-5** (low): POST /marketplace/nft/listings/:id/like does a read-modify-write of nft_market_listings.liked_by (JSON array) with no lock, so concurrent likes can be lost; a non-numeric :id is passed as a parameter and surfaces as a 500 with e.message. Status: OPEN (recorded, not changed). Phase: MKT-09.

- **MKT-ISSUE-6** (high): AZN and USDT market buy (POST /marketplace/azn/buy, /marketplace/usdt/buy): the listing is read with pool.query outside the transaction, no row lock is taken, the listing is updated by id only (no status or remaining-amount guard) and the seller's locked_balance is decreased without a guard. Two concurrent buys of the same listing can both pass; the seller wallet can be credited twice from one escrow and locked_balance can go negative. Read from code, not reproduced. The buyer-side debit is guarded (balance >= $1). NFT buy, cart checkout, offer accept and bundle buy are not affected (status guard or FOR UPDATE). Status: OPEN, pinned by `pnpm test:marketplace-static`. Phase: MKT-09 (BC-4).
- **MKT-ISSUE-7** (high): P2P buy (POST /marketplace/listings/:id/buy): the buyer balance is checked with a read, then the order is inserted and credits.azn_balance is decreased by two separate pool.query calls with no transaction and no balance predicate. A failure between the two leaves an order without escrow; two concurrent buys by one buyer can drive the balance negative. Read from code, not reproduced. Status: OPEN, pinned by `pnpm test:marketplace-static`. Phase: MKT-07 (BC-5).

- **MKT-ISSUE-8** (medium): PATCH /admin/marketplace/orders/:id: when the order id does not exist the handler answers 404 right after BEGIN with no ROLLBACK, so the pooled connection goes back to the pool idle in transaction. node-pg release() does not reset the session, so the next user of that connection runs inside the open transaction. Found by a path-by-path scan of all 16 transactional handlers (the only one). Admin-only trigger. Read from code; the DB suite reproduces it (txn-hygiene.db.test.ts). Status: OPEN (pinned, not changed) Phase: MKT-07 (fix with the orders move: one ROLLBACK, or withTransaction).

- **MKT-ISSUE-9** (high): NFT buy (POST /marketplace/nft/buy): the seller is credited with UPDATE marketplace_wallets ... market_type='nft' and the result is never checked. Minting an NFT listing does not create the seller's nft wallet row (ensureWallet is called only for the buyer). A seller who never opened the wallet page or deposited has no nft wallet row, so a sale debits the buyer, marks the NFT sold, records a transaction and credits nobody. Read from code, not reproduced; the DB suite reproduces it deterministically. Status: OPEN (pinned, not changed) Phase: MKT-09 (fix as a listed behavior change).

## Decisions for outside consumers

| File | Decision | Phase | How |
|---|---|---|---|
| `services/admin-wallet.ts` | REWIRE | MKT-13 | mark transactions admin_credited through the wallet contract |
| `vault/infrastructure/repositories/vault-market-repository.ts` | REWIRE | MKT-04b | wallet and transaction writes call MarketplaceWalletContract (D3); listing SQL stays in Vault |
| `vault/infrastructure/repositories/game-repository.ts` | REWIRE | MKT-04b | same as vault-market-repository |
| `vault/infrastructure/repositories/snapshot-sections-repository.ts` | REWIRE | MKT-12 | reads trades through marketplace/polymarket/contract.listTradesForSnapshot (read only) |
| `routes/search.ts` | REWIRE | MKT-13 | read model from catalog (read only) |
| `routes/nft-subscriptions.ts` | REWIRE | MKT-13 | writes marketplace_activity_log and nft_market_categories; move to admin/markets application use cases |
| `lib/market-config.ts` | MOVE | MKT-03 | becomes marketplace/kernel/infrastructure/market-config-repo.ts, old path re-exports |
| `lib/service-boundaries.ts` | EXEMPT | none | static registry of table names per domain, no SQL; recorded as accepted |
