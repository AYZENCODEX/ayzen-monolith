/**
 * marketplace/engagement/domain/reviews.ts
 * MKT-05d: the pure rules of routes/marketplace-reviews.ts, moved verbatim. No database, no HTTP.
 */
export interface ReviewInput { rating?: any; comment?: any }

/** The rating of a new review, or null when it is not 1-5 (the route answers 400 "rating must be 1-5"). */
export function parseNewRating(rating: any): number | null {
  const r5 = Number(rating);
  return !r5 || r5 < 1 || r5 > 5 ? null : r5;
}

export function upsertReviewParams(orderId: number, order: { listing_id: any; seller_id: any }, userId: number, r5: number, comment: any): any[] {
  return [orderId, order.listing_id, userId, order.seller_id, r5, comment || null];
}

/** PATCH: a falsy rating or a missing comment leaves the stored value alone (COALESCE in the statement). */
export function updateReviewParams(userId: number, id: number, input: ReviewInput): any[] {
  const { rating, comment } = input;
  return [rating ? Number(rating) : null, comment ?? null, id, userId];
}

export function sellerReviewsParams(sellerId: number, limit: any, offset: any): any[] {
  return [sellerId, Number(limit), Number(offset)];
}
