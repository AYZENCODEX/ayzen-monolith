# Marketplace target directory tree

Status: PROPOSAL (documentation only). No source was moved and no directory was created. Basis: static inspection of the
uploaded archive (no `.git`, commit SHA `UNAVAILABLE`). Nothing below is a PASS claim; each extraction needs its own
characterization tests, rewiring and boundary-scan run. Extends `marketplace-audit.md` and follows the shape of
`finance-target-tree.md` and `projects-boundaries.md`.

Rules that apply to the whole tree:

- Marketplace stays inside `artifacts/api-server`. Routes remain compatibility adapters with the **same 143 paths and response shapes**.
- No schema change (D5). DDL stays in `lib/schema-migrations.ts`; table ownership is recorded in the boundary manifest.
- `services/marketplace` (transport shim) is not a dependency and is not touched.
- Polymarket is the sub-module `marketplace/polymarket/` (D4).
- Money moves go through ports (D2, D3). No file outside `marketplace/wallet/` writes `marketplace_wallets` or `marketplace_transactions`.
- Layers per sub-module: `domain` (pure, no DB/HTTP/fs/provider) -> `application` (use cases) -> `infrastructure` (SQL repositories, external clients) -> `security` (PEP resource builders, ownership). Routes call `application` only.

Convention (MKT-05): a file named `*.wired.ts` is a composition root, the only kind of file that imports the database pool (`kernel/infrastructure/pool`), because `@workspace/db` needs DATABASE env at import time. Repositories take a `Queryable`, use cases take a repository, and tests build them with a fake.

Legend: `[EXISTS]` already in place - `[MOVE]` relocate, old path becomes a re-export or is retired - `[SPLIT]` divide by responsibility - `[NEW]` does not exist yet - `[STAYS]` not moved.

## Target tree

```text
artifacts/api-server/src/
├── routes/                                      [STAYS] thin HTTP adapters only (no pool, no SQL)
│   ├── marketplace.ts                           [SPLIT] -> marketplace-listings.ts, marketplace-orders.ts,
│   │                                                      marketplace-admin.ts (same paths, same order of registration)
│   ├── marketplace-{alerts,analytics,azn,bundles,cart,coupons,discovery,game,
│   │                market-config,nft,offers,reports,reviews,spot,usdt,vault,wallet}.ts   [STAYS as adapters]
│   └── polymarket.ts                            [STAYS as adapter -> marketplace/polymarket/application/*]
│
├── lib/
│   ├── market-config.ts                         [MOVE] -> marketplace/kernel/infrastructure/market-config-repo.ts (re-export)
│   └── schema-migrations.ts                     [STAYS] DDL stays here (D5)
│
├── services/
│   ├── polymarket-clob.ts                       [MOVE] -> marketplace/polymarket/infrastructure/clob-client.ts (re-export)
│   ├── admin-wallet.ts                          [STAYS] switch to the marketplace wallet contract (MKT-13)
│   └── credit-meter.ts                          [STAYS] adapted behind marketplace/kernel/ports/credits-port.ts
│
├── vault/
│   ├── infrastructure/repositories/
│   │   ├── vault-market-repository.ts           [STAYS in Vault] wallet/tx writes -> marketplace/wallet contract (D3)
│   │   └── game-repository.ts                   [STAYS in Vault] same
│   └── shared/marketplace/use-cases.ts          [STAYS in Vault] listing logic for vault/game markets; fee from kernel fee-policy
│
└── marketplace/
    ├── kernel/                                  shared by every sub-module; the only place for shared rules
    │   ├── domain/
    │   │   ├── fee-policy.ts                    [NEW] resolveFeePct(market, configs, legacy) + fee/net arithmetic (D1)
    │   │   ├── money.ts                         [NEW] records current REAL arithmetic; rounding changes are explicit later
    │   │   ├── order-status.ts                  [NEW] order and offer state machines (pending/confirmed/disputed/...)
    │   │   └── errors.ts                        [NEW] typed domain errors -> HTTP mapping stays in adapters
    │   ├── ports/
    │   │   ├── credits-port.ts                  [NEW] debit/credit AZN balance (wraps credits table, credit-meter) (D2)
    │   │   ├── token-wallet-port.ts             [NEW] USDT leg (wraps builtin_wallet_tokens) (D2)
    │   │   ├── notifier-port.ts                 [NEW] wraps lib/notification-bus
    │   │   └── vault-ownership-port.ts          [NEW] wraps vault/security/{market-listing,game}-ownership
    │   └── infrastructure/
    │       ├── tx.ts                            [NEW] withTransaction(client => ...) around BEGIN/COMMIT/ROLLBACK
    │       ├── pool.ts                          [NEW] single import of @workspace/db pool for the module
    │       └── market-config-repo.ts            [MOVE] from lib/market-config.ts
    │
    ├── wallet/                                  owner of marketplace_wallets + marketplace_transactions
    │   ├── domain/                              balance and lock rules
    │   ├── application/{deposit,withdraw,summary,transactions}.ts   [MOVE] from routes/marketplace-wallet.ts
    │   ├── contract.ts                          [NEW] MarketplaceWalletContract: debit, credit, lock, unlock, record tx (used by Vault, D3)
    │   └── infrastructure/{wallets-repo,transactions-repo}.ts
    │
    ├── catalog/                                 listings, pricing, discovery, search
    │   ├── domain/                              listing validation, pricing rules
    │   ├── application/{listings,pricing,promotion,search,discovery,vault-items}.ts
    │   ├── infrastructure/{listings-repo,pricing-repo,favorites-repo,search-repo}.ts
    │   └── security/listing-resource.ts         [MOVE] PEP resource builders out of marketplace.ts
    │
    ├── orders/                                  P2P escrow orders (money critical)
    │   ├── domain/{order-lifecycle,dispute-resolution}.ts
    │   ├── application/{purchase,confirm,dispute,resolve-dispute,receipt,admin-orders}.ts
    │   ├── infrastructure/orders-repo.ts
    │   └── security/order-resource.ts
    │
    ├── checkout/                                everything that ends in an order
    │   ├── cart/{domain,application,infrastructure}
    │   ├── coupons/{domain,application,infrastructure}
    │   ├── offers/{domain,application,infrastructure}      accept -> orders/purchase use case, not its own order SQL
    │   └── bundles/{domain,application,infrastructure}
    │
    ├── engagement/                              no money
    │   ├── reviews/, reports/, alerts/, favorites/, saved-searches/   each {domain,application,infrastructure}
    │
    ├── analytics/                               view counters, seller analytics, platform stats, azn chart
    │   └── {application,infrastructure}
    │
    ├── markets/                                 fixed-price side markets
    │   ├── azn/{domain,application,infrastructure}
    │   ├── usdt/{domain,application,infrastructure}
    │   ├── nft/{domain,application,infrastructure}
    │   │        (azn and usdt look alike: extract a shared base only if the characterization tests prove identical behavior)
    │   ├── vault/application/adapter.ts         [NEW] routes/marketplace-vault.ts calls Vault use cases through here
    │   └── game/application/adapter.ts          [NEW] same for game
    │
    ├── spot/                                    order book, fills, staking (highest risk)
    │   ├── trading/{domain/matching.ts, application, infrastructure}
    │   └── staking/{domain, application, infrastructure}
    │
    ├── admin/                                   settings, market-config, activity log
    │   └── {application,infrastructure}
    │
    └── polymarket/                              SUB-MODULE of Marketplace (D4)
        ├── domain/{trade-rules.ts}              price band 0 < p < 1, YES/NO, size > 0, REAL_MAX_TRADE_USDC check (pure)
        ├── application/{browse-markets,market-detail,usdc-balance,list-trades,place-trade}.ts
        ├── infrastructure/
        │   ├── clob-client.ts                   [MOVE] from services/polymarket-clob.ts (Gamma proxy, CLOB, USDC balance)
        │   ├── trades-repo.ts                   Drizzle polymarketTradesTable (stays Drizzle, no pool rewrite)
        │   └── wallet-reader.ts                 loads the caller's own wallet row (walletsTable)
        ├── security/
        │   ├── request-user.ts                  [MOVE] the inline requireUser, behavior identical, one place
        │   └── wallet-unlock.ts                 the ONLY caller of lib/wallet-crypto.decryptPhrase; never logs; never returns key material
        └── contract.ts                          [NEW] listTradesForSnapshot(userId) for vault/application/snapshot (replaces direct table read)
```

