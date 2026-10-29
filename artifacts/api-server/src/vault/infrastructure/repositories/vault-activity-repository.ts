// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultActivityLogTable, vaultEntriesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

export function selectVaultActivityLogForListMyVaultActivity(userId: number, limitNum: number, offset: number) {
  return db
      .select({
        log: vaultActivityLogTable,
        entitySerial: vaultEntriesTable.entitySerial,
        entityId: vaultEntriesTable.id,
      })
      .from(vaultActivityLogTable)
      .leftJoin(vaultEntriesTable, eq(vaultActivityLogTable.vaultEntryId, vaultEntriesTable.id))
      .where(eq(vaultActivityLogTable.userId, userId))
      .orderBy(desc(vaultActivityLogTable.createdAt))
      .limit(limitNum)
      .offset(offset);
}

export function executeVaultActivityLogForListMyVaultActivity(userId: number) {
  return db.execute(sql`
      SELECT COUNT(*)::int as count FROM vault_activity_log WHERE user_id = ${userId}
    `);
}

export function selectVaultActivityLogForListEntityActivity(id: number) {
  return db.select().from(vaultActivityLogTable)
      .where(eq(vaultActivityLogTable.vaultEntryId, id))
      .orderBy(desc(vaultActivityLogTable.createdAt));
}

export function insertVaultActivityLogForLogVaultActivity(vaultEntryId: number, userId: number, action: string, detail: string | undefined) {
  return db.insert(vaultActivityLogTable).values({ vaultEntryId, userId, action, detail: detail ?? null });
}

export function executeVaultEntriesForLogVaultActivity(vaultEntryId: number) {
  return db.execute(sql.raw(`SELECT team_id FROM vault_entries WHERE id = ${vaultEntryId}`));
}
