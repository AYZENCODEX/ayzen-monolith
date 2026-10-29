// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, usersTable, vaultEntriesTable, walletsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export function updateVaultEntriesForRunHealthCheck(dbUpdates: Record<string, unknown>, id: number, userId: number) {
  return db.update(vaultEntriesTable).set(dbUpdates as Partial<typeof vaultEntriesTable.$inferInsert>)
        .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}

export function selectUsersForRunHealthCheck(userId: number) {
  return db.select({ telegramChatId: usersTable.telegramChatId }).from(usersTable)
    .where(eq(usersTable.id, userId)).limit(1);
}

export function executeSqlForPersistRawFlags(table: any, flagsJson: string, alertClause: any, entryId: number, userId: number) {
  return db.execute(sql.raw(
      `UPDATE ${table} SET last_health_flags = '${flagsJson}'${alertClause} WHERE id = ${entryId} AND user_id = ${userId}`
    ));
}

export function updateWalletsForPersistWalletFlags(dbUpdates: Record<string, unknown>, entryId: number, userId: number) {
  return db.update(walletsTable)
      .set(dbUpdates as Partial<typeof walletsTable.$inferInsert>)
      .where(and(eq(walletsTable.id, entryId), eq(walletsTable.userId, userId)));
}

export function executeKycEntriesForRunDailyHealthScan() {
  return db.execute(sql.raw(`SELECT * FROM kyc_entries`));
}

export function selectWalletsForRunDailyHealthScan() {
  return db.select().from(walletsTable);
}

export function executeLocalAccountsForRunDailyHealthScan() {
  return db.execute(sql.raw(`SELECT * FROM local_accounts`));
}

export function executeKycEntriesForRunDailyHealthScan2() {
  return db.execute(sql.raw(`
    SELECT d.*,
      (EXISTS (SELECT 1 FROM kyc_entries k WHERE k.data_entity_id = d.id)
       OR EXISTS (SELECT 1 FROM vault_entries v WHERE v.data_entity_id = d.id)) AS used
    FROM kyc_data_entities d
  `));
}

export function selectUsersForRunDailyHealthScan(userIds: number[]) {
  return db
      .select({
        id: usersTable.id, username: usersTable.username, email: usersTable.email,
        telegramChatId: usersTable.telegramChatId,
        digestFrequency: usersTable.digestFrequency, lastDigestSentAt: usersTable.lastDigestSentAt,
      })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));
}

export function updateUsersForRunDailyHealthScan(user: any) {
  return db.update(usersTable).set({ lastDigestSentAt: new Date() }).where(eq(usersTable.id, user.id));
}
