import { logger } from "../../../lib/logger";
import { logBus } from "../../../lib/log-bus";
import { buildVaultSnapshotPayload } from "../snapshot";
import { storeSnapshotRow } from "../snapshot";
import { envelopeEncryptBackup } from "../../crypto/backup-envelope";
import { deliverSnapshot } from "../../infrastructure/backup/delivery";
import { logActivity } from "../../../lib/activity";
import { alertUserOfScheduledBackupResult, alertUserOfMissedBackup } from "../../infrastructure/backup/alerts";
import { type VaultBackupScheduleRow, selectInterruptedScheduledSnapshot, hasSuccessfulDelivery, selectUsersForRunVaultBackupSchedule, selectVaultBackupSchedulesForSweepDueSchedules, selectVaultBackupSchedulesForSweepMissedSchedules, updateVaultBackupSchedulesForClaimSchedule, updateVaultBackupSchedulesForRunVaultBackupSchedule, updateVaultBackupSchedulesForRunVaultBackupSchedule2, updateVaultBackupSchedulesForSweepMissedSchedules } from "../../infrastructure/repositories/vault-backup-schedule-repository";
import { scheduleCronJob, validateCronExpression } from "../../infrastructure/jobs/cron-scheduler";

let scheduled = false;
let watchdogScheduled = false;

type ScheduleRow = VaultBackupScheduleRow;

// If a run's running_since lock is older than this, treat it as abandoned
// (e.g. the server crashed mid-run) and let a later sweep reclaim the row,
// rather than leaving the schedule wedged forever.
const STALE_LOCK_MINUTES = Number(process.env.VAULT_BACKUP_SCHEDULE_STALE_LOCK_MINUTES ?? 60);

/** Computes the next run time strictly after `from`, per the schedule's frequency/day/hour settings. */
export function computeNextRunAt(s: Pick<ScheduleRow, "frequency" | "dayOfWeek" | "dayOfMonth" | "hourOfDay">, from: Date): Date {
  const hour = Math.min(Math.max(s.hourOfDay, 0), 23);
  const next = new Date(from);
  next.setSeconds(0, 0);

  if (s.frequency === "daily") {
    next.setHours(hour, 0, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  if (s.frequency === "monthly") {
    const day = Math.min(Math.max(s.dayOfMonth, 1), 28); // capped so every month has this day
    next.setDate(day);
    next.setHours(hour, 0, 0, 0);
    if (next <= from) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(day);
    }
    return next;
  }

  // "weekly" (default/fallback)
  const targetDow = Math.min(Math.max(s.dayOfWeek, 0), 6);
  next.setHours(hour, 0, 0, 0);
  let diff = (targetDow - next.getDay() + 7) % 7;
  if (diff === 0 && next <= from) diff = 7;
  next.setDate(next.getDate() + diff);
  return next;
}

/** Runs one schedule immediately, regardless of its nextRunAt — used by both the sweep and the "Run Now" button. */
export async function runVaultBackupSchedule(s: ScheduleRow): Promise<{ ok: boolean; snapshotId?: number; error?: string }> {
  const now = new Date();
  try {
    let id: number, blob: string, vaultCount: number, walletsCount: number, snapshotAt: Date = now;
    // VLT-GAP-19: a worker killed after storing its snapshot but before updating the schedule is re-run after the stale-lock window.
    // Re-running from scratch stored a second snapshot (eating retention quota). If the previous run's snapshot is still there, finish
    // that run instead: reuse the snapshot, skip delivery it already completed, then do the remaining bookkeeping.
    const resumed = await selectInterruptedScheduledSnapshot(s.userId, s.lastRunAt ?? null);
    if (resumed) {
      id = resumed.id; blob = resumed.blob; vaultCount = resumed.entriesCount; walletsCount = resumed.walletsCount; snapshotAt = new Date(resumed.createdAt);
    } else {
      const built = await buildVaultSnapshotPayload(s.userId, s.includeAttachments);
      const { json, mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount } = built;
      vaultCount = built.vaultCount; walletsCount = built.walletsCount;
      const enc = await envelopeEncryptBackup(json, s.userId);
      blob = enc.blob;
      const stored = await storeSnapshotRow({
        userId: s.userId,
        label: `Automatic backup — ${now.toLocaleDateString()}`,
        blob,
        includeAttachments: s.includeAttachments,
        entriesCount: vaultCount,
        walletsCount,
        mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
        source: "scheduled",
        encryptionMode: "envelope",
        encryptionVersion: enc.version,
      });
      id = stored.id;
    }

    let deliveryError: string | undefined;
    if (s.destination !== "store" && !(resumed && await hasSuccessfulDelivery(id, s.destination))) {
      let destinationEmail = s.destinationEmail;
      if (s.destination === "email" && !destinationEmail) {
        const [user] = await selectUsersForRunVaultBackupSchedule(s);
        destinationEmail = user?.email ?? null;
      }
      const result = await deliverSnapshot(s.userId, {
        destination: s.destination as "email" | "webhook" | "google_drive" | "dropbox",
        email: destinationEmail,
        webhookUrl: s.webhookUrl,
        webhookSecret: s.webhookSecret,
      }, {
        id, label: s.destination === "email" ? "Automatic backup" : null, blob,
        sizeBytes: Buffer.byteLength(blob, "utf8"), entriesCount: vaultCount, walletsCount, createdAt: snapshotAt,
      });
      if (result && !result.ok) deliveryError = result.error;
    }

    // VLT-GAP-19: logActivity swallows errors, so one transient failure of this single insert left a stored snapshot with no run entry
    // for good. Retry it (bounded); if it still fails the run proceeds exactly as before (the entry is history, not the backup).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await logActivity(s.userId, "vault_backup_scheduled_run", "vault_snapshot", id, null, {
          entries: vaultCount, wallets: walletsCount, destination: s.destination,
        }, { throwOnError: true });
        break;
      } catch { /* retry */ }
    }

    await updateVaultBackupSchedulesForRunVaultBackupSchedule(now, deliveryError, computeNextRunAt, s);

    // Round 8 — tell the owner it happened, on every channel they have,
    // regardless of outcome. If off-vault delivery failed but the backup
    // itself was still stored fine, that's noted as the "error" so the
    // alert doesn't wrongly read as a full success.
    alertUserOfScheduledBackupResult(s.userId, {
      ok: !deliveryError,
      snapshotId: id,
      error: deliveryError ? `Backup stored, but delivery failed: ${deliveryError}` : undefined,
      entriesCount: vaultCount,
      walletsCount,
      destination: s.destination,
    }).catch(() => {});

    return { ok: true, snapshotId: id };
  } catch (err: any) {
    const message = err?.message ?? "Unknown error";
    await updateVaultBackupSchedulesForRunVaultBackupSchedule2(now, message, computeNextRunAt, s).catch(() => {});
    alertUserOfScheduledBackupResult(s.userId, { ok: false, error: message }).catch(() => {});
    return { ok: false, error: message };
  }
}

