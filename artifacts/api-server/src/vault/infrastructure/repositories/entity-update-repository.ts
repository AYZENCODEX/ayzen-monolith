// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable, vaultFieldHistoryTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { encryptField } from "../../crypto/field-encryption";

export function updateVaultEntriesForUpdateEntity(updates: Record<string, unknown>, id: number, userId: number) {
  return db.update(vaultEntriesTable)
      .set(updates as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
}

export function selectVaultEntriesForUpdateEntityField(id: number, userId: number) {
  return db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}

export function updateVaultEntriesForUpdateEntityField(field: string, columnValue: unknown, id: number, userId: number) {
  return db.update(vaultEntriesTable)
      .set({ [field]: columnValue, updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
}

export function insertVaultFieldHistoryForUpdateEntityField(id: number, userId: number, field: string, oldDisplay: string | null, newDisplay: string | null) {
  return db.insert(vaultFieldHistoryTable).values({
      vaultEntryId: id, userId, field,
      oldValue: encryptField(oldDisplay),
      newValue: encryptField(newDisplay),
    });
}

export function selectVaultEntriesForListEntityFieldHistory(id: number, userId: number) {
  return db.select({ id: vaultEntriesTable.id }).from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}

export function selectVaultFieldHistoryForListEntityFieldHistory(fieldFilter: string | undefined, id: number) {
  return db.select().from(vaultFieldHistoryTable)
      .where(fieldFilter
        ? and(eq(vaultFieldHistoryTable.vaultEntryId, id), eq(vaultFieldHistoryTable.field, fieldFilter))
        : eq(vaultFieldHistoryTable.vaultEntryId, id))
      .orderBy(desc(vaultFieldHistoryTable.changedAt))
      .limit(200);
}
