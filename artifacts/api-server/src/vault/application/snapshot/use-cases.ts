import { MAX_STORED_SNAPSHOTS, MAX_TOTAL_SNAPSHOT_BYTES, storeSnapshotRow, verifyStoredChecksum } from "./store";
import { MIN_SNAPSHOT_PASSWORD_LENGTH, decryptBlob, encryptBlob } from "./blob";
import { type VaultRequest } from "../../security/request-context";
import { type VaultUseCaseResult } from "../use-case-result";
import { VAULT_SNAPSHOT_TRASH_RETENTION_DAYS } from "../../infrastructure/trash/snapshot-trash-purge";
import { alertOwnerOfAnomalousBackupAccess } from "../../infrastructure/backup/alerts";
import { applyRestoreDiff, buildRestoreDiff } from "./restore";
import { buildVaultSnapshotPayload } from "./payload";
import { deleteSnapshotRow, getLiveSnapshotRow, getTrashedSnapshotIdRow, listLiveSnapshotRows, listLiveSnapshotSizes, listTrashedSnapshotRows, renameSnapshotRow, trashSnapshotRow, untrashSnapshotRow } from "../../infrastructure/repositories/vault-snapshot-repository";
import { getClientIp } from "../../../lib/login-security";
import { isAnomalousBackupIp, logBackupAudit } from "../../infrastructure/backup/audit";
import { logActivity } from "../../../lib/activity";
import { selectVaultSnapshotsForDecryptSnapshotFromRequest } from "../../infrastructure/repositories/vault-snapshot-repository";

// Shared by restore-preview/restore below: pull the decrypted snapshot JSON
// out of either an uploaded blob or a stored snapshot row, given a password.
// Envelope-mode (scheduled) stored snapshots decrypt with the server key
// instead — no password needed, since nobody was present to set one.
//
// Vault Backup hardening, Round 4 — envelope mode is stored-row-only now.
// ─────────────────────────────────────────────────────────────────────────
// This used to accept a client-supplied `blob` for EITHER mode, and decide
// which decrypt path to use by sniffing its prefix. That was a real
// cross-tenant hole for envelope mode specifically: it has no password at
// all, so given a copy of ANY user's "ENV1:..." blob — obtained any way at
// all (a support ticket, a misdirected delivery, a DB export, someone
// pasting it somewhere) — a different authenticated user could decrypt it
// by POSTing it here under their OWN account. Password mode never had this
// problem (the attacker would still need the export password), but
// envelope mode's "key" is a shared server secret nobody types, so blob
// possession alone was sufficient.
//
// Fix: a client-supplied `blob` is now ONLY ever treated as password mode.
// Envelope-mode snapshots can only be restored via `snapshotId`, which is
// looked up through a query already filtered to `userId` — i.e. only ever
// the caller's own row — before anything gets decrypted. (Layer 2 of this
// fix, AAD-binding new envelope blobs to their owning userId, lives in
// vault/crypto/backup-envelope.ts; that's defense-in-depth for this same class
// of bug, not a substitute for this check.)
export async function decryptSnapshotFromRequest(
  userId: number, body: any,
): Promise<{ snapshot: any } | { error: string; status: number }> {
  const { password, snapshotId } = body ?? {};
  let { blob } = body ?? {};

  if (snapshotId !== undefined) {
    const id = Number(snapshotId);
    if (!Number.isFinite(id)) return { error: "Invalid snapshotId", status: 400 };
    const [row] = await selectVaultSnapshotsForDecryptSnapshotFromRequest(id, userId);
    if (!row) return { error: "Snapshot not found — it may be in the trash; restore it first", status: 404 };
    try {
      verifyStoredChecksum(row);
    } catch (err: any) {
      return { error: err?.message ?? "Stored backup failed its integrity check", status: 500 };
    }
    const encryptionMode = (row.encryptionMode as "password" | "envelope" | undefined) ?? "password";
    if (encryptionMode === "envelope" || row.blob.trim().startsWith("ENV1:") || row.blob.trim().startsWith("ENV2:")) {
      try {
        const { envelopeDecryptBackup } = await import("../../crypto/backup-envelope");
        // `row.userId` is provably `userId` here (the query above filtered on
        // it) — this is the ONLY place envelopeDecryptBackup is ever called
        // with anything other than a value straight off a userId-scoped row.
        return { snapshot: JSON.parse(await envelopeDecryptBackup(row.blob, row.userId)) };
      } catch (err: any) {
        return { error: err?.message ?? "Could not decrypt automatic backup", status: 400 };
      }
    }
    blob = row.blob;
  }

  // Client-supplied `blob` (an uploaded .ayzenbak file) is password mode
  // ONLY, regardless of what its prefix claims — see the Round 4 comment
  // above. A blob claiming to be "ENV1:"/"ENV2:" here is simply not a
  // decryptable password-mode file and will fail the format check inside
  // decryptBlob() with a clear error, same as any other malformed upload.
  if (typeof blob !== "string" || !blob) return { error: "blob or snapshotId is required", status: 400 };
  if (typeof password !== "string" || !password) return { error: "password is required", status: 400 };
  try {
    return { snapshot: JSON.parse(decryptBlob(password, blob)) };
  } catch (err: any) {
    return { error: err?.message ?? "Could not decrypt snapshot", status: 400 };
  }
}
export type SnapshotResult = VaultUseCaseResult;

