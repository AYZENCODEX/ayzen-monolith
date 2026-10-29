// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export function selectVaultEntriesForCreateReceiptLink(id: number, userId: number) {
  return db.select({ id: vaultEntriesTable.id, receiptToken: vaultEntriesTable.receiptToken })
      .from(vaultEntriesTable)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
}

export function updateVaultEntriesForCreateReceiptLink(candidate: string, id: number) {
  return db.update(vaultEntriesTable)
            .set({ receiptToken: candidate, updatedAt: new Date() })
            .where(eq(vaultEntriesTable.id, id))
            .returning({ receiptToken: vaultEntriesTable.receiptToken });
}

export function updateVaultEntriesForRevokeReceiptLink(id: number, userId: number) {
  return db.update(vaultEntriesTable)
    .set({ receiptToken: null, updatedAt: new Date() })
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
    .returning({ id: vaultEntriesTable.id });
}
