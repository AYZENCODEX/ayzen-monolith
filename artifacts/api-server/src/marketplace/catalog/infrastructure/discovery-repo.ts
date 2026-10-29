/**
 * marketplace/catalog/infrastructure/discovery-repo.ts
 * MKT-05: the five read statements of routes/marketplace-discovery.ts, moved verbatim (the SQL text is pinned by
 * scripts/antas/marketplace/characterization/moved-sql.pins.json). Same parameters, same order; `categories` takes no
 * parameter array, as before.
 * This file never imports the database pool, so it can be unit-tested without a database; the wired instance is in
 * discovery-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const DISCOVERY_SQL = {
  base: "SELECT listing_type, price_azn FROM marketplace_listings WHERE id=$1",
  similar: `SELECT * FROM marketplace_listings
       WHERE id <> $1 AND status='active' AND listing_type=$2
       ORDER BY ABS(price_azn - $3) ASC LIMIT 10`,
  trending: `SELECT * FROM marketplace_listings
       WHERE status='active' AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY view_count DESC, created_at DESC LIMIT $1`,
  categories: `SELECT listing_type, COUNT(*)::int as count
       FROM marketplace_listings WHERE status='active'
       GROUP BY listing_type ORDER BY count DESC`,
  featured: `SELECT ml.*, u.username as seller_username
       FROM marketplace_listings ml LEFT JOIN users u ON u.id = ml.seller_id
       WHERE ml.status='active' AND ml.is_featured=TRUE
         AND (ml.featured_until IS NULL OR ml.featured_until > NOW())
       ORDER BY ml.created_at DESC LIMIT $1`,
} as const;

export function createDiscoveryRepo(db: Queryable) {
  return {
    async findBase(id: number): Promise<any[]> { return (await db.query(DISCOVERY_SQL.base, [id])).rows; },
    async listSimilar(id: number, listingType: unknown, priceAzn: unknown): Promise<any[]> { return (await db.query(DISCOVERY_SQL.similar, [id, listingType, priceAzn])).rows; },
    async listTrending(limit: number): Promise<any[]> { return (await db.query(DISCOVERY_SQL.trending, [limit])).rows; },
    async listCategories(): Promise<any[]> { return (await db.query(DISCOVERY_SQL.categories)).rows; },
    async listFeatured(limit: number): Promise<any[]> { return (await db.query(DISCOVERY_SQL.featured, [limit])).rows; },
  };
}
export type DiscoveryRepo = ReturnType<typeof createDiscoveryRepo>;
