/**
 * marketplace/engagement/security/review-resources.ts
 * MKT-05d: the three PEP resource builders of routes/marketplace-reviews.ts, moved verbatim. Each maps a non-numeric id, or a
 * missing row, to the sentinel owner -1 (nobody); the route turns a denial into its own 404 body.
 *  - order : owner = marketplace_orders.buyer_id   (create a review)
 *  - buyer : owner = marketplace_reviews.buyer_id  (edit and delete a review)
 *  - seller: owner = marketplace_reviews.seller_id (respond to a review)
 */
import type { Request } from "express";
import type { ResourceRefBuilder } from "../../../lib/policy/pep/types";

export const REVIEW_OWNER_SENTINEL_NONE = -1;

interface ReviewOwnerLookups {
  findOrderBuyer(id: number): Promise<any[]>;
  findReviewBuyer(id: number): Promise<any[]>;
  findReviewSeller(id: number): Promise<any[]>;
}

export function createReviewResources(repo: ReviewOwnerLookups) {
  const build = (type: string, lookup: (id: number) => Promise<any[]>, column: string): ResourceRefBuilder => async (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return { type, id: req.params.id, ownerId: REVIEW_OWNER_SENTINEL_NONE };
    const rows = await lookup(id);
    return { type, id, ownerId: rows[0]?.[column] ?? REVIEW_OWNER_SENTINEL_NONE };
  };
  return {
    marketplaceReviewOrderResource: build("marketplace_order", (id) => repo.findOrderBuyer(id), "buyer_id"),
    marketplaceReviewBuyerResource: build("marketplace_review", (id) => repo.findReviewBuyer(id), "buyer_id"),
    marketplaceReviewSellerResource: build("marketplace_review", (id) => repo.findReviewSeller(id), "seller_id"),
  };
}
