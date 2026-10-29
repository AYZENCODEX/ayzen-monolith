/**
 * marketplace/analytics/infrastructure/market-stats-repo.ts
 * MKT-05f: the single statement of GET /marketplace/stats, moved verbatim (text pinned in moved-sql.pins.json). Note it counts
 * orders with status 'approved' only, not 'completed', unlike the seller analytics. Never imports the pool.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const MARKET_STATS_SQL = {
  platform: `
      SELECT
        (SELECT COUNT(*) FROM marketplace_listings WHERE status='active') as active_listings,
        (SELECT COUNT(*) FROM marketplace_orders WHERE status='approved') as completed_trades,
        (SELECT COALESCE(SUM(price_azn),0) FROM marketplace_orders WHERE status='approved') as total_volume_azn,
        (SELECT COALESCE(SUM(fee_azn),0) FROM marketplace_orders WHERE status='approved') as total_fees_azn
    `,
} as const;

export function createMarketStatsRepo(db: Queryable) {
  return { async platformStats(): Promise<any[]> { return (await db.query(MARKET_STATS_SQL.platform)).rows; } };
}
export type MarketStatsRepo = ReturnType<typeof createMarketStatsRepo>;
