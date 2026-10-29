/**
 * marketplace/engagement/application/reviews.ts
 * MKT-05d: use cases behind the seven review routes. The route adapter destructures req.body / req.query itself (before its try
 * block, as before) and passes the fields in. Validation failures and missing rows are results; database errors are thrown.
 */
import { parseNewRating, sellerReviewsParams, updateReviewParams, upsertReviewParams, type ReviewInput } from "../domain/reviews";
import type { ReviewsRepo } from "../infrastructure/reviews-repo";

export type Failure = { ok: false; status: 400 | 404; error: string };
export type Row = { ok: true; row: any };

export function createReviewsService(repo: ReviewsRepo) {
  return {
    async create(userId: number, orderId: number, input: ReviewInput): Promise<Row | Failure> {
      const r5 = parseNewRating(input.rating);
      if (r5 === null) return { ok: false, status: 400, error: "rating must be 1-5" };
      const order = (await repo.findCompletedOrder(orderId, userId))[0];
      if (!order) return { ok: false, status: 404, error: "Completed order not found or not yours" };
      return { ok: true, row: (await repo.upsertReview(upsertReviewParams(orderId, order, userId, r5, input.comment)))[0] };
    },
    sellerReviews: (sellerId: number, limit: any, offset: any): Promise<any[]> => repo.listSellerReviews(sellerReviewsParams(sellerId, limit, offset)),
    async sellerRating(sellerId: number): Promise<any> { return (await repo.sellerRating(sellerId))[0]; },
    async update(userId: number, id: number, input: ReviewInput): Promise<Row | Failure> {
      const rows = await repo.updateReview(updateReviewParams(userId, id, input));
      return rows.length === 0 ? { ok: false, status: 404, error: "Review not found or not yours" } : { ok: true, row: rows[0] };
    },
    async remove(userId: number, id: number): Promise<{ ok: true } | Failure> {
      const rows = await repo.deleteReview(id, userId);
      return rows.length === 0 ? { ok: false, status: 404, error: "Review not found or not yours" } : { ok: true };
    },
    async respond(userId: number, id: number, response: any): Promise<Row | Failure> {
      if (!response) return { ok: false, status: 400, error: "response is required" };
      const rows = await repo.respond(response, id, userId);
      return rows.length === 0 ? { ok: false, status: 404, error: "Review not found or not yours to respond to" } : { ok: true, row: rows[0] };
    },
    myReviews: (userId: number): Promise<any[]> => repo.listMyReviews(userId),
  };
}
