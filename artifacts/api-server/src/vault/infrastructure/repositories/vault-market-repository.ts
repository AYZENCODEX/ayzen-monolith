import { pool } from "@workspace/db";

/**
 * Vault-market (marketplace "vault" market) persistence. Moved verbatim from routes/marketplace-vault.ts
 * (VLT-GAP-13-E): identical SQL, identical parameter order, identical transaction sequence
 * (debit → credit seller → mark sold → transfer asset → record transaction → COMMIT).
 */

export interface VaultListingFilter {
  limit: number; offset: number;
  category?: unknown; account_type?: unknown; vault_type?: unknown; order_type?: unknown;
  min_price?: unknown; max_price?: unknown; official?: unknown;
}

export interface VaultListingWrite {
  sellerId: number; assetId: unknown; title: string; description: unknown; price: number; category: string; tier: string;
  previewData: string | null; orderType: string; accountType: unknown; accountDetails: string | null; vaultType: string;
  priceMin: number | null; priceMax: number | null; isOfficial: boolean;
}

/** Minimal shape of the dedicated pooled connection the purchase transaction runs on. */
export interface VaultTxClient {
  query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}
export type AssetTransfer = (client: VaultTxClient) => Promise<{ ok: true } | { ok: false; status: number; body: unknown }>;

export type VaultPurchaseResult =
  | { ok: true }
  | { ok: false; reason: "insufficient-balance" }
  | { ok: false; reason: "listing-not-active" }
  | { ok: false; reason: "ownership-conflict"; asset: "entry" | "local account" | "KYC entry" }
  | { ok: false; reason: "transfer-rejected"; status: number; body: unknown };

export async function selectVaultListings(f: VaultListingFilter) {
  let q = `
      SELECT vl.*, u.username AS seller_username
      FROM vault_market_listings vl
      LEFT JOIN users u ON u.id = vl.seller_id
      WHERE vl.status = 'active'
    `;
  const params: any[] = [];
  if (f.category) { params.push(f.category); q += ` AND vl.category = $${params.length}`; }
  if (f.account_type) { params.push(f.account_type); q += ` AND vl.account_type = $${params.length}`; }
  if (f.vault_type) { params.push(f.vault_type); q += ` AND vl.vault_type = $${params.length}`; }
  if (f.order_type) { params.push(f.order_type); q += ` AND vl.order_type = $${params.length}`; }
  if (f.min_price) { params.push(Number(f.min_price)); q += ` AND vl.price >= $${params.length}`; }
  if (f.max_price) { params.push(Number(f.max_price)); q += ` AND vl.price <= $${params.length}`; }
  // official=true -> AYZEN's own Account Store inventory only.
  // official=false -> peer-to-peer user listings only (excludes the store).
  if (f.official === "true") { q += ` AND vl.is_official = TRUE`; }
  else if (f.official === "false") { q += ` AND vl.is_official = FALSE`; }
  q += ` ORDER BY vl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(f.limit), Number(f.offset));
  return pool.query(q, params);
}

export async function countActiveVaultListings() {
  return pool.query("SELECT COUNT(*) FROM vault_market_listings WHERE status='active'");
}

// Ownership checks that guard listing an asset (seller must own it).
export async function selectVaultEntryForListing(entryId: unknown, sellerId: number) {
  return pool.query("SELECT * FROM vault_entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL", [entryId, sellerId]);
}
export async function selectLocalAccountForListing(accountId: unknown, sellerId: number) {
  return pool.query("SELECT * FROM local_accounts WHERE id=$1 AND user_id=$2", [accountId, sellerId]);
}
export async function selectKycEntryForListing(entryId: unknown, sellerId: number) {
  return pool.query("SELECT * FROM kyc_entries WHERE id=$1 AND user_id=$2", [entryId, sellerId]);
}

export async function insertVaultListing(w: VaultListingWrite) {
  return pool.query(
    `INSERT INTO vault_market_listings
         (seller_id, vault_entry_id, title, description, price, category, tier,
          preview_data, order_type, account_type, account_details, vault_type, price_min, price_max, is_official)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      w.sellerId, w.assetId, w.title, w.description, w.price, w.category, w.tier,
      w.previewData, w.orderType, w.accountType, w.accountDetails, w.vaultType, w.priceMin, w.priceMax, w.isOfficial,
    ],
  );
}

