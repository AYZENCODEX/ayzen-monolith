import { getMarketConfig } from "../../../lib/market-config";
import {
  selectVaultListings, countActiveVaultListings, selectVaultEntryForListing, selectLocalAccountForListing,
  selectKycEntryForListing, insertVaultListing, findActiveSellListingById, ensureVaultWallet,
  completeVaultListingPurchase, findActiveVaultListingById, cancelVaultListing, selectVaultMarketStats,
} from "../../infrastructure/repositories/vault-market-repository";
import { loadGameEntryListingPreview, transferGameEntryToBuyer } from "../../application/game";

/**
 * Vault ↔ Marketplace shared boundary (VLT-GAP-13-E). Bodies extracted from the handlers of
 * routes/marketplace-vault.ts: same validation order, same status codes and response bodies, same fee maths,
 * same persistence order. Persistence (incl. the purchase transaction) lives in
 * vault/infrastructure/repositories/vault-market-repository; the seller-OR-admin cancel decision lives in
 * vault/security/market-listing-ownership and is injected as `canCancel` because it needs the request subject;
 * game-asset listing/transfer stays in vault/application/game/listing.
 *
 * vault/shared/** is where Vault logic that other apps integrate with (marketplace, …) lives, so those
 * cross-app routes stay thin adapters exactly like the Vault-owned ones.
 */

export type UseCaseResult = { status: number; body: unknown };
const err500 = (e: any): UseCaseResult => ({ status: 500, body: { error: e.message } });

// ── GET /marketplace/vault/listings ──────────────────────────────────────────
export async function listVaultMarketListings(q: any): Promise<UseCaseResult> {
  const { limit = 50, offset = 0, category, account_type, vault_type, order_type, min_price, max_price, official } = q;
  try {
    const r = await selectVaultListings({ limit: Number(limit), offset: Number(offset), category, account_type, vault_type, order_type, min_price, max_price, official });
    const cnt = await countActiveVaultListings();
    const listings = r.rows.map((row: any) => ({
      ...row,
      preview_data: row.preview_data ? JSON.parse(row.preview_data) : null,
      account_details: row.account_details ? JSON.parse(row.account_details) : null,
    }));
    const { feePct } = await getMarketConfig("vault");
    return { status: 200, body: { listings, total: Number(cnt.rows[0].count), fee_pct: feePct } };
  } catch (e: any) { return err500(e); }
}

// ── POST /marketplace/vault/listings ─────────────────────────────────────────
export async function createVaultMarketListing(sellerId: number, role: string | undefined, body: any): Promise<UseCaseResult> {
  const {
    vault_entry_id, local_account_id, kyc_entry_id, game_entry_id,
    title, description, price, price_min, price_max,
    category, tier = "basic",
    order_type = "sell",
    account_type,
    account_details,
    vault_type = "entity",
    official,
  } = body;
  if (order_type === "sell" && !price) return { status: 400, body: { error: "price required for sell order" } };
  if (order_type === "buy" && !account_type) return { status: 400, body: { error: "account_type required for buy order" } };
  const { enabled } = await getMarketConfig("vault");
  if (!enabled) return { status: 403, body: { error: "Vault Market is currently disabled" } };
  try {
    let previewData = null;
    // Verify ownership of referenced vault asset before listing
    if (vault_entry_id && vault_type === "entity") {
      const ve = await selectVaultEntryForListing(vault_entry_id, sellerId);
      if (!ve.rows[0]) return { status: 403, body: { error: "Vault entry not found, not yours, or in trash" } };
      const e = ve.rows[0];
      previewData = JSON.stringify({
        project_name: e.project_name,
        has_twitter: !!e.twitter_username,
        has_discord: !!e.discord_username,
        has_telegram: !!e.telegram_phone,
        has_email: !!e.email,
        has_wallet: !!(e.wallet_addresses),
        entity_serial: e.entity_serial,
      });
    } else if (local_account_id && vault_type === "local") {
      const la = await selectLocalAccountForListing(local_account_id, sellerId);
      if (!la.rows[0]) return { status: 403, body: { error: "Local account not found or not yours" } };
      const a = la.rows[0];
      previewData = JSON.stringify({
        category: a.category,
        has_2fa: !!a.twofa,
        account_create_date: a.account_create_date,
        followers: a.followers,
      });
    } else if (kyc_entry_id && vault_type === "kyc") {
      const ke = await selectKycEntryForListing(kyc_entry_id, sellerId);
      if (!ke.rows[0]) return { status: 403, body: { error: "KYC entry not found or not yours" } };
      const k = ke.rows[0];
      previewData = JSON.stringify({
        category: k.category,
        platform: k.platform,
        has_2fa: !!k.account_2fa || !!k.email_2fa,
      });
    } else if (game_entry_id && vault_type === "game") {
      const game = await loadGameEntryListingPreview(game_entry_id, sellerId);
      if (!game.ok) return { status: game.status, body: game.body };
      previewData = game.previewData;
    }

    const effectiveTitle = title || `${account_type ? account_type.charAt(0).toUpperCase() + account_type.slice(1) : "Account"} buy request`;
    const effectivePrice = order_type === "buy" ? (price_min ?? 0) : Number(price);
    // Only an admin can mark a listing as official AYZEN inventory — this is what makes it show up in the
    // Account Store section rather than as a regular peer listing. Never trust a non-admin-supplied `official: true`.
    const isOfficial = official === true && role === "admin";

    const r = await insertVaultListing({
      sellerId,
      assetId: vault_entry_id ?? local_account_id ?? kyc_entry_id ?? game_entry_id ?? null,
      title: effectiveTitle,
      description: description ?? null,
      price: effectivePrice,
      category: category ?? account_type ?? "Other",
      tier,
      previewData,
      orderType: order_type,
      accountType: account_type ?? null,
      accountDetails: account_details ? JSON.stringify(account_details) : null,
      vaultType: vault_type,
      priceMin: price_min ? Number(price_min) : null,
      priceMax: price_max ? Number(price_max) : null,
      isOfficial,
    });
    return {
      status: 200,
      body: {
        ...r.rows[0],
        preview_data: previewData ? JSON.parse(previewData) : null,
        account_details: account_details ?? null,
      },
    };
  } catch (e: any) { return err500(e); }
}

