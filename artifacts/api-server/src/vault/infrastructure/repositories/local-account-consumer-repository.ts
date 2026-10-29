import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { safe } from "../../domain/local-account-values";

/**
 * Persistence for the cross-module consumers of local accounts (VLT-GAP-02-C).
 * These statements used to live inline in other route files that bypassed the
 * Vault owner; they are moved here VERBATIM (identical SQL text, identical
 * parameterized-vs-raw style per statement):
 *   - routes/vault.ts        autoCreateLocalAccountsForEntity  (entity ↔ local bridge)
 *   - routes/value-history.ts POST/GET /local-accounts/:id/value[-history]
 *   - routes/bulk.ts          POST /local-accounts/bulk + GET /csv/export/local-accounts
 * Secret columns arrive here already encrypted by the application layer.
 */

// ── entity ↔ local bridge (was routes/vault.ts) ─────────────────────────────
export async function findBridgedLocalAccount(userId: number, vaultEntryId: number, platform: string) {
  return db.execute(sql`
        SELECT id FROM local_accounts
        WHERE user_id = ${userId} AND vault_entry_id = ${vaultEntryId} AND category = ${platform}
        LIMIT 1
      `);
}

export interface BridgedLocalAccountInsert {
  userId: number; platform: string; label: string; username: string;
  email: string | null; password: any; twofa: any; followers: string | null; vaultEntryId: number;
}

export async function insertBridgedLocalAccount(a: BridgedLocalAccountInsert) {
  await db.execute(sql`
        INSERT INTO local_accounts
          (user_id, category, label, username, email, password, twofa, followers, vault_entry_id, origin)
        VALUES
          (${a.userId}, ${a.platform}, ${a.label}, ${a.username},
           ${a.email}, ${a.password},
           ${a.twofa}, ${a.followers},
           ${a.vaultEntryId}, 'entity')
      `);
}

// ── per-account value tracking (was routes/value-history.ts) ────────────────
export async function selectLocalAccountValueHistory(userId: number, id: number) {
  return db.execute(sql.raw(`SELECT * FROM value_history WHERE user_id = ${userId} AND source_type = 'local' AND source_id = ${id} ORDER BY created_at DESC`));
}

export async function updateLocalAccountValue(userId: number, id: number, value: number, buyValue: number) {
  return db.execute(sql.raw(`UPDATE local_accounts SET account_worth = ${value}, buy_price = ${buyValue}, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId} RETURNING *`));
}

export async function insertLocalAccountValueHistory(userId: number, id: number, h: { label: unknown; value: number; buyValue: number; note: unknown }) {
  return db.execute(sql.raw(`INSERT INTO value_history (user_id, source_type, source_id, target, label, value, buy_value, note) VALUES (${userId}, 'local', ${id}, 'account', ${safe(h.label || "Account")}, ${h.value}, ${h.buyValue}, ${safe(h.note)}) RETURNING *`));
}

// ── bulk + export (was routes/bulk.ts) ──────────────────────────────────────
export async function deleteLocalAccountsByIds(userId: number, idList: string) {
  await db.execute(sql.raw(`DELETE FROM local_accounts WHERE id IN (${idList}) AND user_id = ${userId}`));
}

export async function updateLocalAccountsCategoryByIds(userId: number, idList: string, cat: string) {
  await db.execute(sql.raw(`UPDATE local_accounts SET category = '${cat}', updated_at = NOW() WHERE id IN (${idList}) AND user_id = ${userId}`));
}

export async function selectLocalAccountsForExport(userId: number) {
  return db.execute(sql.raw(
    `SELECT id, label, category, username, email, followers, account_worth, buy_price, created_at
       FROM local_accounts WHERE user_id = ${userId}`
  ));
}
