// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db, usersTable, vaultBackupSchedulesTable, vaultSnapshotsTable, vaultBackupDeliveriesTable } from "@workspace/db";
import { and, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";

/** Row type of vault_backup_schedules, exposed so application code needs no @workspace/db import (VLT-GAP-14-B). */
export type VaultBackupScheduleRow = typeof vaultBackupSchedulesTable.$inferSelect;

export function selectUsersForRunVaultBackupSchedule(s: any) {
  return db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, s.userId));
}

export function updateVaultBackupSchedulesForRunVaultBackupSchedule(now: Date, deliveryError: string | undefined, computeNextRunAt: any, s: any) {
  return db.update(vaultBackupSchedulesTable).set({
      lastRunAt: now,
      lastRunStatus: "success",
      lastRunError: deliveryError ? `Backup stored, but delivery failed: ${deliveryError}` : null,
      nextRunAt: computeNextRunAt(s, now),
      runningSince: null,
      updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id));
}

export function updateVaultBackupSchedulesForRunVaultBackupSchedule2(now: Date, message: any, computeNextRunAt: any, s: any) {
  return db.update(vaultBackupSchedulesTable).set({
      lastRunAt: now, lastRunStatus: "failed", lastRunError: message,
      nextRunAt: computeNextRunAt(s, now), runningSince: null, updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id));
}

export function updateVaultBackupSchedulesForClaimSchedule(now: Date, id: number, staleCutoff: Date) {
  return db.update(vaultBackupSchedulesTable)
    .set({ runningSince: now })
    .where(and(
      eq(vaultBackupSchedulesTable.id, id),
      or(isNull(vaultBackupSchedulesTable.runningSince), lt(vaultBackupSchedulesTable.runningSince, staleCutoff)),
    ))
    .returning();
}

export function selectVaultBackupSchedulesForSweepDueSchedules(now: Date) {
  return db.select().from(vaultBackupSchedulesTable)
    .where(and(eq(vaultBackupSchedulesTable.enabled, true), lte(vaultBackupSchedulesTable.nextRunAt, now)));
}

export function selectVaultBackupSchedulesForSweepMissedSchedules(graceCutoff: Date) {
  return db.select().from(vaultBackupSchedulesTable).where(and(
    eq(vaultBackupSchedulesTable.enabled, true),
    lte(vaultBackupSchedulesTable.nextRunAt, graceCutoff),
    isNull(vaultBackupSchedulesTable.runningSince),
  ));
}

export function updateVaultBackupSchedulesForSweepMissedSchedules(missedSinceMinutes: number, computeNextRunAt: any, s: any, now: Date) {
  return db.update(vaultBackupSchedulesTable).set({
      lastRunStatus: "missed",
      lastRunError: `Scheduled run was due ${missedSinceMinutes}m ago and never started — the backup scheduler may have been interrupted.`,
      nextRunAt: computeNextRunAt(s, now),
      updatedAt: now,
    }).where(eq(vaultBackupSchedulesTable.id, s.id));
}

/**
 * VLT-GAP-19: the newest live scheduled snapshot written after the schedule's last completed run. Such a row means a previous run
 * stored its snapshot and then died before the schedule row was updated. A failing read answers "none" (the run then proceeds as
 * before) so a database hiccup can never cost the backup.
 */
export async function selectInterruptedScheduledSnapshot(userId: number, lastRunAt: Date | null) {
  try {
    const rows = await db.select().from(vaultSnapshotsTable)
      .where(and(
        eq(vaultSnapshotsTable.userId, userId), eq(vaultSnapshotsTable.source, "scheduled"), isNull(vaultSnapshotsTable.deletedAt),
        lastRunAt ? gt(vaultSnapshotsTable.createdAt, lastRunAt) : undefined,
      ))
      .orderBy(desc(vaultSnapshotsTable.createdAt)).limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** VLT-GAP-19: has this snapshot already been delivered successfully to this destination? (false on a failing read: deliver again rather than lose it.) */
export async function hasSuccessfulDelivery(snapshotId: number, destination: string): Promise<boolean> {
  try {
    const rows = await db.select({ id: vaultBackupDeliveriesTable.id }).from(vaultBackupDeliveriesTable)
      .where(and(eq(vaultBackupDeliveriesTable.snapshotId, snapshotId), eq(vaultBackupDeliveriesTable.destination, destination), eq(vaultBackupDeliveriesTable.status, "success")))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}
