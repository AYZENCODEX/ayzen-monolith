import test from "node:test";
import assert from "node:assert/strict";
import { createMarketStatsService } from "./market-stats";
import { createMarketStatsRepo, MARKET_STATS_SQL, type Queryable } from "../infrastructure/market-stats-repo";

test("platform stats: one statement without parameters, first row returned", async () => {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: [{ active_listings: "3" }] }; } };
  assert.deepEqual(await createMarketStatsService(createMarketStatsRepo(db)).platform(), { active_listings: "3" });
  assert.deepEqual(calls, [{ text: MARKET_STATS_SQL.platform, params: undefined }]);
});
