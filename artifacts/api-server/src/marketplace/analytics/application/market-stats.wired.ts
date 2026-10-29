/** MKT-05f composition root: the market stats service on the real repository. */
import { marketStatsRepo } from "../infrastructure/market-stats-repo.wired";
import { createMarketStatsService } from "./market-stats";

export const marketStats = createMarketStatsService(marketStatsRepo);
