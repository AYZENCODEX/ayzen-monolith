import { Router, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireAuth, requireAdmin, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { notifyVerveOrderResolved } from "../lib/notification-bus";
import { DEFAULT_FEE_PCT } from "../marketplace/kernel/domain/fee-policy";
import { feeByProduct } from "../marketplace/kernel/domain/money";
import { adminService } from "../marketplace/admin/application/admin.wired";
import { marketStats } from "../marketplace/analytics/application/market-stats.wired";
import { buildAznChart } from "../marketplace/analytics/domain/azn-chart";
import { listings } from "../marketplace/catalog/application/listings.wired";
import { favorites } from "../marketplace/engagement/application/favorites.wired";

const router = Router();

const PLATFORM_FEE_PCT = DEFAULT_FEE_PCT.p2p; // 5% fee by default

// ── DB init (called from startup migrations in index.ts) ─────────────────────
// Tables created in MIGRATIONS array in index.ts

// ─── GET /marketplace/settings — get fee settings ────────────────────────────
router.get("/marketplace/settings", async (_req, res): Promise<void> => {
  try {
    const row = await adminService.getSettings();
    if (row) { res.json(row); return; }
    res.json({ fee_pct: PLATFORM_FEE_PCT, enabled: true });
  } catch { res.json({ fee_pct: PLATFORM_FEE_PCT, enabled: true }); }
});

// ─── PATCH /marketplace/settings — admin update fee ──────────────────────────
router.patch("/marketplace/settings", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { fee_pct, enabled } = req.body;
  try {
    await adminService.updateSettings({ fee_pct, enabled });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/listings — browse all active listings ──────────────────
router.get("/marketplace/listings", async (req, res): Promise<void> => {
  const { type, limit = 50, offset = 0 } = req.query as any;
  try {
    const r = await listings.list({ type, limit, offset });
    res.json({ listings: r.listings, total: r.total });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/listings/:id — single listing detail (public) ─────────
router.get("/marketplace/listings/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await listings.detail(id);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.json({ ...r.listing, platform_pricing: r.platformPricing });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/my-listings — user's own listings ──────────────────────
router.get("/marketplace/my-listings", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await listings.mine(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/listings — create a listing ───────────────────────────
router.post("/marketplace/listings", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { listing_type, item_id, title, description, price_azn, metadata, image_url, condition, tags, listing_expires_at } = req.body;

  if (!listing_type || !title || !price_azn) {
    res.status(400).json({ error: "listing_type, title, price_azn required" }); return;
  }

  const validTypes = ["entity", "local_account", "nft", "azn", "username_nft", "badge_nft"];
  if (!validTypes.includes(listing_type)) {
    res.status(400).json({ error: `listing_type must be one of: ${validTypes.join(", ")}` }); return;
  }

  try {
    const userRow = await pool.query("SELECT username FROM users WHERE id=$1", [userId]);
    const username = userRow.rows[0]?.username ?? "user";

    const r = await pool.query(
      `INSERT INTO marketplace_listings
        (seller_id, listing_type, item_id, title, description, price_azn, metadata, status, image_url, condition, tags, listing_expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,NOW(),NOW())
       RETURNING *`,
      [userId, listing_type, item_id || null, title, description || null, Number(price_azn),
        JSON.stringify(metadata || {}), image_url || null, condition || "good", tags || null,
        listing_expires_at || null]
    );

    await pool.query(
      `INSERT INTO marketplace_activity_log (event_type, actor_id, actor_username, target_id, target_type, title, amount_azn, status)
       VALUES ('listing_created', $1, $2, $3, $4, $5, $6, 'active')`,
      [userId, username, r.rows[0].id, listing_type, title, Number(price_azn)]
    ).catch(() => {});

    res.status(201).json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /marketplace/listings/:id — edit own active listing ──────────────
// ─── Route Integration Roadmap — Season C, Phase C16 (mechanical sweep,
// batch 16: marketplace.ts) ──────────────────────────────────────────────
// Another file outside the original audit's inventory, same fresh-sweep
// discovery as C15's local-accounts.ts. This file uses raw `pool.query`
// (node-postgres) throughout rather than Drizzle or even `db.execute`, so
// the resource lookups below match that style for consistency with the
// rest of the file — no new dependency, no new query style introduced.
//
// `marketplace_listings` has one owner column (`seller_id`) — a plain
// single-owner resource, same shape as everywhere else in this series.
//
// `marketplace_orders` is different: BOTH the buyer and the seller are
// legitimate parties to an order, but which one actually gets to act
// depends on the route. `GET /orders/:id` and `GET /orders/:id/receipt`
// let EITHER party view (existing query: `buyer_id=$2 OR seller_id=$2`);
// `POST /orders/:id/confirm` and `POST /orders/:id/dispute` are
// buyer-only actions. `createResourceOwnershipRule()` only ever compares
// one `resource.ownerId` to `subject.userId` — it has no OR-of-two-owners
// concept. Two different resource builders for the same table encode
// this instead of forcing a shape the rule doesn't have:
//   - `marketplaceOrderBuyerResource` — ownerId is literally `buyer_id`,
//     for the two buyer-only actions.
//   - `marketplaceOrderPartyResource` — since the rule only ever checks
//     "does ownerId === the CURRENT subject's own userId", this builder
//     does the OR-check itself (buyer_id === userId || seller_id ===
//     userId) and reports ownerId as that SAME userId when either side
//     matches (or a sentinel when neither does) — a legitimate way to
//     express "the caller is a party to this order" through a rule whose
//     contract is only ever a single equality check, not a hack around it.
const MARKETPLACE_LISTING_OWNER_SENTINEL_NONE = -1;
// Exported (Route Integration Roadmap, Season E, Phase E6) so
// marketplace-offers.ts's `GET /marketplace/listings/:id/offers` — same
// `marketplace_listings` table, same `seller_id` owner column, previously
// left raw-SQL-scoped-only when this file's own listing routes were gated
// (Phase C16) — can reuse this instead of hand-rolling a second copy. Same
// reuse precedent as `kyc.ts`'s `kycEntryResource` (see that file's own
// comment) and `vault-entity-links.ts`'s `vaultEntryResource`.
export const marketplaceListingResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_listing", id: req.params.id, ownerId: MARKETPLACE_LISTING_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT seller_id FROM marketplace_listings WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_listing", id, ownerId: rows[0]?.seller_id ?? MARKETPLACE_LISTING_OWNER_SENTINEL_NONE };
};
export function requireMarketplaceListingOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, marketplaceListingResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

const MARKETPLACE_ORDER_OWNER_SENTINEL_NONE = -1;
const marketplaceOrderBuyerResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return { type: "marketplace_order", id: req.params.id, ownerId: MARKETPLACE_ORDER_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT buyer_id FROM marketplace_orders WHERE id=$1 LIMIT 1", [id]);
  return { type: "marketplace_order", id, ownerId: rows[0]?.buyer_id ?? MARKETPLACE_ORDER_OWNER_SENTINEL_NONE };
};
const marketplaceOrderPartyResource: ResourceRefBuilder = async (req: Request) => {
  const id = Number(req.params.id);
  const userId = req.user?.userId;
  if (!Number.isFinite(id) || userId === undefined) return { type: "marketplace_order", id: req.params.id, ownerId: MARKETPLACE_ORDER_OWNER_SENTINEL_NONE };
  const { rows } = await pool.query("SELECT buyer_id, seller_id FROM marketplace_orders WHERE id=$1 LIMIT 1", [id]);
  const row = rows[0];
  const isParty = !!row && (row.buyer_id === userId || row.seller_id === userId);
  return { type: "marketplace_order", id, ownerId: isParty ? userId : MARKETPLACE_ORDER_OWNER_SENTINEL_NONE };
};
function requireMarketplaceOrderOwnership(resource: ResourceRefBuilder, action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, resource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.status(404).json(notFoundBody); },
  });
}

router.patch("/marketplace/listings/:id", requireAuth, requireMarketplaceListingOwnership("marketplace_listing.update", { error: "Listing not found, not yours, or no longer active" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { title, description, price_azn, image_url, condition, tags, listing_expires_at } = req.body;

  const sets: string[] = [];
  const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (title !== undefined) push("title", title);
  if (description !== undefined) push("description", description);
  if (price_azn !== undefined) push("price_azn", Number(price_azn));
  if (image_url !== undefined) push("image_url", image_url);
  if (condition !== undefined) push("condition", condition);
  if (tags !== undefined) push("tags", tags);
  if (listing_expires_at !== undefined) push("listing_expires_at", listing_expires_at);
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push("updated_at=NOW()");

  try {
    params.push(id, userId);
    const r = await pool.query(
      `UPDATE marketplace_listings SET ${sets.join(", ")}
       WHERE id=$${params.length - 1} AND seller_id=$${params.length} AND status='active'
       RETURNING *`,
      params
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Listing not found, not yours, or no longer active" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /marketplace/listings/:id/platform-pricing — seller sets per-platform prices ──
// body: { pricing: [{ platform: "discord", price_azn: 120 }, ...] } — replaces the full set.
router.put("/marketplace/listings/:id/platform-pricing", requireAuth, requireMarketplaceListingOwnership("marketplace_listing.platform_pricing.update", { error: "Listing not found, not yours, or no longer active" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const { pricing } = req.body;
  if (!Array.isArray(pricing) || pricing.length === 0) {
    res.status(400).json({ error: "pricing must be a non-empty array of { platform, price_azn }" }); return;
  }
  for (const p of pricing) {
    if (!p.platform || typeof p.price_azn !== "number" || p.price_azn <= 0) {
      res.status(400).json({ error: "Each pricing entry needs a platform and a positive price_azn" }); return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ownR = await client.query("SELECT id FROM marketplace_listings WHERE id=$1 AND seller_id=$2 AND status='active'", [listingId, userId]);
    if (ownR.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Listing not found, not yours, or no longer active" }); return;
    }
    await client.query("DELETE FROM marketplace_listing_platform_pricing WHERE listing_id=$1", [listingId]);
    for (const p of pricing) {
      await client.query(
        `INSERT INTO marketplace_listing_platform_pricing (listing_id, platform, price_azn, created_at, updated_at)
         VALUES ($1,$2,$3,NOW(),NOW())`,
        [listingId, p.platform, p.price_azn]
      );
    }
    await client.query("COMMIT");
    const r = await pool.query("SELECT platform, price_azn FROM marketplace_listing_platform_pricing WHERE listing_id=$1 ORDER BY platform", [listingId]);
    res.json({ listing_id: listingId, platform_pricing: r.rows });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /marketplace/listings/:id/platform-pricing/:platform — remove one price ──
router.delete("/marketplace/listings/:id/platform-pricing/:platform", requireAuth, requireMarketplaceListingOwnership("marketplace_listing.platform_pricing.delete", { error: "Listing not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const platform = req.params.platform;
  try {
    const ownR = await pool.query("SELECT id FROM marketplace_listings WHERE id=$1 AND seller_id=$2", [listingId, userId]);
    if (ownR.rows.length === 0) { res.status(404).json({ error: "Listing not found or not yours" }); return; }
    await pool.query("DELETE FROM marketplace_listing_platform_pricing WHERE listing_id=$1 AND platform=$2", [listingId, platform]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /marketplace/listings/:id — cancel own listing ───────────────────
router.delete("/marketplace/listings/:id", requireAuth, requireMarketplaceListingOwnership("marketplace_listing.delete", { error: "Listing not found or not yours" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE marketplace_listings SET status='cancelled', updated_at=NOW() WHERE id=$1 AND seller_id=$2 AND status='active' RETURNING id",
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Listing not found or not yours" }); return; }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/listings/:id/buy — place buy order ────────────────────
router.post("/marketplace/listings/:id/buy", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  const { message } = req.body;

  try {
    const listingR = await pool.query("SELECT * FROM marketplace_listings WHERE id=$1 AND status='active'", [listingId]);
    if (listingR.rows.length === 0) { res.status(404).json({ error: "Listing not found or no longer active" }); return; }
    const listing = listingR.rows[0];
    if (listing.seller_id === userId) { res.status(400).json({ error: "Cannot buy your own listing" }); return; }

    // Check buyer has enough AZN
    const credR = await pool.query("SELECT azn_balance FROM credits WHERE user_id=$1", [userId]);
    const buyerAzn = credR.rows[0]?.azn_balance ?? 0;
    if (buyerAzn < listing.price_azn) {
      res.status(400).json({ error: `Insufficient AZN balance. Need ${listing.price_azn} AZN, have ${buyerAzn.toFixed(2)} AZN` }); return;
    }

    // Create order (pending admin approval)
    const orderR = await pool.query(
      `INSERT INTO marketplace_orders
        (listing_id, buyer_id, seller_id, price_azn, fee_pct, status, message, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,NOW(),NOW()) RETURNING *`,
      [listingId, userId, listing.seller_id, listing.price_azn, PLATFORM_FEE_PCT, message || null]
    );

    // Reserve AZN from buyer (escrow — deduct now, refund on reject)
    await pool.query(
      "UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2",
      [listing.price_azn, userId]
    );

    res.status(201).json({ order: orderR.rows[0], message: "Order placed. Pending admin approval." });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/orders/my — buyer's orders ─────────────────────────────
router.get("/marketplace/orders/my", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, ml.description, ml.metadata,
              su.username as seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.buyer_id = $1
       ORDER BY mo.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/orders/sales — seller's orders ────────────────────────
router.get("/marketplace/orders/sales", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, bu.username as buyer_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       WHERE mo.seller_id = $1
       ORDER BY mo.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/orders/:id — single order detail (buyer or seller) ────
router.get("/marketplace/orders/:id", requireAuth, requireMarketplaceOrderOwnership(marketplaceOrderPartyResource, "marketplace_order.read", { error: "Order not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, ml.description, ml.metadata,
              bu.username as buyer_username, su.username as seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.id = $1 AND (mo.buyer_id = $2 OR mo.seller_id = $2)`,
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Order not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Map a sidebar tab name to the underlying order statuses it covers.
const TAB_STATUS: Record<string, string[]> = {
  ongoing: ["pending"],
  paid: ["approved"],
  completed: ["completed"],
  disputed: ["disputed"],
};

// ─── GET /marketplace/orders/tab/:tab — buyer's orders for a sidebar tab ────
router.get("/marketplace/orders/tab/:tab", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const tab = req.params.tab as string;
  const statuses = TAB_STATUS[tab];
  if (!statuses) { res.status(400).json({ error: `tab must be one of: ${Object.keys(TAB_STATUS).join(", ")}` }); return; }
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, ml.image_url, su.username as seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.buyer_id = $1 AND mo.status = ANY($2)
       ORDER BY mo.created_at DESC`,
      [userId, statuses]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/orders/sales/tab/:tab — seller's sales for a sidebar tab ─
router.get("/marketplace/orders/sales/tab/:tab", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const tab = req.params.tab as string;
  const statuses = TAB_STATUS[tab];
  if (!statuses) { res.status(400).json({ error: `tab must be one of: ${Object.keys(TAB_STATUS).join(", ")}` }); return; }
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, ml.image_url, bu.username as buyer_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       WHERE mo.seller_id = $1 AND mo.status = ANY($2)
       ORDER BY mo.created_at DESC`,
      [userId, statuses]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/orders/:id/confirm — buyer confirms receipt ──────────
// Moves an 'approved' (paid) order to 'completed'. Only the buyer can confirm.
router.post("/marketplace/orders/:id/confirm", requireAuth, requireMarketplaceOrderOwnership(marketplaceOrderBuyerResource, "marketplace_order.confirm", { error: "Order not found, not yours, or not in a confirmable state" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `UPDATE marketplace_orders SET status='completed', confirmed_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND buyer_id=$2 AND status='approved' RETURNING *`,
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Order not found, not yours, or not in a confirmable state" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/orders/:id/dispute — buyer raises a dispute ──────────
router.post("/marketplace/orders/:id/dispute", requireAuth, requireMarketplaceOrderOwnership(marketplaceOrderBuyerResource, "marketplace_order.dispute", { error: "Order not found, not yours, or cannot be disputed" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const { reason } = req.body;
  if (!reason) { res.status(400).json({ error: "reason is required" }); return; }
  try {
    const r = await pool.query(
      `UPDATE marketplace_orders SET status='disputed', dispute_reason=$1, disputed_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND buyer_id=$3 AND status IN ('pending','approved') RETURNING *`,
      [reason, id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Order not found, not yours, or cannot be disputed" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: GET /admin/marketplace/orders/disputed — disputed orders queue ──
router.get("/admin/marketplace/orders/disputed", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, bu.username as buyer_username, su.username as seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.status = 'disputed'
       ORDER BY mo.disputed_at ASC`
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PATCH /admin/marketplace/orders/:id/resolve-dispute ─────────────
// action: "refund" (send AZN back to buyer, listing stays active) | "complete" (force-complete, seller gets paid)
router.patch("/admin/marketplace/orders/:id/resolve-dispute", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { action, admin_note } = req.body;
  if (!["refund", "complete"].includes(action)) { res.status(400).json({ error: "action must be 'refund' or 'complete'" }); return; }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderR = await client.query("SELECT * FROM marketplace_orders WHERE id=$1 AND status='disputed' FOR UPDATE", [id]);
    if (orderR.rows.length === 0) { await client.query("ROLLBACK"); res.status(404).json({ error: "Disputed order not found" }); return; }
    const order = orderR.rows[0];

    if (action === "refund") {
      await client.query("UPDATE credits SET azn_balance = azn_balance + $1, updated_at=NOW() WHERE user_id=$2", [order.price_azn, order.buyer_id]);
      await client.query(
        "UPDATE marketplace_orders SET status='rejected', admin_note=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2",
        [admin_note || "Dispute resolved: refunded", id]
      );
    } else {
      const feePct = order.fee_pct ?? PLATFORM_FEE_PCT;
      const feeAzn = feeByProduct(order.price_azn, feePct);
      const sellerReceives = order.price_azn - feeAzn;
      await client.query(
        "INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent) VALUES ($1,0,$2,0,0) ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2, updated_at=NOW()",
        [order.seller_id, sellerReceives]
      );
      await client.query(
        "UPDATE marketplace_orders SET status='completed', fee_azn=$1, seller_receives=$2, admin_note=$3, resolved_at=NOW(), confirmed_at=NOW(), updated_at=NOW() WHERE id=$4",
        [feeAzn, sellerReceives, admin_note || "Dispute resolved: force-completed", id]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, action });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── ADMIN: GET /admin/marketplace/orders — all orders ───────────────────────
router.get("/admin/marketplace/orders", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { status, limit = 50, offset = 0 } = req.query as any;
  try {
    let q = `
      SELECT mo.*, ml.title, ml.listing_type, ml.metadata,
             bu.username as buyer_username, su.username as seller_username
      FROM marketplace_orders mo
      JOIN marketplace_listings ml ON ml.id = mo.listing_id
      LEFT JOIN users bu ON bu.id = mo.buyer_id
      LEFT JOIN users su ON su.id = mo.seller_id
    `;
    const params: any[] = [];
    if (status) { q += ` WHERE mo.status = $${params.length + 1}`; params.push(status); }
    q += ` ORDER BY mo.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const r = await pool.query(q, params);

    const countQ = `SELECT COUNT(*) FROM marketplace_orders${status ? " WHERE status=$1" : ""}`;
    const countR = await pool.query(countQ, status ? [status] : []);

    res.json({ orders: r.rows, total: Number(countR.rows[0].count) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: GET /admin/marketplace/orders/:id — single order detail ──────────
router.get("/admin/marketplace/orders/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT mo.*, ml.title, ml.listing_type, ml.metadata, ml.status AS listing_status,
              bu.username AS buyer_username, su.username AS seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.id = $1`,
      [id]
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Order not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PATCH /admin/marketplace/orders/:id/edit — adjust a pending order ─
// Distinct from the approve/reject action route below — this only edits the
// order's own fields (price/fee/notes) and never touches status, credits, or
// the listing. Locked to status='pending' so an already-settled order (which
// already moved AZN) can't be silently altered after the fact.
router.patch("/admin/marketplace/orders/:id/edit", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { price_azn, fee_pct, message, admin_note } = req.body as {
    price_azn?: number; fee_pct?: number; message?: string; admin_note?: string;
  };
  try {
    const orderR = await pool.query("SELECT * FROM marketplace_orders WHERE id=$1", [id]);
    if (!orderR.rows[0]) { res.status(404).json({ error: "Order not found" }); return; }
    if (orderR.rows[0].status !== "pending") {
      res.status(400).json({ error: `Cannot edit a ${orderR.rows[0].status} order — only pending orders are editable` });
      return;
    }
    if (price_azn !== undefined && Number(price_azn) <= 0) { res.status(400).json({ error: "price_azn must be positive" }); return; }
    if (fee_pct !== undefined && (Number(fee_pct) < 0 || Number(fee_pct) > 100)) { res.status(400).json({ error: "fee_pct must be between 0 and 100" }); return; }

    const r = await pool.query(
      `UPDATE marketplace_orders
       SET price_azn = COALESCE($1, price_azn), fee_pct = COALESCE($2, fee_pct),
           message = COALESCE($3, message), admin_note = COALESCE($4, admin_note),
           updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [price_azn ?? null, fee_pct ?? null, message ?? null, admin_note ?? null, id]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: POST /admin/marketplace/orders — manually place an order ─────────
// Same escrow-then-pending flow as the buyer-initiated
// POST /marketplace/listings/:id/buy above, minus the ownership check on
// req.user (an admin places this on a buyer's behalf — e.g. finishing a
// support-desk sale) and with an admin-settable price override for listings
// where the agreed price differs from the sticker price.
router.post("/admin/marketplace/orders", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { listing_id, buyer_id, price_azn, message } = req.body as {
    listing_id?: number; buyer_id?: number; price_azn?: number; message?: string;
  };
  if (!listing_id || !buyer_id) { res.status(400).json({ error: "listing_id and buyer_id are required" }); return; }
  try {
    const listingR = await pool.query("SELECT * FROM marketplace_listings WHERE id=$1 AND status='active'", [listing_id]);
    if (!listingR.rows[0]) { res.status(404).json({ error: "Listing not found or no longer active" }); return; }
    const listing = listingR.rows[0];
    if (listing.seller_id === Number(buyer_id)) { res.status(400).json({ error: "Buyer cannot be the seller" }); return; }

    const buyerR = await pool.query("SELECT id, username FROM users WHERE id=$1", [buyer_id]);
    if (!buyerR.rows[0]) { res.status(404).json({ error: "Buyer not found" }); return; }

    const effectivePrice = price_azn !== undefined && Number(price_azn) > 0 ? Number(price_azn) : Number(listing.price_azn);

    const credR = await pool.query("SELECT azn_balance FROM credits WHERE user_id=$1", [buyer_id]);
    const buyerAzn = credR.rows[0]?.azn_balance ?? 0;
    if (buyerAzn < effectivePrice) {
      res.status(400).json({ error: `Buyer has insufficient AZN balance. Need ${effectivePrice}, has ${Number(buyerAzn).toFixed(2)}` });
      return;
    }

    const orderR = await pool.query(
      `INSERT INTO marketplace_orders
        (listing_id, buyer_id, seller_id, price_azn, fee_pct, status, message, admin_note, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,NOW(),NOW()) RETURNING *`,
      [listing_id, buyer_id, listing.seller_id, effectivePrice, PLATFORM_FEE_PCT, message || null, "Created manually by admin"]
    );

    await pool.query(
      "UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2",
      [effectivePrice, buyer_id]
    );

    res.status(201).json(orderR.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: GET /admin/marketplace/listings — all listings ───────────────────
router.get("/admin/marketplace/listings", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  try {
    res.json(await listings.adminList());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PATCH /admin/marketplace/orders/:id — approve or reject ──────────
router.patch("/admin/marketplace/orders/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { action, admin_note } = req.body; // action: "approve" | "reject"

  if (!["approve", "reject"].includes(action)) {
    res.status(400).json({ error: "action must be 'approve' or 'reject'" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderR = await client.query("SELECT * FROM marketplace_orders WHERE id=$1 FOR UPDATE", [id]);
    if (orderR.rows.length === 0) { res.status(404).json({ error: "Order not found" }); return; }
    const order = orderR.rows[0];

    if (order.status !== "pending") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Order already ${order.status}` }); return;
    }

    if (action === "reject") {
      // Refund AZN to buyer
      await client.query(
        "UPDATE credits SET azn_balance = azn_balance + $1, updated_at=NOW() WHERE user_id=$2",
        [order.price_azn, order.buyer_id]
      );
      await client.query(
        "UPDATE marketplace_orders SET status='rejected', admin_note=$1, resolved_at=NOW(), updated_at=NOW() WHERE id=$2",
        [admin_note || null, id]
      );
    } else {
      // Approve: calculate fee, pay seller net amount
      const feePct = order.fee_pct ?? PLATFORM_FEE_PCT;
      const feeAzn = feeByProduct(order.price_azn, feePct);
      const sellerReceives = order.price_azn - feeAzn;

      // Pay seller
      await client.query(
        "INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent) VALUES ($1,0,$2,0,0) ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2, updated_at=NOW()",
        [order.seller_id, sellerReceives]
      );

      // Mark listing as sold
      await client.query(
        "UPDATE marketplace_listings SET status='sold', buyer_id=$1, sold_at=NOW(), updated_at=NOW() WHERE id=$2",
        [order.buyer_id, order.listing_id]
      );

      await client.query(
        "UPDATE marketplace_orders SET status='approved', fee_azn=$1, seller_receives=$2, admin_note=$3, resolved_at=NOW(), updated_at=NOW() WHERE id=$4",
        [feeAzn, sellerReceives, admin_note || null, id]
      );

      // Record platform fee transaction
      await client.query(
        `INSERT INTO credit_transactions (user_id, type, azn_amount, notes, status, created_at, updated_at)
         VALUES ($1, 'marketplace_fee', $2, 'P2P marketplace fee', 'completed', NOW(), NOW())`,
        [order.seller_id, feeAzn]
      );
    }

    await client.query("COMMIT");

    // Notify buyer and seller
    const notifMsg = action === "approve"
      ? `Your order has been approved!`
      : `Your order was rejected.${admin_note ? ` Reason: ${admin_note}` : ""}`;

    // Phase 7 — Notification Bus. Previously a raw `INSERT INTO
    // notifications` here, in-app-only. Replaced (not duplicated — the bus's
    // own in-app channel writes to the same `notifications` table, so
    // keeping both would double-notify the buyer) with the bus call below,
    // which additionally routes through Telegram/email/Astra per the
    // buyer's notification_preferences.
    notifyVerveOrderResolved(order.buyer_id, action, notifMsg).catch(() => {});

    res.json({ ok: true, action });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── GET /marketplace/vault-items — user's vault items available to sell ─────
router.get("/marketplace/vault-items", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const [entities, localAccounts] = await Promise.all([
      pool.query(
        `SELECT id, project_name as name, category, 'entity' as item_type, entity_serial, notes
         FROM vault_entries WHERE user_id = $1 ORDER BY project_name`,
        [userId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT id, username, category as platform_name, 'local_account' as item_type, notes
         FROM local_accounts WHERE user_id = $1 ORDER BY username`,
        [userId]
      ).catch(() => ({ rows: [] })),
    ]);
    res.json({
      entities: entities.rows,
      local_accounts: localAccounts.rows,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// FAVORITES / WISHLIST
// ══════════════════════════════════════════════════════════════════════════

// ─── GET /marketplace/favorites — user's favorited listings ─────────────────
router.get("/marketplace/favorites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    res.json(await favorites.list(userId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/listings/:id/favorite — add to favorites ─────────────
router.post("/marketplace/listings/:id/favorite", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  try {
    const r = await favorites.add(userId, listingId);
    if (!r.ok) { res.status(404).json({ error: r.error }); return; }
    res.status(201).json(r.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /marketplace/listings/:id/favorite — remove from favorites ──────
router.delete("/marketplace/listings/:id/favorite", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const listingId = Number(req.params.id);
  try {
    await favorites.remove(userId, listingId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// SEARCH & DISCOVERY
// ══════════════════════════════════════════════════════════════════════════

// ─── GET /marketplace/search — filtered listing search ──────────────────────
router.get("/marketplace/search", async (req, res): Promise<void> => {
  const { q, type, min_price, max_price, condition, limit = 50, offset = 0 } = req.query as any;
  try {
    const r = await listings.search({ q, type, min_price, max_price, condition, limit, offset });
    res.json({ listings: r.listings, count: r.count });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/listings/:id/history — activity log for one listing ───
router.get("/marketplace/listings/:id/history", async (req, res): Promise<void> => {
  const listingId = Number(req.params.id);
  try {
    res.json(await listings.history(listingId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── ADMIN: PATCH /admin/marketplace/listings/:id/feature — feature/promote ─
router.patch("/admin/marketplace/listings/:id/feature", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { is_featured } = req.body;
  try {
    const r = await pool.query(
      "UPDATE marketplace_listings SET is_featured=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [is_featured !== false, id]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /marketplace/listings/:id/boost — self-serve credit-funded boost ──
// PHASE 5: the seller-facing half of "Verve | Boosted/promoted listings" in
// the master plan's §5 metered-actions table. The admin PATCH above is the
// permanent/manual toggle (unpaid, ops-only, no expiry); this is a seller
// spending verve.boosted_listing credits to feature their OWN active
// listing for a fixed window. Distinct from admin feature so a boosted
// listing naturally rotates off the shelf instead of staying featured
// forever off one payment — see `featured_until` on marketplace_listings.
const BOOST_DURATION_DAYS = 7;
// Enforcement Roadmap, Track H, Phase H2 (burn-down, marketplace): this route
// was added after Phase C16 gated the rest of the listing routes, and only
// ever had the handler's own inline `row.seller_id !== userId` check. Same
// `marketplace_listings.seller_id` owner column, same builder as C16 —
// `marketplaceListingResource` — so this adds the PDP-routed check (and its
// audit-log entry) without a second builder. Behavior is PRESERVED exactly,
// per OWNERSHIP_GATING_GUIDE.md's "Choosing onDeny" rule: a nonexistent /
// malformed id stays `404 "Listing not found"`, an existing listing that
// isn't the caller's stays `403 "You can only boost your own listings"`.
// `marketplaceListingResource` already distinguishes the two without a new
// sentinel: not-found/malformed -> ownerId === MARKETPLACE_LISTING_OWNER_
// SENTINEL_NONE, someone else's listing -> ownerId === that seller's real id.
// Ordered AFTER requireCreditBalance so a caller with no credits still sees
// the same 402 before any 404/403, exactly as before. The handler's own
// inline check is left in place (defense in depth; cheap, and it keeps the
// status-must-be-active check next to it readable).
function requireBoostListingOwnership() {
  return requireOwnership("marketplace_listing.boost", marketplaceListingResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response, _next: NextFunction, outcome) => {
      const deniedOwnerId = outcome?.request?.resource?.ownerId;
      if (deniedOwnerId === MARKETPLACE_LISTING_OWNER_SENTINEL_NONE) {
        res.status(404).json({ error: "Listing not found" });
      } else {
        res.status(403).json({ error: "You can only boost your own listings" });
      }
    },
  });
}
router.post("/marketplace/listings/:id/boost", requireAuth, requireCreditBalance("verve.boosted_listing"), requireBoostListingOwnership(), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const listing = await pool.query(
      "SELECT id, seller_id, status, title FROM marketplace_listings WHERE id=$1",
      [id]
    );
    if (listing.rows.length === 0) { res.status(404).json({ error: "Listing not found" }); return; }
    const row = listing.rows[0];
    if (row.seller_id !== userId) { res.status(403).json({ error: "You can only boost your own listings" }); return; }
    if (row.status !== "active") { res.status(400).json({ error: "Only active listings can be boosted" }); return; }

    // Charge-on-success (services/credit-meter.ts): confirm the listing is
    // really boostable BEFORE charging, so a 404/403/400 above never costs
    // credits — the balance check from requireCreditBalance only told us
    // the user *could* afford it, not that this specific listing qualifies.
    const charge = await chargeCredits(userId, "verve.boosted_listing");
    if (!charge.ok) {
      res.status(402).json({
        error: "Out of credits", code: "OUT_OF_CREDITS",
        action: "verve.boosted_listing", cost: charge.cost, balance: charge.balance,
        topUp: { method: "POST", url: "/api/credits/purchase" },
      });
      return;
    }

    const featuredUntil = new Date(Date.now() + BOOST_DURATION_DAYS * 24 * 60 * 60 * 1000);
    const updated = await pool.query(
      "UPDATE marketplace_listings SET is_featured=TRUE, featured_until=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
      [featuredUntil, id]
    );

    const userRow = await pool.query("SELECT username FROM users WHERE id=$1", [userId]);
    await pool.query(
      `INSERT INTO marketplace_activity_log (event_type, actor_id, actor_username, target_id, target_type, title, status)
       VALUES ('listing_boosted', $1, $2, $3, $4, $5, 'active')`,
      [userId, userRow.rows[0]?.username ?? "user", id, "listing", row.title]
    ).catch(() => {});

    res.json({ success: true, listing: updated.rows[0], featuredUntil, creditsCharged: charge.charged, newCreditBalance: charge.newBalance });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /admin/marketplace/activity — marketplace activity log ───────────────
router.get("/admin/marketplace/activity", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { event_type, limit = 50, offset = 0 } = req.query as any;
  try {
    const r = await adminService.activityLog({ event_type, limit, offset });
    res.json({ entries: r.entries, total: r.total });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── 50. GET /marketplace/orders/:id/receipt — printable receipt data ────────
router.get("/marketplace/orders/:id/receipt", requireAuth, requireMarketplaceOrderOwnership(marketplaceOrderPartyResource, "marketplace_order.receipt.read", { error: "Order not found" }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      `SELECT mo.id as order_id, mo.price_azn, mo.fee_pct, mo.fee_azn, mo.seller_receives, mo.status,
              mo.created_at as ordered_at, mo.resolved_at, mo.confirmed_at,
              ml.title, ml.listing_type, ml.description,
              bu.username as buyer_username, su.username as seller_username
       FROM marketplace_orders mo
       JOIN marketplace_listings ml ON ml.id = mo.listing_id
       LEFT JOIN users bu ON bu.id = mo.buyer_id
       LEFT JOIN users su ON su.id = mo.seller_id
       WHERE mo.id = $1 AND (mo.buyer_id = $2 OR mo.seller_id = $2)`,
      [id, userId]
    );
    if (r.rows.length === 0) { res.status(404).json({ error: "Order not found" }); return; }
    res.json({ receipt_id: `AYZEN-${r.rows[0].order_id}`, generated_at: new Date().toISOString(), ...r.rows[0] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/stats — public stats ────────────────────────────────────
router.get("/marketplace/stats", async (_req, res): Promise<void> => {
  try {
    res.json(await marketStats.platform());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /marketplace/azn/chart — AZN price chart data ───────────────────────
router.get("/marketplace/azn/chart", async (_req, res): Promise<void> => {
  try {
    // SYNTHETIC data (see marketplace/analytics/domain/azn-chart.ts), not a market price; only the last point is random.
    const chart = buildAznChart(new Date(), Math.random);
    res.json({ base_usd: chart.base_usd, azn_per_usd: chart.azn_per_usd, data: chart.data });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
