import { db, vaultEntriesTable, usersTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { syncOnVaultDelete } from "../../../services/sync";
import { vaultEntityLinksTable } from "@workspace/db";

/**
 * vault_entries persistence. Extracted verbatim from routes/vault.ts
 * (VLT-GAP-01-B): identical SQL, identical Drizzle-then-raw-SQL fallback.
 */

const SAFE_COLS = `id, user_id, entity_serial, category, project_name,
  email, email_password,
  twitter_username, twitter_password,
  discord_username, discord_password,
  telegram_username, telegram_password,
  wallet_addresses, backup_codes, notes,
  created_at, updated_at,
  null::text as email_recovery, null::text as email_recovery_password,
  null::text as twitter_email, null::text as twitter_email_password,
  null::text as twitter_followers, null::text as twitter_2fa,
  null::text as twitter_email_recovery, null::text as twitter_email_recovery_password,
   null::text as twitter_age, null::text as twitter_worth,
  null::text as discord_email, null::text as discord_email_password,
  null::text as discord_2fa, null::text as discord_email_recovery,
  null::text as discord_email_recovery_password,
  null::text as discord_followers, null::text as discord_age, null::text as discord_worth,
  null::text as telegram_phone, null::text as telegram_2fa,
  null::text as telegram_linked_email, null::text as telegram_linked_email_password,
  null::text as telegram_age, null::text as telegram_worth,
   null::text as twitter_buy_value, null::text as discord_buy_value, null::text as telegram_buy_value,
   0::real as current_value, 0::real as current_buy_value,
   0::real as wallet_worth_usd, null::timestamp as wallet_worth_synced_at,
  null::text as encrypted_seed_phrase, null::text as status, null::timestamp as last_activity_at,
  null::text as username, null::text as account_password, null::text as email_2fa, null::text as email_backup_code,
  null::text as recovery_2fa, null::text as recovery_backup_code,
  null::timestamp as last_login_at, null::timestamp as buy_date, null::timestamp as create_date,
  0::integer as followers,
  null::text as drive_wallet_label, null::text as drive_wallet_address, null::text as drive_wallet_note, null::timestamp as drive_wallet_set_at,
  null::text as telegram_followers,
  null::timestamp as twitter_last_login_at, null::timestamp as twitter_buy_date, null::timestamp as twitter_create_date, null::text as twitter_notes,
  null::timestamp as discord_last_login_at, null::timestamp as discord_buy_date, null::timestamp as discord_create_date, null::text as discord_notes,
  null::timestamp as telegram_last_login_at, null::timestamp as telegram_buy_date, null::timestamp as telegram_create_date, null::text as telegram_notes,
  null::text as account_2fa, null::text as account_backup_code,
  null::text as twitter_account_backup_code, null::text as twitter_email_2fa, null::text as twitter_email_backup_code,
  null::text as twitter_recovery_2fa, null::text as twitter_recovery_backup_code,
  null::text as discord_account_backup_code, null::text as discord_email_2fa, null::text as discord_email_backup_code,
  null::text as discord_recovery_2fa, null::text as discord_recovery_backup_code,
  null::text as telegram_account_backup_code, null::text as telegram_email_2fa, null::text as telegram_email_backup_code,
  null::text as telegram_recovery_2fa, null::text as telegram_recovery_backup_code,
  null::timestamp as deleted_at`;

// selectVault/selectVaultOne/selectAllVaultEntries are the "live" view —
// deleted_at IS NULL — used everywhere except the trash routes below, so a
// soft-deleted entry disappears from every normal list/detail/health-scan
// read the instant it's trashed, exactly like the old hard-delete did.
export async function selectVault(userId: number): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE user_id = ${userId} AND deleted_at IS NULL`));
    return res.rows as Record<string, unknown>[];
  }
}

export async function selectVaultOne(id: number, userId: number): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
    return (rows[0] as unknown as Record<string, unknown>) ?? null;
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL`));
    return (res.rows[0] as Record<string, unknown>) ?? null;
  }
}

// Cross-user bulk read for lib/vault-health-scan.ts's daily background scan —
// the per-user helpers above (selectVault/selectVaultOne) are scoped to a
// single userId because every request-driven route is. The scan has no
// request/user context, so it needs every entry across every owner.
// Trashed entries are excluded — no point health-flagging something the
// user already threw away.
export async function selectAllVaultEntries(): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable).where(sql`${vaultEntriesTable.deletedAt} IS NULL`)) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE deleted_at IS NULL`));
    return res.rows as Record<string, unknown>[];
  }
}

// ─── Trash (soft-deleted entries) ────────────────────────────────────────────
export async function selectVaultTrash(userId: number): Promise<Record<string, unknown>[]> {
  try {
    return (await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NOT NULL`))
      .orderBy(desc(vaultEntriesTable.deletedAt))) as unknown as Record<string, unknown>[];
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE user_id = ${userId} AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`));
    return res.rows as Record<string, unknown>[];
  }
}

// One trashed row, scoped to its owner — shared by restore/purge-one so both
// 404 cleanly instead of silently no-op'ing on someone else's (or an
// already-live) entry.
export async function selectVaultTrashOne(id: number, userId: number): Promise<Record<string, unknown> | null> {
  try {
    const rows = await db.select().from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NOT NULL`));
    return (rows[0] as unknown as Record<string, unknown>) ?? null;
  } catch {
    const res = await db.execute(sql.raw(`SELECT ${SAFE_COLS} FROM vault_entries WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NOT NULL`));
    return (res.rows[0] as Record<string, unknown>) ?? null;
  }
}

// Permanent purge — the actual row delete + cross-table cleanup that used to
// live directly in the DELETE /vault/:id handler before soft-delete. Shared
// by DELETE /vault/trash/:id (manual purge) and the retention cron.
export async function hardDeleteVaultEntry(id: number, userId: number): Promise<void> {
  await db.delete(vaultEntriesTable).where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
  await db.execute(sql`DELETE FROM value_history WHERE user_id = ${userId} AND source_type = 'vault' AND source_id = ${id}`);
  syncOnVaultDelete(id).catch(() => {});
}

export async function findVaultEntryByReceiptToken(token: string) {
  const [entry] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.receiptToken, token), sql`${vaultEntriesTable.deletedAt} IS NULL`)).limit(1);
  if (!entry) return null;
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId)).limit(1);
  return { entry, issuedBy: owner?.username ?? null };
}

export function selectVaultEntriesForVaultEntryResource(id: number) {
  return db.select({ userId: vaultEntriesTable.userId }).from(vaultEntriesTable)
    .where(eq(vaultEntriesTable.id, id)).limit(1);
}

export function selectVaultEntityLinksForVaultEntityLinkResource(id: number) {
  return db.select({ userId: vaultEntityLinksTable.userId }).from(vaultEntityLinksTable)
    .where(eq(vaultEntityLinksTable.id, id)).limit(1);
}

export function selectVaultEntriesForAuditVaultBulkOwnership(ids: number[]) {
  return db.select({ id: vaultEntriesTable.id, userId: vaultEntriesTable.userId })
    .from(vaultEntriesTable).where(sql`${vaultEntriesTable.id} IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`);
}
