/**
 * marketplace/catalog/infrastructure/listings-repo.ts
 * MKT-05g: the fixed read statements of the listing routes, moved verbatim (text pinned in moved-sql.pins.json); the dynamic list,
 * count and search statements are built by domain/listing-queries.ts and only executed here. Never imports the pool.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const LISTINGS_SQL = {
  detail: `SELECT ml.*, u.username as seller_username,
              (SELECT COUNT(*)::int FROM marketplace_favorites WHERE listing_id = ml.id) as favorite_count
       FROM marketplace_listings ml
       LEFT JOIN users u ON u.id = ml.seller_id
       WHERE ml.id = $1`,
  pricing: "SELECT platform, price_azn FROM marketplace_listing_platform_pricing WHERE listing_id=$1 ORDER BY platform",
  mine: `SELECT ml.*, u.username as buyer_username
       FROM marketplace_listings ml
       LEFT JOIN users u ON u.id = ml.buyer_id
       WHERE ml.seller_id = $1
       ORDER BY ml.created_at DESC`,
  adminList: `SELECT ml.*, u.username as seller_username
       FROM marketplace_listings ml
       LEFT JOIN users u ON u.id = ml.seller_id
       ORDER BY ml.created_at DESC LIMIT 100`,
  history: `SELECT * FROM marketplace_activity_log WHERE target_id = $1 AND target_type IN ('entity','local_account','nft','azn','username_nft','badge_nft')
       ORDER BY created_at DESC LIMIT 50`,
} as const;

export function createListingsRepo(db: Queryable) {
  const q = async (text: string, params?: any[]): Promise<any[]> => (await db.query(text, params)).rows;
  return {
    run: (sql: string, params: any[]) => q(sql, params),
    detail: (id: number) => q(LISTINGS_SQL.detail, [id]),
    pricing: (id: number) => q(LISTINGS_SQL.pricing, [id]),
    mine: (userId: number) => q(LISTINGS_SQL.mine, [userId]),
    adminList: () => q(LISTINGS_SQL.adminList, undefined), // the original passed no parameter array
    history: (listingId: number) => q(LISTINGS_SQL.history, [listingId]),
  };
}
export type ListingsRepo = ReturnType<typeof createListingsRepo>;