/**
 * Vault snapshot / trash use cases. Moved unchanged from routes/vault-snapshot.ts
 * (VLT-GAP-09): validation, status codes, error bodies, audit/activity events,
 * anomalous-IP alerts and the trash/purge semantics are identical. The route keeps
 * auth/limiter/ownership middleware, the 401 guard, id parsing and response
 * mapping. Blob crypto, payload building and storage live in ./blob, ./payload and
 * ./store (bodies unchanged); queries in the snapshot repository.
 */

/** POST /vault/snapshot/export — build, encrypt, store, and return the blob as a download. */
export async function exportSnapshot(userId: number, body: any): Promise<SnapshotResult> {
  const { password, includeAttachments, label } = body ?? {};
  if (typeof password !== "string" || password.length < MIN_SNAPSHOT_PASSWORD_LENGTH) {
    return {
      status: 400,
      body: {
        error: "Invalid password",
        solution: `Snapshot password must be at least ${MIN_SNAPSHOT_PASSWORD_LENGTH} characters. Store it somewhere safe — AYZEN never keeps a copy and cannot recover a snapshot without it.`,
      },
    };
  }

  const { json, vaultCount, walletsCount, mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount } = await buildVaultSnapshotPayload(userId, !!includeAttachments);
  const blob = encryptBlob(password, json);

  const { id: storedId } = await storeSnapshotRow({
    userId,
    label: typeof label === "string" && label.trim() ? label.trim().slice(0, 120) : null,
    blob,
    includeAttachments: !!includeAttachments,
    entriesCount: vaultCount,
    walletsCount,
    mailboxCount, projectsCount, tasksCount, financeCount, walletHubCount, activityCount, entityCoverageCount, emergencyAccessCount, accountExtrasCount, teamCount, earningCount, backupSystemCount, emailAccountsCount, mailboxReputationCount, externalMailCount,
    source: "manual",
    encryptionMode: "password",
  });

  await logActivity(userId, "vault_snapshot_exported", "vault_snapshot", storedId, null, {
    entries: vaultCount, wallets: walletsCount, mailbox: mailboxCount, projects: projectsCount, tasks: tasksCount, finance: financeCount, walletHub: walletHubCount, activity: activityCount, entityCoverage: entityCoverageCount, emergencyAccess: emergencyAccessCount, accountExtras: accountExtrasCount, team: teamCount, earning: earningCount, backupSystem: backupSystemCount, emailAccounts: emailAccountsCount, mailboxReputation: mailboxReputationCount, externalMail: externalMailCount,
  });

  return {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="ayzen-vault-snapshot-${Date.now()}.ayzenbak"`,
      "X-Snapshot-Id": String(storedId),
    },
    send: blob,
  };
}

/** GET /vault/snapshots — stored backups, newest first, metadata only. */
export async function listSnapshots(userId: number): Promise<SnapshotResult> {
  const rows = await listLiveSnapshotRows(userId);
  return { status: 200, body: { snapshots: rows, max: MAX_STORED_SNAPSHOTS } };
}

/** GET /vault/snapshots/storage — how much of the per-user backup quota is used. */
export async function getSnapshotStorage(userId: number): Promise<SnapshotResult> {
  const rows = await listLiveSnapshotSizes(userId);

  const usedBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
  return {
    status: 200,
    body: {
      usedBytes,
      quotaBytes: MAX_TOTAL_SNAPSHOT_BYTES,
      percentUsed: Math.min(100, Math.round((usedBytes / MAX_TOTAL_SNAPSHOT_BYTES) * 100)),
      count: rows.length,
      maxCount: MAX_STORED_SNAPSHOTS,
    },
  };
}

/**
 * GET /vault/snapshots/:id/download — re-download a stored backup's exact blob.
 * An envelope-mode (automatic) backup can only be decrypted server-side; this
 * exists so it can still be moved off-vault by hand.
 */
export async function downloadSnapshot(userId: number, id: number, req: VaultRequest): Promise<SnapshotResult> {
  const row = await getLiveSnapshotRow(id, userId);
  if (!row) return { status: 404, body: { error: "Snapshot not found" } };

  try {
    verifyStoredChecksum(row);
  } catch (err: any) {
    return { status: 500, body: { error: err?.message ?? "Stored backup failed its integrity check" } };
  }

  // Vault Backup hardening, Round 7 — checked BEFORE logging this download,
  // so this event never counts as its own prior history. Awaited (it's one
  // fast indexed SELECT) so the ordering is guaranteed.
  const ip = getClientIp(req);
  const anomalous = await isAnomalousBackupIp(userId, ip).catch(() => false);

  // Vault Backup hardening, Round 6 — this hands back a raw, offline-
  // decryptable blob, so the event is audit-logged. Not awaited —
  // logBackupAudit() never throws (best-effort internally), and the download
  // itself shouldn't wait on the audit write.
  logBackupAudit({
    ownerUserId: userId, eventType: "snapshot_downloaded", snapshotId: id, req,
    detail: { encryptionMode: row.encryptionMode ?? "password" },
  });
  // Round 7's alert — also not awaited, fired only when the IP above was flagged.
  if (anomalous) alertOwnerOfAnomalousBackupAccess(userId, "snapshot_downloaded", ip).catch(() => {});

  return {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="ayzen-vault-snapshot-${new Date(row.createdAt).getTime()}.ayzenbak"`,
    },
    send: row.blob,
  };
}

