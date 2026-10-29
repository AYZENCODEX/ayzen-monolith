/** MKT-05f: use case behind GET /marketplace/stats (public): the first row of the platform statement, as before. */
import type { MarketStatsRepo } from "../infrastructure/market-stats-repo";

export function createMarketStatsService(repo: MarketStatsRepo) {
  return { async platform(): Promise<any> { return (await repo.platformStats())[0]; } };
}