/**
 * Atomically claims a due schedule row for this sweep tick by setting
 * running_since, but only if it isn't already claimed by a still-running
 * sweep (running_since IS NULL), or its lock is stale (older than
 * STALE_LOCK_MINUTES, meaning a previous run likely crashed without
 * clearing it). Returns the claimed row, or null if another in-flight sweep
 * already owns it — this is the overlap guard: without it, a run that takes
 * longer than the cron interval would still be sitting on nextRunAt <= now
 * and get picked up again by the next tick, firing a duplicate backup and
 * duplicate email/webhook/cloud delivery.
 */
async function claimSchedule(id: number, now: Date): Promise<ScheduleRow | null> {
  const staleCutoff = new Date(now.getTime() - STALE_LOCK_MINUTES * 60_000);
  const [claimed] = await updateVaultBackupSchedulesForClaimSchedule(now, id, staleCutoff);
  return claimed ?? null;
}

async function sweepDueSchedules(): Promise<void> {
  const now = new Date();
  const due = await selectVaultBackupSchedulesForSweepDueSchedules(now);

  for (const s of due) {
    const claimed = await claimSchedule(s.id, now);
    if (!claimed) {
      // Already running from a previous, still-in-flight sweep tick — skip
      // it this time instead of starting a duplicate run.
      logBus.system(`Skipping automatic vault backup for user ${s.userId}: previous run still in progress`);
      continue;
    }

    const result = await runVaultBackupSchedule(claimed);
    if (result.ok) {
      logBus.system(`Automatic vault backup completed for user ${s.userId} (snapshot #${result.snapshotId})`);
    } else {
      logger.error({ err: result.error, userId: s.userId }, "Scheduled vault backup failed");
      logBus.error(`Automatic vault backup failed for user ${s.userId}: ${result.error}`);
    }
  }
}

