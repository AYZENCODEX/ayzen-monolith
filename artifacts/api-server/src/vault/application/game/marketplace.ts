import { getMarketConfig } from "../../../lib/market-config";
import {
  selectGameListings, countActiveGameListings, insertGameListing, findActiveGameListingById,
  ensureGameWallet, completeGameListingPurchase, cancelGameListing, selectGameMarketplaceStats,
} from "../../infrastructure/repositories/game-repository";

/**
 * Game marketplace boundary use-cases. Bodies extracted from the handlers of
 * routes/marketplace-game.ts (VLT-GAP-04-B): same validation order, same
 * wallet/listing/transaction persistence in the same order, same fee maths,
 * same status codes and response bodies. Persistence (incl. the purchase
 * transaction) lives in game-repository; the seller-OR-admin cancel decision
 * stays in vault/security/game-ownership and is injected as `authorize`
 * because it needs the request's subject.
 */

export type UseCaseResult = { status: number; body: unknown };

const err500 = (e: any): UseCaseResult => ({ status: 500, body: { error: e.message } });

export function parseListing(row: any) {
  return {
    ...row,
    photos: row.photos ? JSON.parse(row.photos) : [],
    details: row.details ? JSON.parse(row.details) : {},
  };
}

// ── GET /marketplace/game/listings ───────────────────────────────────────────
export async function listGameMarketListings(q: any): Promise<UseCaseResult> {
  const { limit = 50, offset = 0, platform, game_name, min_price, max_price } = q;
  try {
    const r = await selectGameListings({ limit: Number(limit), offset: Number(offset), platform, game_name, min_price, max_price });
    const cnt = await countActiveGameListings();
    const { feePct } = await getMarketConfig("game");
    return { status: 200, body: { listings: r.rows.map(parseListing), total: Number(cnt.rows[0].count), fee_pct: feePct } };
  } catch (e: any) { return err500(e); }
}

// ── POST /marketplace/game/listings — create a sell order ───────────────────
export async function createGameMarketListing(sellerId: number, body: any): Promise<UseCaseResult> {
  const { game_name, title, description, price, platform = "pc", photos = [], details = {} } = body;
  if (!game_name || !String(game_name).trim()) return { status: 400, body: { error: "game_name required" } };
  if (!title || !String(title).trim()) return { status: 400, body: { error: "title required" } };
  if (!price || Number(price) <= 0) return { status: 400, body: { error: "valid price required" } };
  if (!Array.isArray(photos)) return { status: 400, body: { error: "photos must be an array" } };
  const { enabled } = await getMarketConfig("game");
  if (!enabled) return { status: 403, body: { error: "Game Market is currently disabled" } };
  try {
    const r = await insertGameListing(sellerId, {
      game_name: String(game_name).trim(),
      title: String(title).trim(),
      description: description ? String(description).trim() : null,
      price: Number(price),
      platform,
      photos,
      details,
    });
    return { status: 200, body: parseListing(r.rows[0]) };
  } catch (e: any) { return err500(e); }
}

// ── POST /marketplace/game/buy ───────────────────────────────────────────────
export async function buyGameMarketListing(buyerId: number, body: any): Promise<UseCaseResult> {
  const { listing_id } = body;
  if (!listing_id) return { status: 400, body: { error: "listing_id required" } };
  try {
    const listR = await findActiveGameListingById(listing_id);
    if (!listR.rows[0]) return { status: 404, body: { error: "Listing not found or already sold" } };
    const listing = listR.rows[0];
    if (listing.seller_id === buyerId) return { status: 400, body: { error: "Cannot buy your own listing" } };
    const balance = await ensureGameWallet(buyerId);
    if (balance < Number(listing.price)) return { status: 400, body: { error: "Insufficient game wallet balance" } };
    const { feePct } = await getMarketConfig("game");
    const fee = Number(listing.price) * (feePct / 100);
    const net = Number(listing.price) - fee;
    const done = await completeGameListingPurchase(listing_id, buyerId, listing, fee, net);
    if (!done.ok) {
      return done.reason === "insufficient-balance"
        ? { status: 400, body: { error: "Insufficient game wallet balance" } }
        : { status: 409, body: { error: "Listing was already sold or cancelled" } };
    }
    return { status: 200, body: { ok: true, title: listing.title, price: Number(listing.price), fee, net } };
  } catch (e: any) { return err500(e); }
}

// ── DELETE /marketplace/game/listings/:id ────────────────────────────────────
export async function cancelGameMarketListing(
  idParam: unknown,
  authorizeCancel: (id: any, listing: any) => Promise<boolean>,
): Promise<UseCaseResult> {
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  try {
    const r = await findActiveGameListingById(id);
    if (!r.rows[0]) return { status: 404, body: { error: "Not found" } };
    const listing = r.rows[0];
    if (!(await authorizeCancel(id, listing))) return { status: 403, body: { error: "Forbidden" } };
    await cancelGameListing(id);
    return { status: 200, body: { ok: true } };
  } catch (e: any) { return err500(e); }
}

// ── GET /marketplace/game/stats ──────────────────────────────────────────────
export async function getGameMarketStats(): Promise<UseCaseResult> {
  try {
    const [active, volume] = await selectGameMarketplaceStats();
    const { feePct } = await getMarketConfig("game");
    return {
      status: 200,
      body: {
        active_listings: Number(active.rows[0].cnt),
        floor_price: Number(active.rows[0].floor ?? 0),
        avg_price: Number(active.rows[0].avg_price ?? 0),
        total_volume: Number(volume.rows[0].vol ?? 0),
        total_sales: Number(volume.rows[0].sales),
        fee_pct: feePct,
      },
    };
  } catch (e: any) { return err500(e); }
}
