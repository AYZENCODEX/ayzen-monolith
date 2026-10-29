/**
 * marketplace/analytics/infrastructure/analytics-repo.ts
 * MKT-05b: the six statements of routes/marketplace-analytics.ts, moved verbatim (SQL text pinned in
 * scripts/antas/marketplace/characterization/moved-sql.pins.json). Same parameters, same order. Never imports the pool;
 * the wired instance is analytics-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const ANALYTICS_SQL = {
  overview: `SELECT
        (SELECT COUNT(*)::int FROM marketplace_listings WHERE seller_id=$1 AND status='active') as active_listings,
        (SELECT COUNT(*)::int FROM marketplace_listings WHERE seller_id=$1 AND status='sold') as sold_listings,
        (SELECT COUNT(*)::int FROM marketplace_orders WHERE seller_id=$1 AND status='completed') as completed_sales,
        (SELECT COALESCE(SUM(seller_receives),0) FROM marketplace_orders WHERE seller_id=$1 AND status IN ('approved','completed')) as total_earned_azn,
        (SELECT COALESCE(AVG(rating),0)::float FROM marketplace_reviews WHERE seller_id=$1) as avg_rating,
        (SELECT COUNT(*)::int FROM marketplace_reviews WHERE seller_id=$1) as review_count`,
  revenue: `SELECT DATE(resolved_at) as date, COALESCE(SUM(seller_receives),0) as revenue_azn, COUNT(*)::int as orders
       FROM marketplace_orders
       WHERE seller_id=$1 AND status IN ('approved','completed') AND resolved_at >= NOW() - ($2 || ' days')::interval
       GROUP BY DATE(resolved_at) ORDER BY date ASC`,
  topListings: `SELECT ml.id, ml.title, ml.view_count,
              COUNT(mo.id) FILTER (WHERE mo.status IN ('approved','completed'))::int as sales_count,
              COALESCE(SUM(mo.seller_receives) FILTER (WHERE mo.status IN ('approved','completed')),0) as revenue_azn
       FROM marketplace_listings ml
       LEFT JOIN marketplace_orders mo ON mo.listing_id = ml.id
       WHERE ml.seller_id = $1
       GROUP BY ml.id ORDER BY revenue_azn DESC LIMIT 10`,
  listingViews: "SELECT view_count FROM marketplace_listings WHERE id=$1",
  recordView: "UPDATE marketplace_listings SET view_count = view_count + 1 WHERE id=$1 RETURNING view_count",
  platform: `SELECT DATE(resolved_at) as date, COUNT(*)::int as orders,
              COALESCE(SUM(price_azn),0) as volume_azn, COALESCE(SUM(fee_azn),0) as fees_azn
       FROM marketplace_orders
       WHERE status IN ('approved','completed') AND resolved_at >= NOW() - ($1 || ' days')::interval
       GROUP BY DATE(resolved_at) ORDER BY date ASC`,
} as const;

export function createAnalyticsRepo(db: Queryable) {
  return {
    async overview(userId: number): Promise<any[]> { return (await db.query(ANALYTICS_SQL.overview, [userId])).rows; },
    async revenue(userId: number, days: string): Promise<any[]> { return (await db.query(ANALYTICS_SQL.revenue, [userId, days])).rows; },
    async topListings(userId: number): Promise<any[]> { return (await db.query(ANALYTICS_SQL.topListings, [userId])).rows; },
    async listingViews(id: number): Promise<any[]> { return (await db.query(ANALYTICS_SQL.listingViews, [id])).rows; },
    async recordView(id: number): Promise<any[]> { return (await db.query(ANALYTICS_SQL.recordView, [id])).rows; },
    async platform(days: string): Promise<any[]> { return (await db.query(ANALYTICS_SQL.platform, [days])).rows; },
  };
}
export type AnalyticsRepo = ReturnType<typeof createAnalyticsRepo>;
