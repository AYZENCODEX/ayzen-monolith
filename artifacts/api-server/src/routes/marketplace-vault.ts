import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { canCancelVaultListing } from "../vault/security/market-listing-ownership";
import {
  listVaultMarketListings, createVaultMarketListing, buyVaultMarketListing, cancelVaultMarketListing, getVaultMarketStats,
} from "../vault/shared/marketplace/use-cases";

/**
 * Vault market — HTTP adapter (VLT-GAP-13-E). Every handler only maps the request onto a Vault shared
 * use-case and sends its `{ status, body }`; wallet/listing/transaction persistence, ownership checks, fee maths
 * and the seller-OR-admin cancel decision (Season C / Phase C5) live in vault/shared/marketplace,
 * vault/infrastructure and vault/security. Route table is unchanged.
 */
const router = Router();

// ── GET /marketplace/vault/listings ──────────────────────────────────────────
router.get("/marketplace/vault/listings", requireAuth, async (req, res): Promise<void> => {
  const out = await listVaultMarketListings(req.query);
  res.status(out.status).json(out.body);
});

// ── POST /marketplace/vault/listings ─────────────────────────────────────────
router.post("/marketplace/vault/listings", requireAuth, async (req, res): Promise<void> => {
  const out = await createVaultMarketListing(req.user!.userId, req.user!.role, req.body);
  res.status(out.status).json(out.body);
});

// ── POST /marketplace/vault/buy ────────────────────────────────────────────────
router.post("/marketplace/vault/buy", requireAuth, async (req, res): Promise<void> => {
  const out = await buyVaultMarketListing(req.user!.userId, req.body);
  res.status(out.status).json(out.body);
});

// ── DELETE /marketplace/vault/listings/:id ────────────────────────────────────
router.delete("/marketplace/vault/listings/:id", requireAuth, async (req, res): Promise<void> => {
  const out = await cancelVaultMarketListing(req.params.id, (id, listing) => canCancelVaultListing(req, id, listing.seller_id));
  res.status(out.status).json(out.body);
});

// ── GET /marketplace/vault/stats ──────────────────────────────────────────────
router.get("/marketplace/vault/stats", requireAuth, async (_req, res): Promise<void> => {
  const out = await getVaultMarketStats();
  res.status(out.status).json(out.body);
});

export default router;
