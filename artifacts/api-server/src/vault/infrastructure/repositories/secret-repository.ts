import { db, vaultEntriesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

/**
 * Secret / wallet persistence for vault_entries and the org extension policy lookup.
 * Extracted verbatim from routes/vault.ts (VLT-GAP-05-B): identical SQL / Drizzle chains, identical
 * row shapes returned. No decision logic lives here — that stays in vault/application/secret.
 */

// Phase 8 — managed extension policy lookup used by the seed-reveal gate.
export async function selectOrgSeedRevealBlock(userId: number) {
  return (await db.execute(sql`
    SELECT 1 FROM organization_members om
    JOIN organization_extension_policies oep ON oep.organization_id = om.organization_id
    WHERE om.user_id = ${userId} AND om.status = 'active' AND oep.disable_seed_reveal = TRUE
    LIMIT 1
  `)).rows;
}

export interface DriveWalletWrite { label: unknown; address: unknown; note: unknown }

export async function updateVaultDriveWallet(id: number, userId: number, w: DriveWalletWrite) {
  const [row] = await db.update(vaultEntriesTable)
    .set({
      driveWalletLabel: w.label || null,
      driveWalletAddress: String(w.address).trim(),
      driveWalletNote: w.note || null,
      driveWalletSetAt: new Date(),
      updatedAt: new Date(),
    } as Partial<typeof vaultEntriesTable.$inferInsert>)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
    .returning();
  return row;
}

export async function updateVaultWalletWorth(id: number, userId: number, totalUsd: number) {
  const [row] = await db.update(vaultEntriesTable)
    .set({
      walletWorthUsd: totalUsd,
      walletWorthSyncedAt: new Date(),
      updatedAt: new Date(),
    } as Partial<typeof vaultEntriesTable.$inferInsert>)
    .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
    .returning();
  return row;
}
