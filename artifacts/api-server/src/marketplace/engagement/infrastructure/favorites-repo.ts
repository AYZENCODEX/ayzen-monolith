/**
 * marketplace/engagement/infrastructure/favorites-repo.ts
 * MKT-05g: the four statements of the favorites routes, moved verbatim (text pinned in moved-sql.pins.json). Never imports the pool.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const FAVORITES_SQL = {
  list: `SELECT mf.id as favorite_id, mf.created_at as favorited_at, ml.*, u.username as seller_username
       FROM marketplace_favorites mf
       JOIN marketplace_listings ml ON ml.id = mf.listing_id
       LEFT JOIN users u ON u.id = ml.seller_id
       WHERE mf.user_id = $1
       ORDER BY mf.created_at DESC`,
  listingExists: "SELECT id FROM marketplace_listings WHERE id=$1",
  insert: `INSERT INTO marketplace_favorites (user_id, listing_id) VALUES ($1,$2)
       ON CONFLICT (user_id, listing_id) DO NOTHING RETURNING *`,
  remove: "DELETE FROM marketplace_favorites WHERE user_id=$1 AND listing_id=$2",
} as const;

export function createFavoritesRepo(db: Queryable) {
  const q = async (text: string, params: any[]): Promise<any[]> => (await db.query(text, params)).rows;
  return {
    list: (userId: number) => q(FAVORITES_SQL.list, [userId]),
    listingExists: (listingId: number) => q(FAVORITES_SQL.listingExists, [listingId]),
    insert: (userId: number, listingId: number) => q(FAVORITES_SQL.insert, [userId, listingId]),
    remove: (userId: number, listingId: number) => q(FAVORITES_SQL.remove, [userId, listingId]),
  };
}
export type FavoritesRepo = ReturnType<typeof createFavoritesRepo>;
