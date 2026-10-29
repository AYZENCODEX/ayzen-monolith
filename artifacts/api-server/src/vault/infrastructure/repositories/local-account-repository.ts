import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { safe, safeNum, safeDate } from "../../domain/local-account-values";

/**
 * local_accounts / local_account_categories / local_account_points /
 * vault_category_receipts / value_history persistence. Extracted verbatim from
 * routes/local-accounts.ts (VLT-GAP-02-B): identical SQL text, identical
 * escaping helpers, identical parameterized-vs-raw style per statement.
 * Secret columns arrive here already encrypted by the application layer.
 */

export interface LocalAccountWrite {
  category: any; label: any; username: any; email: any;
  password: any; recoveryEmail: any; recoveryEmailPassword: any;
  backupCodes: any; twofa: any; recoveryEmailTwofa: any;
  followers: any; accountWorth: any; buyPrice: any;
  accountCreateDate: any; accountBuyDate: any; accountLastLoginDate: any;
  notes: any;
  /** undefined on update = keep the stored score column. */
  score: number | undefined;
}

export interface LocalAccountFilter {
  category: string | null;
  onlyUnlinked: boolean;
  vaultEntryId: number | null;
}

// ── local_accounts ──────────────────────────────────────────────────────────

export async function selectLocalAccounts(userId: number, filter: LocalAccountFilter) {
  let where = `user_id = ${userId}`;
  if (filter.category) where += ` AND category = ${safe(filter.category)}`;
  if (filter.onlyUnlinked) where += ` AND vault_entry_id IS NULL`;
  if (filter.vaultEntryId && !isNaN(filter.vaultEntryId)) where += ` AND vault_entry_id = ${filter.vaultEntryId}`;
  return db.execute(sql.raw(`SELECT * FROM local_accounts WHERE ${where} ORDER BY created_at DESC`));
}

export async function insertLocalAccount(userId: number, row: LocalAccountWrite) {
  return db.execute(sql.raw(`
      INSERT INTO local_accounts
        (user_id, category, label, username, email, password, recovery_email, recovery_email_password,
         backup_codes, twofa, recovery_email_twofa, followers, account_worth, buy_price,
         account_create_date, account_buy_date, account_last_login_date, notes, score)
      VALUES
        (${userId}, ${safe(row.category)}, ${safe(row.label)}, ${safe(row.username)}, ${safe(row.email)}, ${safe(row.password)},
         ${safe(row.recoveryEmail)}, ${safe(row.recoveryEmailPassword)}, ${safe(row.backupCodes)}, ${safe(row.twofa)},
         ${safe(row.recoveryEmailTwofa)}, ${safe(row.followers)}, ${safeNum(row.accountWorth)}, ${safeNum(row.buyPrice)},
         ${safeDate(row.accountCreateDate)}, ${safeDate(row.accountBuyDate)}, ${safeDate(row.accountLastLoginDate)},
         ${safe(row.notes)}, ${row.score})
      RETURNING *
    `));
}

