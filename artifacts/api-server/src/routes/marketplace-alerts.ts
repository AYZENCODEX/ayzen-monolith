import { Router, type Request, type Response } from "express";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import { alerts } from "../marketplace/engagement/application/alerts.wired";
import { marketplaceAlertResource } from "../marketplace/engagement/security/alert-resource.wired";

// MKT-05c: thin adapter. Paths, middleware order, status codes and response bodies are unchanged; the SQL lives in
// marketplace/engagement/infrastructure/alerts-repo.ts, the rules in marketplace/engagement/domain/alerts.ts and the PEP
// resource builder in marketplace/engagement/security/alert-resource.ts.
const router = Router();

function requireMarketplaceAlertOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, marketplaceAlertResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

// --- 38. POST /marketplace/alerts -- create a price/keyword alert -------------
router.post("/marketplace/alerts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { keyword, listing_type, max_price_azn, platform } = req.body;
  try {
    const r = await alerts.create(userId, { keyword, listing_type, max_price_azn, platform });
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    res.status(201).json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 39. GET /marketplace/alerts -- user's own alerts --------------------------
router.get("/marketplace/alerts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await alerts.list(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 40. PATCH /marketplace/alerts/:id -- update or toggle an alert -----------
router.patch("/marketplace/alerts/:id", requireAuth, requireMarketplaceAlertOwnership("marketplace_alert.update", { error: "Alert not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { keyword, max_price_azn, platform, is_active } = req.body;
  try {
    const r = await alerts.update(userId, id, { keyword, max_price_azn, platform, is_active });
    if (!r.ok && r.status === 400) { res.status(400).json({ error: r.error }); return; }
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 41. DELETE /marketplace/alerts/:id -- delete an alert --------------------
router.delete("/marketplace/alerts/:id", requireAuth, requireMarketplaceAlertOwnership("marketplace_alert.delete", { error: "Alert not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await alerts.remove(userId, id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 42. POST /marketplace/saved-searches -- save a filter combination --------
router.post("/marketplace/saved-searches", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { name, filters } = req.body;
  try {
    const r = await alerts.createSavedSearch(userId, { name, filters });
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    res.status(201).json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 43. GET /marketplace/saved-searches -- list user's saved searches --------
router.get("/marketplace/saved-searches", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await alerts.listSavedSearches(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