/** PATCH /vault/snapshots/:id — Body: { label }. Renames a stored backup. */
export async function renameSnapshot(userId: number, id: number, body: any): Promise<SnapshotResult> {
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 120) : null;
  const updated = await renameSnapshotRow(id, userId, label);
  if (!updated) return { status: 404, body: { error: "Snapshot not found" } };
  return { status: 200, body: { ok: true } };
}

/**
 * DELETE /vault/snapshots/:id — Snapshot Delete Protection: soft-delete (sets
 * deleted_at); recoverable for VAULT_SNAPSHOT_TRASH_RETENTION_DAYS, and migration
 * 072's DB trigger refuses a direct hard DELETE on any row not already trashed.
 */
export async function trashSnapshot(userId: number, id: number, req: VaultRequest): Promise<SnapshotResult> {
  const trashed = await trashSnapshotRow(id, userId);
  if (!trashed) return { status: 404, body: { error: "Snapshot not found" } };

  await logActivity(userId, "vault_snapshot_trashed", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_trashed", snapshotId: id, req });
  return { status: 200, body: { message: "Backup moved to trash", retentionDays: VAULT_SNAPSHOT_TRASH_RETENTION_DAYS } };
}

/** GET /vault/snapshots/trash — soft-deleted backups with the date each will be purged. */
export async function listTrashedSnapshots(userId: number): Promise<SnapshotResult> {
  const rows = await listTrashedSnapshotRows(userId);

  return {
    status: 200,
    body: {
      snapshots: rows.map((r) => ({
        ...r,
        purgeAt: r.deletedAt ? new Date(new Date(r.deletedAt).getTime() + VAULT_SNAPSHOT_TRASH_RETENTION_DAYS * 86400000).toISOString() : null,
      })),
      retentionDays: VAULT_SNAPSHOT_TRASH_RETENTION_DAYS,
    },
  };
}

/**
 * POST /vault/snapshots/:id/restore — pull a backup back out of the trash.
 * Different from restoreFromSnapshot: this only undoes a soft-delete, no decryption
 * and no data changes.
 */
export async function untrashSnapshot(userId: number, id: number, req: VaultRequest): Promise<SnapshotResult> {
  const restored = await untrashSnapshotRow(id, userId);
  if (!restored) return { status: 404, body: { error: "Trashed backup not found" } };

  await logActivity(userId, "vault_snapshot_untrashed", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_untrashed", snapshotId: id, req });
  return { status: 200, body: { message: "Backup restored from trash" } };
}

/**
 * DELETE /vault/snapshots/trash/:id — permanently purge one trashed backup. Must
 * already be trashed; the migration-072 trigger still refuses this until the row
 * has been trashed for at least 3 days.
 */
export async function purgeSnapshot(userId: number, id: number, req: VaultRequest): Promise<SnapshotResult> {
  const trashedRow = await getTrashedSnapshotIdRow(id, userId);
  if (!trashedRow) return { status: 404, body: { error: "Trashed backup not found" } };

  try {
    await deleteSnapshotRow(id, userId);
  } catch (err: any) {
    // Most likely migration 072's "trashed less than 3 days ago" guard.
    return { status: 400, body: { error: err?.message ?? "This backup can't be permanently deleted yet" } };
  }

  await logActivity(userId, "vault_snapshot_purged", "vault_snapshot", id, null, null);
  await logBackupAudit({ ownerUserId: userId, eventType: "snapshot_purged", snapshotId: id, req });
  return { status: 200, body: { message: "Backup permanently deleted" } };
}

/**
 * POST /vault/snapshot/restore-preview — decrypts the backup and reports, per
 * table, how many rows a merge restore would add vs. skip, WITHOUT writing.
 */
export async function previewRestore(userId: number, body: any): Promise<SnapshotResult> {
  const result = await decryptSnapshotFromRequest(userId, body);
  if ("error" in result) return { status: result.status, body: { error: result.error } };

  const preview = await buildRestoreDiff(userId, result.snapshot);
  return { status: 200, body: preview };
}

/**
 * POST /vault/snapshot/restore — MERGE restore from an uploaded blob or a stored
 * snapshot; the diff is recomputed server-side, so repeated runs converge.
 */
export async function restoreFromSnapshot(userId: number, body: any, req: VaultRequest): Promise<SnapshotResult> {
  const result = await decryptSnapshotFromRequest(userId, body);
  if ("error" in result) return { status: result.status, body: { error: result.error } };

  const applied = await applyRestoreDiff(userId, result.snapshot);
  await logActivity(userId, "vault_snapshot_restored", null, null, null, {
    restored: applied.restored, skipped: applied.skipped, byTable: applied.byTable,
  });
  // Round 7 — checked BEFORE the audit write below, same ordering reasoning
  // as the download use case.
  const restoreIp = getClientIp(req);
  const restoreAnomalous = await isAnomalousBackupIp(userId, restoreIp).catch(() => false);
  await logBackupAudit({
    ownerUserId: userId, eventType: "snapshot_restored",
    snapshotId: Number.isFinite(Number(body?.snapshotId)) ? Number(body.snapshotId) : null,
    req, detail: { restored: applied.restored, skipped: applied.skipped },
  });
  if (restoreAnomalous) alertOwnerOfAnomalousBackupAccess(userId, "snapshot_restored", restoreIp).catch(() => {});
  return { status: 200, body: applied };
}
