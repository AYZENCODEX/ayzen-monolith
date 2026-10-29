import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { canCancelGameListing } from "../vault/security/game-ownership";
import {
  listGameMarketListings, createGameMarketListing, buyGameMarketListing, cancelGameMarketListing, getGameMarketStats,
} from "../vault/application/game/marketplace";

/**
 * Game marketplace — HTTP adapter (VLT-GAP-04-B). Every handler only maps the
 * request onto a Vault use-case and sends its `{ status, body }`; wallet,
 * listing and transaction persistence, fee maths and the seller-OR-admin
 * cancel decision (Season C / Phase C5) live in vault/application/game,
 * vault/infrastructure and vault/security. Route table is unchanged.
 */
const router = Router();

// ── GET /marketplace/game/listings ───────────────────────────────────────────
router.get("/marketplace/game/listings", requireAuth, async (req, res): Promise<void> => {
  const out = await listGameMarketListings(req.query);
  res.status(out.status).json(out.body);
});

// ── POST /marketplace/game/listings — create a sell order ───────────────────
router.post("/marketplace/game/listings", requireAuth, async (req, res): Promise<void> => {
  const out = await createGameMarketListing(req.user!.userId, req.body);
  res.status(out.status).json(out.body);
});

// ── POST /marketplace/game/buy ───────────────────────────────────────────────
router.post("/marketplace/game/buy", requireAuth, async (req, res): Promise<void> => {
  const out = await buyGameMarketListing(req.user!.userId, req.body);
  res.status(out.status).json(out.body);
});

// ── DELETE /marketplace/game/listings/:id ────────────────────────────────────
router.delete("/marketplace/game/listings/:id", requireAuth, async (req, res): Promise<void> => {
  const out = await cancelGameMarketListing(req.params.id, (id, listing) => canCancelGameListing(req, id, listing.seller_id));
  res.status(out.status).json(out.body);
});

// ── GET /marketplace/game/stats ──────────────────────────────────────────────
router.get("/marketplace/game/stats", requireAuth, async (_req, res): Promise<void> => {
  const out = await getGameMarketStats();
  res.status(out.status).json(out.body);
});

export default router;
