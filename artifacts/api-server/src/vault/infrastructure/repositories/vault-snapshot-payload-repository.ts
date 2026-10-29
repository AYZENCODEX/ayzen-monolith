// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, vaultAttachmentsTable, vaultEntriesTable, walletsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export function executeLocalAccountsForBuildVaultSnapshotPayload(userId: number) {
  return db.execute(sql`SELECT * FROM local_accounts WHERE user_id = ${userId}`);
}

export function executeKycEntriesForBuildVaultSnapshotPayload(userId: number) {
  return db.execute(sql`SELECT * FROM kyc_entries WHERE user_id = ${userId}`);
}

export function executeGameEntriesForBuildVaultSnapshotPayload(userId: number) {
  return db.execute(sql`SELECT * FROM game_entries WHERE user_id = ${userId}`);
}

export function selectWalletsForBuildVaultSnapshotPayload(userId: number) {
  return db.select().from(walletsTable).where(eq(walletsTable.userId, userId));
}

export function selectVaultAttachmentsForBuildVaultSnapshotPayload(userId: number) {
  return db.select().from(vaultAttachmentsTable).where(eq(vaultAttachmentsTable.userId, userId));
}