export async function updateLocalAccount(id: number, userId: number, row: LocalAccountWrite) {
  return db.execute(sql.raw(`
      UPDATE local_accounts SET
        category = ${safe(row.category)}, label = ${safe(row.label)}, username = ${safe(row.username)},
        email = ${safe(row.email)}, password = ${safe(row.password)},
        recovery_email = ${safe(row.recoveryEmail)}, recovery_email_password = ${safe(row.recoveryEmailPassword)},
        backup_codes = ${safe(row.backupCodes)}, twofa = ${safe(row.twofa)},
        recovery_email_twofa = ${safe(row.recoveryEmailTwofa)},
        followers = ${safe(row.followers)}, account_worth = ${safeNum(row.accountWorth)},
        buy_price = ${safeNum(row.buyPrice)},
        account_create_date = ${safeDate(row.accountCreateDate)},
        account_buy_date = ${safeDate(row.accountBuyDate)},
        account_last_login_date = ${safeDate(row.accountLastLoginDate)},
        notes = ${safe(row.notes)},
        score = ${row.score !== undefined ? row.score : "score"}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
}

export async function updateLocalAccountStatus(id: number, userId: number, status: string) {
  return db.execute(sql.raw(`
      UPDATE local_accounts SET status = ${safe(status)}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
}

export async function deleteLocalAccount(id: number, userId: number) {
  return db.execute(sql.raw(`DELETE FROM local_accounts WHERE id = ${id} AND user_id = ${userId}`));
}

/** Purge all value history so P&L for this account disappears immediately. */
export async function deleteLocalAccountValueHistory(id: number, userId: number) {
  return db.execute(sql`DELETE FROM value_history WHERE user_id = ${userId} AND source_type = 'local' AND source_id = ${id}`);
}

export async function linkLocalAccountToVault(id: number, userId: number, vaultEntryId: unknown) {
  return db.execute(sql.raw(
    `UPDATE local_accounts SET vault_entry_id = ${Number(vaultEntryId)}, updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  ));
}

export async function unlinkLocalAccountFromVault(id: number, userId: number) {
  return db.execute(sql.raw(
    `UPDATE local_accounts SET vault_entry_id = NULL, updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  ));
}

export async function findLocalAccountById(id: number, userId: number) {
  return db.execute(sql.raw(
    `SELECT * FROM local_accounts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`
  ));
}

// ── local_account_categories ────────────────────────────────────────────────

export async function selectLocalAccountCategories(userId: number) {
  return db.execute(sql.raw(
    `SELECT * FROM local_account_categories WHERE user_id = ${userId} ORDER BY created_at ASC`
  ));
}

export async function insertLocalAccountCategory(userId: number, name: string) {
  return db.execute(sql.raw(
    `INSERT INTO local_account_categories (user_id, name) VALUES (${userId}, ${safe(name)}) RETURNING *`
  ));
}

export async function deleteLocalAccountCategory(id: number, userId: number) {
  return db.execute(sql.raw(`DELETE FROM local_account_categories WHERE id = ${id} AND user_id = ${userId}`));
}

// ── local_account_points ────────────────────────────────────────────────────

export async function selectLocalAccountPoints(accountId: number, userId: number) {
  return db.execute(sql.raw(
    `SELECT * FROM local_account_points WHERE account_id = ${accountId} AND user_id = ${userId} ORDER BY created_at DESC`
  ));
}

export async function insertLocalAccountPoint(accountId: number, userId: number, amount: unknown, notes: unknown) {
  return db.execute(sql.raw(
    `INSERT INTO local_account_points (account_id, user_id, amount, notes) VALUES (${accountId}, ${userId}, ${Number(amount)}, ${safe(notes)}) RETURNING *`
  ));
}

export async function deleteLocalAccountPoint(pointId: number, userId: number) {
  return db.execute(sql.raw(`DELETE FROM local_account_points WHERE id = ${pointId} AND user_id = ${userId}`));
}

// ── single-account public receipt ───────────────────────────────────────────

export async function selectLocalAccountReceiptRow(id: number, userId: number) {
  return db.execute(sql.raw(
    `SELECT id, receipt_token FROM local_accounts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`
  ));
}

export async function setLocalAccountReceiptToken(id: number, candidate: string) {
  return db.execute(sql.raw(
    `UPDATE local_accounts SET receipt_token = ${safe(candidate)}, updated_at = NOW() WHERE id = ${id} RETURNING receipt_token`
  ));
}

export async function clearLocalAccountReceiptToken(id: number, userId: number) {
  return db.execute(sql.raw(
    `UPDATE local_accounts SET receipt_token = NULL, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId} RETURNING id`
  ));
}

export async function findLocalAccountByReceiptToken(token: string) {
  const rows = (await db.execute(sql.raw(
    `SELECT la.*, u.username AS owner_username FROM local_accounts la
     LEFT JOIN users u ON u.id = la.user_id
     WHERE la.receipt_token = '${token.replace(/'/g, "''")}' LIMIT 1`
  ))).rows as any[];
  return rows[0] ?? null;
}

// ── category-wise vault receipt ─────────────────────────────────────────────

export async function selectCategoryReceiptToken(userId: number, category: string) {
  return db.execute(sql.raw(
    `SELECT receipt_token FROM vault_category_receipts WHERE user_id = ${userId} AND category = ${safe(category)}`
  ));
}

export async function insertCategoryReceipt(userId: number, category: string, candidate: string) {
  return db.execute(sql.raw(
    `INSERT INTO vault_category_receipts (user_id, category, receipt_token) VALUES (${userId}, ${safe(category)}, ${safe(candidate)}) RETURNING receipt_token`
  ));
}

export async function deleteCategoryReceipt(userId: number, category: string) {
  return db.execute(sql.raw(
    `DELETE FROM vault_category_receipts WHERE user_id = ${userId} AND category = ${safe(category)} RETURNING id`
  ));
}

export async function selectCategoryAggregateRows(userId: number, category: string) {
  return (await db.execute(sql.raw(
    `SELECT followers, account_worth, buy_price, account_create_date FROM local_accounts
     WHERE user_id = ${userId} AND category = ${safe(category)}`
  ))).rows as any[];
}

export async function findCategoryReceiptRowByToken(token: string) {
  const rows = (await db.execute(sql.raw(
    `SELECT vcr.*, u.username AS owner_username FROM vault_category_receipts vcr
     LEFT JOIN users u ON u.id = vcr.user_id
     WHERE vcr.receipt_token = '${token.replace(/'/g, "''")}' LIMIT 1`
  ))).rows as any[];
  return rows[0] ?? null;
}

export async function selectUserEmailRecipient(userId: number) {
  return db.execute(sql.raw(
    `SELECT email, username FROM users WHERE id = ${userId}`
  ));
}

export function executeLocalAccountsForLocalAccountResource(id: number) {
  return db.execute(sql`SELECT user_id FROM local_accounts WHERE id = ${id} LIMIT 1`);
}

export function executeLocalAccountCategoriesForLocalAccountCategoryResource(id: number) {
  return db.execute(sql`SELECT user_id FROM local_account_categories WHERE id = ${id} LIMIT 1`);
}

export function executeLocalAccountPointsForLocalAccountPointResource(id: number) {
  return db.execute(sql`SELECT user_id FROM local_account_points WHERE id = ${id} LIMIT 1`);
}