// ── POST /marketplace/vault/buy ────────────────────────────────────────────────
export async function buyVaultMarketListing(buyerId: number, body: any): Promise<UseCaseResult> {
  const { listing_id } = body;
  if (!listing_id) return { status: 400, body: { error: "listing_id required" } };
  try {
    // Only allow purchasing sell-type listings (buy-orders are fulfilled via a different flow)
    const listR = await findActiveSellListingById(listing_id);
    if (!listR.rows[0]) return { status: 404, body: { error: "Listing not found, sold, or is not a sell listing" } };
    const listing = listR.rows[0];
    if (listing.seller_id === buyerId) return { status: 400, body: { error: "Cannot buy your own listing" } };
    // NOTE: this pre-check is just a fast-fail for the common case — it is NOT the authoritative guard against
    // double-spend; the real check-and-debit happens atomically inside the repository transaction.
    const balance = await ensureVaultWallet(buyerId);
    if (balance < Number(listing.price)) return { status: 400, body: { error: "Insufficient vault wallet balance" } };
    const { feePct } = await getMarketConfig("vault");
    const fee = Number(listing.price) * (feePct / 100);
    const net = Number(listing.price) - fee;

    const done = await completeVaultListingPurchase(
      listing_id, buyerId, listing, fee, net,
      (client) => transferGameEntryToBuyer(client, listing.vault_entry_id, buyerId, listing.seller_id),
    );
    if (!done.ok) {
      switch (done.reason) {
        case "insufficient-balance": return { status: 400, body: { error: "Insufficient vault wallet balance" } };
        case "listing-not-active": return { status: 409, body: { error: "Listing was already sold or cancelled" } };
        case "ownership-conflict": return { status: 409, body: { error: `Asset ownership conflict — seller may no longer own this ${done.asset}` } };
        case "transfer-rejected": return { status: done.status, body: done.body };
      }
    }
    return { status: 200, body: { ok: true, title: listing.title, price: Number(listing.price), fee, net } };
  } catch (e: any) { return err500(e); }
}

// ── DELETE /marketplace/vault/listings/:id ────────────────────────────────────
export async function cancelVaultMarketListing(rawId: string | string[], canCancel: (id: string, listing: any) => Promise<boolean>): Promise<UseCaseResult> {
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  try {
    const r = await findActiveVaultListingById(id);
    if (!r.rows[0]) return { status: 404, body: { error: "Not found" } };
    const listing = r.rows[0];
    // Phase C5: PDP-routed "owner OR admin" check — reuses `listing.seller_id`, already fetched above; no new query.
    if (!(await canCancel(id, listing))) return { status: 403, body: { error: "Forbidden" } };
    await cancelVaultListing(id);
    return { status: 200, body: { ok: true } };
  } catch (e: any) { return err500(e); }
}

// ── GET /marketplace/vault/stats ──────────────────────────────────────────────
export async function getVaultMarketStats(): Promise<UseCaseResult> {
  try {
    const [active, buy_orders, volume] = await selectVaultMarketStats();
    const { feePct } = await getMarketConfig("vault");
    return {
      status: 200,
      body: {
        active_listings: Number(active.rows[0].cnt),
        active_buy_orders: Number(buy_orders.rows[0].cnt),
        floor_price: Number(active.rows[0].floor ?? 0),
        avg_price: Number(active.rows[0].avg_price ?? 0),
        total_volume: Number(volume.rows[0].vol ?? 0),
        total_sales: Number(volume.rows[0].sales),
        fee_pct: feePct,
      },
    };
  } catch (e: any) { return err500(e); }
}