// Only sell-type listings are purchasable (buy-orders are fulfilled via a different flow).
export async function findActiveSellListingById(id: unknown) {
  return pool.query(
    "SELECT * FROM vault_market_listings WHERE id=$1 AND status='active' AND (order_type='sell' OR order_type IS NULL)",
    [id],
  );
}

export async function ensureVaultWallet(userId: number): Promise<number> {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, 'vault', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId],
  );
  const r = await pool.query(
    "SELECT balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='vault'",
    [userId],
  );
  return Number(r.rows[0]?.balance ?? 0);
}

/**
 * Purchase transaction. NOTE: the use-case's balance pre-check is only a fast-fail — the authoritative
 * double-spend guard is the atomic `WHERE balance >= $1` debit below. The transaction needs ONE dedicated
 * connection (pool.connect()) so BEGIN/COMMIT/ROLLBACK and the queries between them share a session.
 * `transferGame` is injected by the use-case (game ownership transfer lives in the game boundary).
 */
export async function completeVaultListingPurchase(listingId: unknown, buyerId: number, listing: any, fee: number, net: number, transferGame: AssetTransfer): Promise<VaultPurchaseResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Debit buyer — atomic check-and-debit (TOCTOU / double-spend guard).
    const debitResult = await client.query(
      "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='vault' AND balance >= $1 RETURNING balance",
      [Number(listing.price), buyerId],
    );
    if (debitResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "insufficient-balance" };
    }
    // Credit seller (minus fee)
    await client.query(
      "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='vault'",
      [net, listing.seller_id],
    );
    // Mark listing sold — guarded by status='active' so two concurrent buyers can't both win the same listing.
    const soldResult = await client.query(
      "UPDATE vault_market_listings SET status='sold', buyer_id=$1, sold_at=NOW() WHERE id=$2 AND status='active' RETURNING id",
      [buyerId, listingId],
    );
    if (soldResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "listing-not-active" };
    }
    // Transfer the vault asset
    if (listing.vault_entry_id) {
      if (listing.vault_type === "entity") {
        const transferResult = await client.query(
          "UPDATE vault_entries SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id",
          [buyerId, listing.vault_entry_id, listing.seller_id],
        );
        if (transferResult.rowCount === 0) {
          // Seller no longer owns this asset; rollback to protect buyer
          await client.query("ROLLBACK");
          return { ok: false, reason: "ownership-conflict", asset: "entry" };
        }
      } else if (listing.vault_type === "local") {
        const transferResult = await client.query(
          "UPDATE local_accounts SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id",
          [buyerId, listing.vault_entry_id, listing.seller_id],
        );
        if (transferResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "ownership-conflict", asset: "local account" };
        }
      } else if (listing.vault_type === "kyc") {
        const transferResult = await client.query(
          "UPDATE kyc_entries SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id",
          [buyerId, listing.vault_entry_id, listing.seller_id],
        );
        if (transferResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "ownership-conflict", asset: "KYC entry" };
        }
      } else if (listing.vault_type === "game") {
        const transfer = await transferGame(client);
        if (!transfer.ok) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "transfer-rejected", status: transfer.status, body: transfer.body };
        }
      }
    }
    // Record transaction
    await client.query(
      `INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)
         VALUES ('vault',$1,$2,$3,$4,$5,$6)`,
      [listingId, buyerId, listing.seller_id, Number(listing.price), fee, net],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function findActiveVaultListingById(id: unknown) {
  return pool.query("SELECT * FROM vault_market_listings WHERE id=$1 AND status='active'", [id]);
}

export async function cancelVaultListing(id: unknown) {
  return pool.query("UPDATE vault_market_listings SET status='cancelled' WHERE id=$1", [id]);
}

export async function selectVaultMarketStats() {
  return Promise.all([
    pool.query("SELECT COUNT(*) as cnt, MIN(price) as floor, AVG(price) as avg_price FROM vault_market_listings WHERE status='active' AND (order_type='sell' OR order_type IS NULL)"),
    pool.query("SELECT COUNT(*) as cnt FROM vault_market_listings WHERE status='active' AND order_type='buy'"),
    pool.query("SELECT SUM(amount) as vol, COUNT(*) as sales FROM marketplace_transactions WHERE market_type='vault'"),
  ]);
}
