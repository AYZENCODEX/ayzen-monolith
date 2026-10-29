/**
 * marketplace/kernel/domain/fee-policy.ts
 * MKT-03 (decision D1): the one owner of Marketplace fee percentages. Pure: no database, no HTTP.
 *
 * DEFAULT_FEE_PCT holds exactly the constants the route files used to declare, so moving them here changes no behavior.
 * resolveFeePct implements the resolution order of behavior change BC-1, which is NOT wired into any route yet:
 *   1. marketplace_market_configs row for the market (admin fee surface of the Vault and Game markets)
 *   2. legacy marketplace_settings row (admin "fee settings"; today only GET/PATCH /marketplace/settings read or write it)
 *      applies to the P2P family only (p2p, cart, bundle, offer)
 *   3. DEFAULT_FEE_PCT
 */

export type FeeMarket = "p2p" | "cart" | "bundle" | "offer" | "azn" | "usdt" | "nft" | "spot";

export const DEFAULT_FEE_PCT = Object.freeze({
  p2p: 5,
  cart: 5,
  bundle: 5,
  offer: 5,
  azn: 2.5,
  usdt: 2.5,
  nft: 3,
  spot: 0.1,
});

export const P2P_FAMILY: ReadonlyArray<FeeMarket> = ["p2p", "cart", "bundle", "offer"];

export interface FeeRow {
  fee_pct: number | string | null | undefined;
  enabled?: boolean | null;
}

export interface FeeSources {
  /** rows of marketplace_market_configs keyed by market_type */
  marketConfigs?: Record<string, FeeRow | undefined>;
  /** the single marketplace_settings row, when present */
  legacySettings?: FeeRow | null;
}

function validPct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function resolveFeePct(market: FeeMarket, sources: FeeSources = {}): number {
  const fromConfig = validPct(sources.marketConfigs?.[market]?.fee_pct);
  if (fromConfig !== null) return fromConfig;
  if (P2P_FAMILY.includes(market)) {
    const fromLegacy = validPct(sources.legacySettings?.fee_pct);
    if (fromLegacy !== null) return fromLegacy;
  }
  return DEFAULT_FEE_PCT[market];
}
