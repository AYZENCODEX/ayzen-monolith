import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

const safeTags = (v: unknown) => {
  const arr = Array.isArray(v) ? v.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [];
  return `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;
};

export interface GameEntryWrite {
  category: unknown;
  username: unknown;
  accountPassword: unknown;
  notes: unknown;
  email: unknown;
  emailPassword: unknown;
  email2fa: unknown;
  emailBackupCode: unknown;
  rank: unknown;
  level: unknown;
  accountAge: unknown;
  tags: unknown;
}

export interface GameListingFilter {
  limit: number;
  offset: number;
  platform?: unknown;
  game_name?: unknown;
  min_price?: unknown;
  max_price?: unknown;
}

export interface GameListingWrite {
  game_name: string;
  title: string;
  description: string | null;
  price: number;
  platform: unknown;
  photos: unknown[];
  details: unknown;
}

export async function selectGameEntryOwner(id: number) {
  return db.execute(sql.raw(`SELECT user_id FROM game_entries WHERE id = ${id} LIMIT 1`));
}

export async function selectGameEntries(userId: number, category: string | null) {
  const q = category
    ? sql.raw(`SELECT * FROM game_entries WHERE user_id = ${userId} AND category = ${safe(category)} ORDER BY created_at DESC`)
    : sql.raw(`SELECT * FROM game_entries WHERE user_id = ${userId} ORDER BY created_at DESC`);
  return db.execute(q);
}

export async function insertGameEntry(userId: number, row: GameEntryWrite) {
  return db.execute(sql.raw(`
      INSERT INTO game_entries
        (user_id, category, username, account_password, notes,
         email, email_password, email_2fa, email_backup_code,
         rank, level, account_age, tags)
      VALUES
        (${userId}, ${safe(row.category)}, ${safe(row.username)}, ${safe(row.accountPassword)}, ${safe(row.notes)},
         ${safe(row.email)}, ${safe(row.emailPassword)}, ${safe(row.email2fa)}, ${safe(row.emailBackupCode)},
         ${safe(row.rank)}, ${safe(row.level)}, ${safe(row.accountAge)}, ${safeTags(row.tags)})
      RETURNING *
    `));
}

export async function findGameEntryById(id: number, userId: number) {
  return db.execute(sql.raw(`SELECT * FROM game_entries WHERE id = ${id} AND user_id = ${userId} LIMIT 1`));
}

export async function updateGameEntry(id: number, userId: number, row: GameEntryWrite) {
  return db.execute(sql.raw(`
      UPDATE game_entries SET
        category = ${safe(row.category)}, username = ${safe(row.username)}, account_password = ${safe(row.accountPassword)}, notes = ${safe(row.notes)},
        email = ${safe(row.email)}, email_password = ${safe(row.emailPassword)}, email_2fa = ${safe(row.email2fa)}, email_backup_code = ${safe(row.emailBackupCode)},
        rank = ${safe(row.rank)}, level = ${safe(row.level)}, account_age = ${safe(row.accountAge)},
        tags = ${row.tags !== undefined ? safeTags(row.tags) : "tags"},
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
}

export async function deleteGameEntry(id: number, userId: number) {
  return db.execute(sql.raw(`DELETE FROM game_entries WHERE id = ${id} AND user_id = ${userId}`));
}

