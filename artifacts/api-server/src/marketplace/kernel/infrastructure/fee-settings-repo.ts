/**
 * marketplace/kernel/infrastructure/fee-settings-repo.ts
 * MKT-03 (D1, behavior change BC-1): loads the two admin fee surfaces and resolves the effective fee. NOT wired into any
 * route yet. Even when wired it stays off unless MARKETPLACE_FEE_FROM_CONFIG=1, so the default is today's constants and no
 * extra query runs. Before switching it on, read the stored rows on the real database (marketplace_settings.fee_pct and
 * marketplace_market_configs): a non-default value that an admin once saved would start to apply to orders.
 */
import { DEFAULT_FEE_PCT, resolveFeePct, type FeeMarket, type FeeRow, type FeeSources } from "../domain/fee-policy";
import type { SqlExecutor } from "../ports/credits-port";

export const FEE_FROM_CONFIG_FLAG = "MARKETPLACE_FEE_FROM_CONFIG";

export async function loadFeeSources(db: SqlExecutor): Promise<FeeSources> {
  const configs = await db.query("SELECT market_type, fee_pct, enabled FROM marketplace_market_configs");
  const marketConfigs: Record<string, FeeRow> = {};
  for (const row of configs.rows) marketConfigs[String(row.market_type)] = { fee_pct: row.fee_pct, enabled: row.enabled };
  const legacy = await db.query("SELECT fee_pct, enabled FROM marketplace_settings LIMIT 1");
  return { marketConfigs, legacySettings: legacy.rows[0] ? { fee_pct: legacy.rows[0].fee_pct, enabled: legacy.rows[0].enabled } : null };
}

export async function effectiveFeePct(db: SqlExecutor, market: FeeMarket, env: Record<string, string | undefined> = process.env): Promise<number> {
  if (env[FEE_FROM_CONFIG_FLAG] !== "1") return DEFAULT_FEE_PCT[market];
  return resolveFeePct(market, await loadFeeSources(db));
}
