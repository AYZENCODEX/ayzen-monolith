// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultEntriesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export function selectVaultEntriesForModule(userId: number) {
  return db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`));
}

export function insertVaultEntriesForModule(values: any) {
  return db.insert(vaultEntriesTable).values(values as any);
}