export function startVaultBackupScheduleCron(): void {
  if (scheduled) return; // guard against double-init (e.g. hot reload)
  scheduled = true;

  const expr = process.env.VAULT_BACKUP_SCHEDULE_CRON ?? "*/15 * * * *"; // every 15 minutes
  if (!validateCronExpression(expr)) {
    logger.warn({ expr }, "VAULT_BACKUP_SCHEDULE_CRON is not a valid cron expression — automatic vault backups disabled");
    logBus.warn(`Vault backup schedule cron disabled: invalid schedule "${expr}"`);
    return;
  }

  scheduleCronJob(expr, () => {
    sweepDueSchedules().catch((err) => {
      logger.error({ err }, "Vault backup schedule sweep failed");
      logBus.error(`Vault backup schedule sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Automatic vault backup cron scheduled ("${expr}")`);
  logger.info({ expr }, "Vault backup schedule cron scheduled");
}

// ─── Missed-backup watchdog (Round 8) ────────────────────────────────────────
//
// sweepDueSchedules() above only ever reports on a run it actually
// attempted. If the cron process itself stops ticking (server down,
// deployment gap, VAULT_BACKUP_SCHEDULE_CRON misconfigured after a config
// change) an enabled schedule's nextRunAt just sits in the past forever —
// no run happens, so neither the success nor the failure alert in
// runVaultBackupSchedule() ever fires. That silence is indistinguishable
// from "nothing to report" unless something else is watching for it.
//
// This sweep runs on its own, slower, independent cadence and flags any
// enabled schedule whose nextRunAt is more than WATCHDOG_GRACE_MINUTES
// overdue AND isn't currently claimed by an in-flight run (running_since
// null) — i.e. it was due, and nothing has even tried yet. It then:
//   1. Alerts the owner via alertUserOfMissedBackup() — Telegram + email +
//      in-app, same three channels as a normal run's outcome alert.
//   2. Advances nextRunAt (via the same computeNextRunAt() the normal path
//      uses) so the NEXT watchdog tick doesn't re-alert for the same miss
//      forever, and records lastRunStatus="missed" so the Automatic
//      Backups card reflects it too — this self-heals the schedule back
//      onto its normal cadence once the underlying sweep is healthy again.
// The grace window is intentionally wider than the normal sweep interval
// (default: 3x it) so a single slow tick or brief restart never triggers a
// false "missed" alert — this is for genuine multi-tick silence, not
// jitter.
const DEFAULT_WATCHDOG_GRACE_MINUTES = 45;
const WATCHDOG_GRACE_MINUTES = Number(process.env.VAULT_BACKUP_WATCHDOG_GRACE_MINUTES) || DEFAULT_WATCHDOG_GRACE_MINUTES;

async function sweepMissedSchedules(): Promise<void> {
  const now = new Date();
  const graceCutoff = new Date(now.getTime() - WATCHDOG_GRACE_MINUTES * 60_000);

  const missed = await selectVaultBackupSchedulesForSweepMissedSchedules(graceCutoff);

  for (const s of missed) {
    const dueSince = s.nextRunAt ?? now;
    const missedSinceMinutes = Math.round((now.getTime() - dueSince.getTime()) / 60_000);

    logger.warn({ userId: s.userId, missedSinceMinutes }, "Automatic vault backup missed its scheduled time");
    logBus.error(`Automatic vault backup missed for user ${s.userId}: was due ${missedSinceMinutes}m ago and never ran`);

    await updateVaultBackupSchedulesForSweepMissedSchedules(missedSinceMinutes, computeNextRunAt, s, now).catch(() => {});

    alertUserOfMissedBackup(s.userId, missedSinceMinutes).catch(() => {});
  }
}

export function startVaultBackupMissedWatchdog(): void {
  if (watchdogScheduled) return; // guard against double-init (e.g. hot reload)
  watchdogScheduled = true;

  // Deliberately its own, coarser cadence than the main sweep — checking
  // for "has this been silent for a while" doesn't need 15-minute
  // resolution, and a slower tick keeps this cheap to run forever.
  const expr = process.env.VAULT_BACKUP_WATCHDOG_CRON ?? "*/30 * * * *"; // every 30 minutes
  if (!validateCronExpression(expr)) {
    logger.warn({ expr }, "VAULT_BACKUP_WATCHDOG_CRON is not a valid cron expression — missed-backup watchdog disabled");
    logBus.warn(`Vault backup missed-backup watchdog disabled: invalid schedule "${expr}"`);
    return;
  }

  scheduleCronJob(expr, () => {
    sweepMissedSchedules().catch((err) => {
      logger.error({ err }, "Vault backup missed-schedule watchdog sweep failed");
      logBus.error(`Vault backup missed-schedule watchdog sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Automatic vault backup missed-backup watchdog scheduled ("${expr}", ${WATCHDOG_GRACE_MINUTES}m grace)`);
  logger.info({ expr, graceMinutes: WATCHDOG_GRACE_MINUTES }, "Vault backup missed-backup watchdog scheduled");
}
