// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export function updateVaultEntriesForTrashEntity(id: number, userId: number) {
  return db.update(vaultEntriesTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}

export function updateVaultEntriesForRestoreEntity(id: number, userId: number) {
  return db.update(vaultEntriesTable)
    .set({ deletedAt: null })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}
