/**
 * routes/vault-snapshot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15 — Encrypted Full Vault Snapshot Export.
 * Feature 15b — Stored Vault Backups (server-side backup store).
 * Feature 15c — Automatic Vault Backups + Restore Preview/Merge.
 *
 * One-click download of the caller's ENTIRE vault (Vault entities, Local
 * accounts, KYC entities, Game entities, Wallets, and — optionally, since
 * it can be large — Attachments) as a single AES-256-GCM-encrypted blob,
 * protected by a password the user chooses at export time (never the
 * account password, never stored anywhere — same "prove you have it, we
 * never keep it" principle as every other Vault credential in this app).
 *
 * This is different from Feature 13's GET /vault/export
 * (routes/vault-migration.ts): that one produces a portable, UNencrypted
 * CSV/JSON of Vault entities only, meant for moving data between tools.
 * This one is a full-fidelity, encrypted disaster-recovery backup of every
 * table this app stores secrets in.
 *
 * Feature 15b: every export used to only stream the blob to the browser —
 * nothing was kept anywhere, so a lost download meant a lost backup and
 * there was never a way to see what backups existed. Every export now ALSO
 * writes a row to vault_snapshots (lib/db/src/schema/vault-snapshots.ts), so
 * backups are actually stored *in the vault* and can be listed, re-downloaded,
 * restored from, renamed, or deleted from the Snapshot Backup page — the
 * browser download still happens too, for anyone who wants an offline copy.
 * The most recent MAX_STORED_SNAPSHOTS per user are kept; older ones are
 * pruned automatically on each new export.
 *
 * Feature 15c: the payload-building + storage logic below
 * (buildVaultSnapshotPayload / storeSnapshotRow) is factored out of the POST
 * /vault/snapshot/export handler so vault/application/backup/schedule-cron.ts can
 * build and store the exact same snapshot shape on a timer, just encrypted
 * under the server-managed envelope key (vault/crypto/backup-envelope.ts)
 * instead of a user-typed password. `source` ("manual" | "scheduled") and
 * `encryptionMode` ("password" | "envelope") on vault_snapshots record which
 * path produced a given row, and `checksum` (sha256 of the stored blob) lets
 * a corruption check confirm a stored/delivered copy matches what was
 * originally written.
 *
 * Key derivation (manual/password mode): scrypt(password, salt, 32) — same
 * primitive already used for wallet seed-phrase encryption elsewhere in this
 * codebase (routes/vault.ts's SEED_KEY), just with a random per-export salt
 * instead of a fixed one, since here the "key" is a user-chosen password
 * rather than a server secret.
 *
 * Blob format (all fields base64, colon-joined):
 *   AYZENBAK1:<salt>:<iv>:<authTag>:<ciphertext>   (password mode, legacy —
 *                                                    scrypt at Node's default
 *                                                    cost; decrypt-only, kept
 *                                                    so old exports still
 *                                                    restore)
 *   AYZENBAK2:<salt>:<iv>:<authTag>:<ciphertext>   (password mode, current —
 *                                                    scrypt at a hardened
 *                                                    cost, see SCRYPT_V2_COST)
 *   ENV1:<version>:<iv>:<authTag>:<ciphertext>     (envelope mode — see
 *                                                    vault/crypto/backup-envelope.ts)
 *
 * Storing the blob server-side adds no new secret exposure: it's already
 * AES-256-GCM ciphertext under a secret AYZEN doesn't keep in the clear
 * (a password it never sees again, or an envelope key wrapped under
 * VAULT_MASTER_KEY), so a vault_snapshots row is exactly as unreadable as a
 * downloaded .ayzenbak file would be.
  *
 * VLT-GAP-09: every handler below is a thin delegating adapter. Auth/limiter/ownership
 * middleware, the 401 guard, id parsing and response mapping stay here; blob crypto, the
 * payload builder, storage/pruning, restore, trash/purge and every query now live in
 * vault/application/snapshot/*, vault/security/snapshot-ownership.ts and
 * vault/infrastructure/repositories/vault-snapshot-repository.ts, with bodies unchanged
 * from the pre-extraction route (verified by the 09 validator and differential).
 */