export async function selectGameListings(filter: GameListingFilter) {
  let q = `
      SELECT gl.*, u.username AS seller_username
      FROM game_market_listings gl
      LEFT JOIN users u ON u.id = gl.seller_id
      WHERE gl.status = 'active'
    `;
  const params: any[] = [];
  if (filter.platform) {
    params.push(filter.platform);
    q += ` AND gl.platform = $${params.length}`;
  }
  if (filter.game_name) {
    params.push(`%${filter.game_name}%`);
    q += ` AND gl.game_name ILIKE $${params.length}`;
  }
  if (filter.min_price) {
    params.push(Number(filter.min_price));
    q += ` AND gl.price >= $${params.length}`;
  }
  if (filter.max_price) {
    params.push(Number(filter.max_price));
    q += ` AND gl.price <= $${params.length}`;
  }
  q += ` ORDER BY gl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(filter.limit, filter.offset);
  return pool.query(q, params);
}

export async function countActiveGameListings() {
  return pool.query("SELECT COUNT(*) FROM game_market_listings WHERE status='active'");
}

export async function insertGameListing(sellerId: number, row: GameListingWrite) {
  return pool.query(
    `INSERT INTO game_market_listings
       (seller_id, game_name, title, description, price, platform, photos, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      sellerId,
      row.game_name,
      row.title,
      row.description,
      row.price,
      row.platform,
      JSON.stringify(row.photos),
      JSON.stringify(row.details ?? {}),
    ],
  );
}

export async function findActiveGameListingById(id: unknown) {
  return pool.query("SELECT * FROM game_market_listings WHERE id=$1 AND status='active'", [id]);
}

export async function ensureGameWallet(userId: number): Promise<number> {
  await pool.query(
    `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
     VALUES ($1, 'game', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
    [userId],
  );
  const r = await pool.query(
    "SELECT balance FROM marketplace_wallets WHERE user_id=$1 AND market_type='game'",
    [userId],
  );
  return Number(r.rows[0]?.balance ?? 0);
}

export async function completeGameListingPurchase(listingId: unknown, buyerId: number, listing: any, fee: number, net: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const debit = await client.query(
      "UPDATE marketplace_wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND market_type='game' AND balance >= $1",
      [Number(listing.price), buyerId],
    );
    if (debit.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "insufficient-balance" as const };
    }
    await client.query(
      `INSERT INTO marketplace_wallets (user_id, market_type, balance, locked_balance)
       VALUES ($1, 'game', 0, 0) ON CONFLICT (user_id, market_type) DO NOTHING`,
      [listing.seller_id],
    );
    await client.query(
      "UPDATE marketplace_wallets SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 AND market_type='game'",
      [net, listing.seller_id],
    );
    const soldResult = await client.query(
      "UPDATE game_market_listings SET status='sold', buyer_id=$1, sold_at=NOW() WHERE id=$2 AND status='active' RETURNING id",
      [buyerId, listingId],
    );
    if (soldResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "listing-not-active" as const };
    }
    await client.query(
      `INSERT INTO marketplace_transactions (market_type,listing_id,buyer_id,seller_id,amount,fee,net_amount)
       VALUES ('game',$1,$2,$3,$4,$5,$6)`,
      [listingId, buyerId, listing.seller_id, Number(listing.price), fee, net],
    );
    await client.query("COMMIT");
    return { ok: true as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelGameListing(id: unknown) {
  return pool.query("UPDATE game_market_listings SET status='cancelled' WHERE id=$1", [id]);
}

export async function selectGameMarketplaceStats() {
  return Promise.all([
    pool.query("SELECT COUNT(*) as cnt, MIN(price) as floor, AVG(price) as avg_price FROM game_market_listings WHERE status='active'"),
    pool.query("SELECT SUM(amount) as vol, COUNT(*) as sales FROM marketplace_transactions WHERE market_type='game'"),
  ]);
}

// ─── Vault-market boundary (moved verbatim from routes/marketplace-vault.ts, VLT-GAP-04-C) ───

/** Minimal shape of the dedicated pooled connection the purchase transaction runs on. */
export interface GameTxClient {
  query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

export async function selectGameEntryForListing(entryId: unknown, sellerId: number) {
  return pool.query(
    "SELECT * FROM game_entries WHERE id=$1 AND user_id=$2",
    [entryId, sellerId],
  );
}

export async function transferGameEntryOwnership(client: GameTxClient, entryId: unknown, buyerId: number, sellerId: unknown) {
  return client.query(
    "UPDATE game_entries SET user_id=$1 WHERE id=$2 AND user_id=$3 RETURNING id",
    [buyerId, entryId, sellerId],
  );
}
