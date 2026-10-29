import { Router, type Request, type Response } from "express";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { reviews } from "../marketplace/engagement/application/reviews.wired";
import { marketplaceReviewOrderResource, marketplaceReviewBuyerResource, marketplaceReviewSellerResource } from "../marketplace/engagement/security/review-resources.wired";

const router = Router();

// MKT-05d: thin adapter. Paths, middleware order, status codes and response bodies are unchanged. The SQL lives in
// marketplace/engagement/infrastructure/reviews-repo.ts, the rules in domain/reviews.ts and the three PEP resource builders
// (order buyer, review buyer, review seller) in marketplace/engagement/security/review-resources.ts.
function requireMarketplaceReviewOwnership(resource: ResourceRefBuilder, action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, resource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// ─── 1. POST /marketplace/orders/:id/review — buyer reviews a completed order ─
router.post("/marketplace/orders/:id/review", requireAuth, requireMarketplaceReviewOwnership(marketplaceReviewOrderResource, "marketplace_review.create", { error: "Completed order not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const orderId = Number(req.params.id);
  const { rating, comment } = req.body;
  try {
    const r = await reviews.create(userId, orderId, { rating, comment });
    if (!r.ok && r.status === 400) { res.status(400).json({ error: r.error }); return; }
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.status(201).json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 2. GET /marketplace/sellers/:id/reviews — public reviews for a seller ────
router.get("/marketplace/sellers/:id/reviews", async (req, res): Promise<void> => {
  const sellerId = Number(req.params.id);
  const { limit = 50, offset = 0 } = req.query as any;
  try {
    res.json(await reviews.sellerReviews(sellerId, limit, offset));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 3. GET /marketplace/sellers/:id/rating — average rating summary ─────────
router.get("/marketplace/sellers/:id/rating", async (req, res): Promise<void> => {
  const sellerId = Number(req.params.id);
  try {
    res.json(await reviews.sellerRating(sellerId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 4. PATCH /marketplace/reviews/:id — buyer edits own review ──────────────
router.patch("/marketplace/reviews/:id", requireAuth, requireMarketplaceReviewOwnership(marketplaceReviewBuyerResource, "marketplace_review.update", { error: "Review not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { rating, comment } = req.body;
  try {
    const r = await reviews.update(userId, id, { rating, comment });
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 5. DELETE /marketplace/reviews/:id — buyer deletes own review ───────────
router.delete("/marketplace/reviews/:id", requireAuth, requireMarketplaceReviewOwnership(marketplaceReviewBuyerResource, "marketplace_review.delete", { error: "Review not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await reviews.remove(userId, id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 6. POST /marketplace/reviews/:id/response — seller responds to a review ─
router.post("/marketplace/reviews/:id/response", requireAuth, requireMarketplaceReviewOwnership(marketplaceReviewSellerResource, "marketplace_review.response.create", { error: "Review not found or not yours to respond to" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { response } = req.body;
  try {
    const r = await reviews.respond(userId, id, response);
    if (!r.ok && r.status === 400) { res.status(400).json({ error: r.error }); return; }
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 7. GET /marketplace/reviews/my — buyer's own submitted reviews ──────────
router.get("/marketplace/reviews/my", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await reviews.myReviews(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
