/**
 * marketplace/engagement/infrastructure/reviews-repo.ts
 * MKT-05d: the 11 statements of routes/marketplace-reviews.ts (3 of them feed the PEP resource builders), moved verbatim;
 * text pinned in moved-sql.pins.json. Never imports the pool; the wired instance is reviews-repo.wired.ts.
 */
export interface Queryable { query(text: string, params?: any[]): Promise<{ rows: any[] }> }

export const REVIEWS_SQL = {
  orderBuyer: "SELECT buyer_id FROM marketplace_orders WHERE id=$1 LIMIT 1",
  reviewBuyer: "SELECT buyer_id FROM marketplace_reviews WHERE id=$1 LIMIT 1",
  reviewSeller: "SELECT seller_id FROM marketplace_reviews WHERE id=$1 LIMIT 1",
  completedOrder: "SELECT * FROM marketplace_orders WHERE id=$1 AND buyer_id=$2 AND status='completed'",
  upsert: `INSERT INTO marketplace_reviews (order_id, listing_id, buyer_id, seller_id, rating, comment, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
       ON CONFLICT (order_id) DO UPDATE SET rating=$5, comment=$6, updated_at=NOW()
       RETURNING *`,
  sellerReviews: `SELECT mr.*, ml.title as listing_title, u.username as buyer_username
       FROM marketplace_reviews mr
       JOIN marketplace_listings ml ON ml.id = mr.listing_id
       LEFT JOIN users u ON u.id = mr.buyer_id
       WHERE mr.seller_id = $1
       ORDER BY mr.created_at DESC LIMIT $2 OFFSET $3`,
  sellerRating: `SELECT COUNT(*)::int as review_count, COALESCE(AVG(rating),0)::float as avg_rating,
              COUNT(*) FILTER (WHERE rating=5)::int as five_star,
              COUNT(*) FILTER (WHERE rating=4)::int as four_star,
              COUNT(*) FILTER (WHERE rating=3)::int as three_star,
              COUNT(*) FILTER (WHERE rating=2)::int as two_star,
              COUNT(*) FILTER (WHERE rating=1)::int as one_star
       FROM marketplace_reviews WHERE seller_id=$1`,
  update: `UPDATE marketplace_reviews SET
        rating = COALESCE($1, rating), comment = COALESCE($2, comment), updated_at=NOW()
       WHERE id=$3 AND buyer_id=$4 RETURNING *`,
  remove: "DELETE FROM marketplace_reviews WHERE id=$1 AND buyer_id=$2 RETURNING id",
  respond: `UPDATE marketplace_reviews SET seller_response=$1, seller_response_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND seller_id=$3 RETURNING *`,
  myReviews: `SELECT mr.*, ml.title as listing_title
       FROM marketplace_reviews mr JOIN marketplace_listings ml ON ml.id = mr.listing_id
       WHERE mr.buyer_id = $1 ORDER BY mr.created_at DESC`,
} as const;

export function createReviewsRepo(db: Queryable) {
  const q = async (text: string, params: any[]): Promise<any[]> => (await db.query(text, params)).rows;
  return {
    findOrderBuyer: (id: number) => q(REVIEWS_SQL.orderBuyer, [id]),
    findReviewBuyer: (id: number) => q(REVIEWS_SQL.reviewBuyer, [id]),
    findReviewSeller: (id: number) => q(REVIEWS_SQL.reviewSeller, [id]),
    findCompletedOrder: (orderId: number, userId: number) => q(REVIEWS_SQL.completedOrder, [orderId, userId]),
    upsertReview: (params: any[]) => q(REVIEWS_SQL.upsert, params),
    listSellerReviews: (params: any[]) => q(REVIEWS_SQL.sellerReviews, params),
    sellerRating: (sellerId: number) => q(REVIEWS_SQL.sellerRating, [sellerId]),
    updateReview: (params: any[]) => q(REVIEWS_SQL.update, params),
    deleteReview: (id: number, userId: number) => q(REVIEWS_SQL.remove, [id, userId]),
    respond: (response: any, id: number, userId: number) => q(REVIEWS_SQL.respond, [response, id, userId]),
    listMyReviews: (userId: number) => q(REVIEWS_SQL.myReviews, [userId]),
  };
}
export type ReviewsRepo = ReturnType<typeof createReviewsRepo>;
