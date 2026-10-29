import { db, vaultBackupSchedulesTable, vaultBackupDeliveriesTable } from "@workspace/db";
import { sql, eq, desc } from "drizzle-orm";

/**
 * DB access for the Vault backup routes, extracted verbatim from
 * routes/vault-backup-key.ts and routes/vault-backup-schedule.ts (VLT-GAP-08).
 * Queries, ordering and limits are unchanged.
 */

/** Metadata-only listing of the "vault-backup" DEK chain (never wrapped_dek). */
export async function listBackupKeyRows(): Promise<any[]> {
  const result: any = await db.execute(
    sql`SELECT version, active, created_at FROM encryption_keys WHERE namespace = 'vault-backup' ORDER BY version ASC`
  );
  return result.rows ?? result;
}

export async function getScheduleRow(userId: number) {
  const [row] = await db.select().from(vaultBackupSchedulesTable).where(eq(vaultBackupSchedulesTable.userId, userId));
  return row;
}

export async function insertScheduleRow(values: Record<string, unknown>): Promise<void> {
  await db.insert(vaultBackupSchedulesTable).values(values as any);
}

export async function updateScheduleRow(id: number, values: Record<string, unknown>): Promise<void> {
  await db.update(vaultBackupSchedulesTable).set(values as any).where(eq(vaultBackupSchedulesTable.id, id));
}

export async function listDeliveryRows(userId: number) {
  return db.select().from(vaultBackupDeliveriesTable)
    .where(eq(vaultBackupDeliveriesTable.userId, userId))
    .orderBy(desc(vaultBackupDeliveriesTable.createdAt))
    .limit(20);
}
