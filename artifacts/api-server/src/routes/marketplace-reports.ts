import { Router } from "express";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { reports } from "../marketplace/engagement/application/reports.wired";

// MKT-05e: thin adapter. Paths, middleware order, status codes and response bodies are unchanged; SQL lives in
// marketplace/engagement/infrastructure/reports-repo.ts, the rules in domain/reports.ts. The moderation transaction keeps its
// original shape inside application/reports.ts (a failing ROLLBACK still escapes the handler).
const router = Router();

// --- 22. POST /marketplace/listings/:id/report -- report a listing ------------
router.post("/marketplace/listings/:id/report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const { reason, details } = req.body;
  try {
    const r = await reports.reportListing(userId, listingId, { reason, details });
    if (!r.ok && r.status === 400) { res.status(400).json({ error: r.error }); return; }
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.status(201).json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 23. GET /admin/marketplace/reports -- moderation queue -------------------
router.get("/admin/marketplace/reports", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { status = "pending" } = req.query as any;
  try {
    res.json(await reports.queue(status));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 24. PATCH /admin/marketplace/reports/:id -- resolve a report -------------
// action: "dismiss" | "remove_listing"
router.patch("/admin/marketplace/reports/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { action, admin_note } = req.body;
  const r = await reports.resolve(id, { action, admin_note });
  if (!r.ok && r.status === 400) { res.status(400).json({ error: r.error }); return; }
  if (!r.ok && r.status === 404) { res.status(404).json({ error: r.error }); return; }
  if (!r.ok) { res.status(500).json({ error: r.error }); return; }
  res.json({ ok: true, action: r.action });
});

// --- 25. GET /marketplace/reports/my -- user's own submitted reports ----------
router.get("/marketplace/reports/my", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await reports.myReports(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 26. POST /marketplace/sellers/:id/report -- report a seller/user directly -
router.post("/marketplace/sellers/:id/report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const sellerId = Number(req.params.id);
  const { reason, details } = req.body;
  try {
    const r = await reports.reportSeller(userId, sellerId, { reason, details });
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    res.status(201).json(r.row);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
