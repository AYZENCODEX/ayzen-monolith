import { Router } from "express";
import { discovery } from "../marketplace/catalog/application/discovery.wired";

// MKT-05: thin adapter. Paths, registration order, status codes and response bodies are unchanged; SQL lives in
// marketplace/catalog/infrastructure/discovery-repo.ts.
const router = Router();

// --- 44. GET /marketplace/listings/:id/similar -- related listings ------------
router.get("/marketplace/listings/:id/similar", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await discovery.similar(id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 45. GET /marketplace/trending -- most-viewed active listings recently ----
router.get("/marketplace/trending", async (req, res): Promise<void> => {
  const { limit = 10 } = req.query as any;
  try {
    res.json(await discovery.trending(Number(limit)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 46. GET /marketplace/categories -- distinct listing types + counts -------
router.get("/marketplace/categories", async (_req, res): Promise<void> => {
  try {
    res.json(await discovery.categories());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- 47. GET /marketplace/listings/featured -- public featured listings shelf -
router.get("/marketplace/listings/featured", async (req, res): Promise<void> => {
  const { limit = 12 } = req.query as any;
  try {
    res.json(await discovery.featured(Number(limit)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
