/** MKT-05f composition root: the market stats repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createMarketStatsRepo, type MarketStatsRepo, type Queryable } from "./market-stats-repo";

export const marketStatsRepo: MarketStatsRepo = createMarketStatsRepo(pool as unknown as Queryable);
