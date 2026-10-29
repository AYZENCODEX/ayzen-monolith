import { sql, eq, and } from "drizzle-orm";
import { db, vaultEntriesTable, walletsTable } from "@workspace/db";
import { encryptField } from "../../crypto/field-encryption";
import { SENSITIVE_VAULT_FIELDS } from "../../domain/secret-fields";
import { generateSerial } from "../../domain/serial";
import { norm, rawRowKey, dataEntityKey, emailAccountKey, walletKey, MESSAGE_INSERT_COLS, DATA_ENTITY_INSERT_COLS, EMAIL_ACCOUNT_INSERT_COLS, type RawTablePlan } from "../../domain/snapshot-restore-keys";
import { reencryptMailboxMessageForRestore, reencryptMailboxTemplateForRestore, reencryptDataEntityForRestore, reencryptEmailAccountForRestore } from "./snapshot-sections-repository";

/**
 * Snapshot-restore persistence (the existing*Keys reads and insert*Row writes). Extracted verbatim from
 * application/snapshot/restore.ts (VLT-GAP-12-B): identical SQL, identical Drizzle calls, identical re-encryption on insert.
 */

// DR Evidence Collector Phase 2 (dr-evidence-collector-design.md §1) needs
// applyRestoreDiff() to run against an isolated dr_test_<run_id> schema
// instead of the production `db` singleton, via a per-call override rather
// than a second copy of this file. Every helper below that previously
// closed over the module-level `db` import now takes it as a parameter
// (defaulting to the real `db`, so every existing caller — the production
// POST /vault/snapshot/restore route — is unaffected and doesn't need to
// change). `DbHandle` is deliberately typed as `typeof db` rather than
// drizzle's own NodePgDatabase<...> generic so it stays in sync with
// whatever `db`'s inferred type actually is.
export type DbHandle = typeof db;

export async function existingVaultKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const rows = await dbHandle.select({ projectName: vaultEntriesTable.projectName })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
  return new Set(rows.map(r => norm((r as any).projectName)).filter(Boolean));
}

export async function insertVaultRow(tx: typeof db, userId: number, entry: any): Promise<void> {
  const values: Record<string, unknown> = { userId, entitySerial: generateSerial(userId) };
  for (const [key, value] of Object.entries(entry)) {
    if (["id", "userId", "entitySerial", "createdAt", "updatedAt", "deletedAt"].includes(key)) continue;
    if (value === null || value === undefined) continue;
    values[key] = SENSITIVE_VAULT_FIELDS.has(key) ? encryptField(String(value)) : value;
  }
  await (tx as any).insert(vaultEntriesTable).values(values);
}

export async function existingWalletKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const rows = await dbHandle.select({ chain: walletsTable.chain, address: walletsTable.address })
    .from(walletsTable).where(eq(walletsTable.userId, userId));
  return new Set(rows.map(r => walletKey(r)).filter(Boolean));
}

export async function insertWalletRow(tx: typeof db, userId: number, entry: any): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, userId: _u, seedPhrase, encryptedPhrase, createdAt, updatedAt, lastSyncedAt, ...rest } = entry;
  const values: Record<string, unknown> = { ...rest, userId };
  if (seedPhrase) {
    // ASSUMPTION 1 — see file header. Adjust the export name here if wrong.
    const { encryptPhrase } = await import("../../../lib/wallet-crypto");
    values.encryptedPhrase = encryptPhrase(seedPhrase);
  }
  await (tx as any).insert(walletsTable).values(values);
}

export async function existingRawKeys(sqlTable: string, keyColumns: string[], userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const cols = keyColumns.map(c => `"${c}"`).join(", ");
  // sqlTable/keyColumns come from our own RAW_PLANS config, never from the
  // request — safe to interpolate. userId is coerced to Number first.
  const result = await dbHandle.execute(sql.raw(`SELECT ${cols} FROM ${sqlTable} WHERE user_id = ${Number(userId)}`));
  return new Set((result.rows as any[]).map(r => rawRowKey(r, keyColumns)).filter(Boolean));
}

export async function insertRawRow(tx: typeof db, plan: RawTablePlan, userId: number, row: Record<string, any>): Promise<void> {
  const cols = Object.keys(row).filter(c => !plan.excludeOnInsert.includes(c) && row[c] !== undefined);
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c]}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ${sql.raw(plan.sqlTable)} (${colIdent}) VALUES (${valuesSql})`);
}

export async function existingTemplateKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT name FROM ayzen_mailbox_templates WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => norm(r.name)).filter(Boolean));
}

export async function insertTemplateRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptMailboxTemplateForRestore(entry);
  const cols = ["name", "subject", "body_html"];
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ayzen_mailbox_templates (${colIdent}) VALUES (${valuesSql})`);
}

export async function existingMessageKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT message_id FROM ayzen_mailbox_messages WHERE user_id = ${userId} AND message_id IS NOT NULL`);
  return new Set((result.rows as any[]).map(r => norm(r.message_id)).filter(Boolean));
}

export async function insertMessageRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptMailboxMessageForRestore(entry);
  // folder_id/action_label_id-style references dropped, same reasoning as
  // mailboxRules above — restored messages land back in their system
  // folder ('inbox'/'sent'/etc.), never a custom folder that may not exist
  // (or exist under a different id) on the restoring account.
  const folder = ["inbox", "sent", "drafts", "archive", "trash", "spam"].includes(row.folder) ? row.folder : "inbox";
  const cols = MESSAGE_INSERT_COLS;
  const values: Record<string, any> = { ...row, folder };
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${values[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO ayzen_mailbox_messages (${colIdent}) VALUES (${valuesSql})`);
}

export async function existingDataEntityKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT name, father_name, birth_date FROM kyc_data_entities WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => dataEntityKey(r)).filter(Boolean));
}

export async function insertDataEntityRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptDataEntityForRestore(entry);
  const cols = DATA_ENTITY_INSERT_COLS;
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${row[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO kyc_data_entities (${colIdent}) VALUES (${valuesSql})`);
}

export async function existingEmailAccountKeys(userId: number, dbHandle: DbHandle = db): Promise<Set<string>> {
  const result = await dbHandle.execute(sql`SELECT email_address, protocol FROM email_accounts WHERE user_id = ${userId}`);
  return new Set((result.rows as any[]).map(r => emailAccountKey(r)).filter(Boolean));
}

export async function insertEmailAccountRow(tx: typeof db, userId: number, entry: Record<string, any>): Promise<void> {
  const row = reencryptEmailAccountForRestore(entry);
  const cols = [...EMAIL_ACCOUNT_INSERT_COLS, "is_default"];
  const colIdent = sql.raw(["user_id", ...cols].map(c => `"${c}"`).join(", "));
  const values: Record<string, any> = { ...row, is_default: false };
  const valuesSql = sql.join([sql`${userId}`, ...cols.map(c => sql`${values[c] ?? null}`)], sql`, `);
  await (tx as any).execute(sql`INSERT INTO email_accounts (${colIdent}) VALUES (${valuesSql})`);
}