## Ownership of tables (manifest seed; DDL does not move)

| Sub-module | Tables |
|---|---|
| wallet | `marketplace_wallets`, `marketplace_transactions` |
| catalog | `marketplace_listings`, `marketplace_listing_platform_pricing`, `marketplace_favorites` |
| orders | `marketplace_orders` |
| checkout | `marketplace_cart_items`, `marketplace_offers`, `marketplace_coupons`, `marketplace_coupon_usage`, `marketplace_bundles` |
| engagement | `marketplace_reviews`, `marketplace_reports`, `marketplace_alerts`, `marketplace_saved_searches` |
| analytics | view-counter and stats reads (no table of its own; reads catalog and orders) |
| markets | `azn_listings`, `usdt_listings`, `nft_market_listings`, `nft_market_categories` (writer) |
| spot | `spot_orders`, `spot_trades`, `staking_pools`, `staking_positions` |
| admin | `marketplace_settings`, `marketplace_market_configs`, `marketplace_activity_log` |
| polymarket | `polymarket_trades` (Drizzle table in `lib/db/src/schema/polymarket.ts`) |

Not Marketplace tables, reached only through ports: `credits`, `builtin_wallet_tokens`, `wallets`, `users`, `vault_entries`.

## Allowed dependency edges (validator seed)

```text
routes/*            -> marketplace/*/application, marketplace/*/security          (never infrastructure, never pool)
application         -> domain, own infrastructure, kernel (domain, ports, tx), other sub-module contracts
domain              -> nothing outside domain
checkout/*          -> orders/application/purchase (one order-creation path), wallet/contract
markets/*, spot/*   -> wallet/contract, kernel ports
vault/*             -> marketplace/wallet/contract only (no marketplace table SQL)
polymarket/*        -> kernel ports, lib/wallet-crypto (security/wallet-unlock.ts only)
vault snapshot      -> marketplace/polymarket/contract only
```

## Route to owner

All 143 routes are mapped in `marketplace-route-owner-map.csv` (owner and phase per method + path). Totals by top-level owner:
checkout 28, markets 25, engagement 21, catalog 18, orders 16, spot 12, analytics 8, admin 5, wallet 5, polymarket 5.

## Cut points that need care

1. `marketplace.ts` `POST /marketplace/listings/:id/buy`, cart checkout, offer accept and bundle buy each insert into `marketplace_orders` with their own SQL. The target has one `orders/application/purchase` use case; the others call it. Characterization tests must prove the four paths produce identical rows before they are merged.
2. `marketplace-azn.ts` and `marketplace-usdt.ts` are near copies (both `FEE_PCT = 2.5`). Keep separate until a test shows they are equal.
3. `vault/*` repositories keep their listing SQL for `vault` and `game` markets; only wallet and transaction writes move behind the contract (D3).
4. Polymarket keeps Drizzle for `polymarket_trades` and `wallets`; do not rewrite it onto `pool`.
