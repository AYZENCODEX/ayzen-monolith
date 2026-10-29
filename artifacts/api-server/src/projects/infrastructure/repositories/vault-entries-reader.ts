// projects/infrastructure/repositories/vault-entries-reader.ts
// Reads of Vault's `vault_entries` that the enroll flow and its PEP gate need (PRJ-05). Vault exposes no
// read contract for these, so Projects reads the table directly; recorded in the boundary manifest as an
// accepted foreign-table edge, confined to this file plus the raw-SQL overview repositories.
import { db, vaultEntriesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/** Real owner of a vault entry, unfiltered by caller (the PEP gate must not be tautological). */
export async function findVaultEntryOwnerId(vaultEntryId: number): Promise<number | undefined> {
  const [row] = await db.select({ userId: vaultEntriesTable.userId }).from(vaultEntriesTable)
    .where(eq(vaultEntriesTable.id, vaultEntryId)).limit(1);
  return row?.userId;
}

export async function findUserVaultEntry(vaultEntryId: number, userId: number) {
  const [vaultEntry] = await db.select().from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, vaultEntryId), eq(vaultEntriesTable.userId, userId)));
  return vaultEntry;
}