import express, { Router } from "express";
import { downloadSnapshot, exportSnapshot, getSnapshotStorage, listSnapshots, listTrashedSnapshots, previewRestore, purgeSnapshot, renameSnapshot, restoreFromSnapshot, trashSnapshot, untrashSnapshot } from "../vault/application/snapshot/use-cases";
import { respondWithVaultResult } from "../vault/application/use-case-result";
import { getRequestUserId, requireAuth } from "../middlewares/auth";
import { requireVaultSnapshotOwnershipStrictId } from "../vault/security/snapshot-ownership";
import { sensitiveWriteLimiter } from "../middlewares/security";

const router = Router();

// Snapshots (and restoring them) can be several MB of JSON — scoped bump,
// same reasoning as vault-attachments.ts / vault-migration.ts.
const snapshotBodyParser = express.json({ limit: "25mb" });

// ─── POST /vault/snapshot/export ────────────────────────────────────────────
// Body: { password, includeAttachments?: boolean, label?: string }
router.post("/vault/snapshot/export", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await exportSnapshot(userId, req.body));
});

// ─── GET /vault/snapshots ───────────────────────────────────────────────────
router.get("/vault/snapshots", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await listSnapshots(userId));
});

// ─── GET /vault/snapshots/storage ───────────────────────────────────────────
router.get("/vault/snapshots/storage", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await getSnapshotStorage(userId));
});

// ─── GET /vault/snapshots/:id/download ──────────────────────────────────────
router.get("/vault/snapshots/:id/download", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.download", { error: "Snapshot not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  respondWithVaultResult(res, await downloadSnapshot(userId, id, req));
});

// ─── PATCH /vault/snapshots/:id ─────────────────────────────────────────────
// Body: { label }.
router.patch("/vault/snapshots/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.update", { error: "Snapshot not found" }), express.json(), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  respondWithVaultResult(res, await renameSnapshot(userId, id, req.body));
});

// ─── DELETE /vault/snapshots/:id ────────────────────────────────────────────
// Snapshot Delete Protection: soft-delete (see trashSnapshot).
router.delete("/vault/snapshots/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.trash", { error: "Snapshot not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  respondWithVaultResult(res, await trashSnapshot(userId, id, req));
});

// ─── GET /vault/snapshots/trash ─────────────────────────────────────────────
router.get("/vault/snapshots/trash", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await listTrashedSnapshots(userId));
});

// ─── POST /vault/snapshots/:id/restore — pull a backup back out of the trash ─
// (Different from POST /vault/snapshot/restore below, which merges a decrypted
// backup's DATA into the live vault.)
router.post("/vault/snapshots/:id/restore", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.untrash", { error: "Trashed backup not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  respondWithVaultResult(res, await untrashSnapshot(userId, id, req));
});

// ─── DELETE /vault/snapshots/trash/:id — permanently purge one trashed backup ─
// 3 path segments, so it never collides with DELETE /vault/snapshots/:id above.
router.delete("/vault/snapshots/trash/:id", requireAuth, requireVaultSnapshotOwnershipStrictId("vault_snapshot.purge", { error: "Trashed backup not found" }), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid snapshot id" }); return; }

  respondWithVaultResult(res, await purgeSnapshot(userId, id, req));
});

// ─── POST /vault/snapshot/restore-preview ──────────────────────────────────
// Body: { password, blob } OR { password, snapshotId }. Dry run — writes nothing.
router.post("/vault/snapshot/restore-preview", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await previewRestore(userId, req.body));
});

// ─── POST /vault/snapshot/restore ──────────────────────────────────────────
// Body: { password, blob } or { password, snapshotId }. MERGE restore.
router.post("/vault/snapshot/restore", requireAuth, snapshotBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  respondWithVaultResult(res, await restoreFromSnapshot(userId, req.body, req));
});

export default router;
