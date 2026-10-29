// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export function updateVaultEntriesForBulkTagEntities(next: string[], id: number, userId: number) {
  return db.update(vaultEntriesTable)
        .set({ tags: JSON.stringify(next), updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
        .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
}

export function updateVaultEntriesForBulkActionEntities2(status: string, id: number, userId: number) {
  return db.update(vaultEntriesTable)
          .set({ status, lastActivityAt: new Date(), updatedAt: new Date() } as Partial<typeof vaultEntriesTable.$inferInsert>)
          .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
          .returning();
}

export function updateVaultEntriesForBulkActionEntities3(id: number, userId: number) {
  return db.update(vaultEntriesTable)
          .set({ deletedAt: new Date() })
          .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))
          .returning();
}
