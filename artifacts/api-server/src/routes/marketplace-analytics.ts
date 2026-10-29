import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { analytics } from "../marketplace/analytics/application/analytics.wired";

// MKT-05b: thin adapter. Paths, middleware order, status codes, response bodies and the point where credits are charged are
// unchanged; SQL lives in marketplace/analytics/infrastructure/analytics-repo.ts.
const router = Router();

// --- 27. GET /marketplace/analytics/overview -- seller's own sales overview ---
router.get("/marketplace/analytics/overview", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await analytics.overview(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 28. GET /marketplace/analytics/revenue -- seller revenue over time -------
// PHASE 5: metered action verve.premium_analytics -- the seller's basic
// overview (above) stays free, this time-series breakdown is the "premium
// analytics" line from the master plan's §5 metered-actions table.
router.get("/marketplace/analytics/revenue", requireAuth, requireCreditBalance("verve.premium_analytics"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { days = 30 } = req.query as any;
  try {
    const rows = await analytics.revenue(userId, days);
    await chargeCredits(userId, "verve.premium_analytics");
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 29. GET /marketplace/analytics/top-listings -- best performing listings --
// PHASE 5: metered action verve.premium_analytics (same as /revenue above).
router.get("/marketplace/analytics/top-listings", requireAuth, requireCreditBalance("verve.premium_analytics"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const rows = await analytics.topListings(userId);
    await chargeCredits(userId, "verve.premium_analytics");
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 30. GET /marketplace/listings/:id/views -- a listing's view count --------
router.get("/marketplace/listings/:id/views", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await analytics.views(id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ listing_id: id, view_count: r.viewCount });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 31. POST /marketplace/listings/:id/view -- record a view (public, best-effort) -
router.post("/marketplace/listings/:id/view", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await analytics.recordView(id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ view_count: r.viewCount });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 32. GET /admin/marketplace/analytics/platform -- platform-wide analytics -
router.get("/admin/marketplace/analytics/platform", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { days = 30 } = req.query as any;
  try {
    res.json(await analytics.platform(days));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
