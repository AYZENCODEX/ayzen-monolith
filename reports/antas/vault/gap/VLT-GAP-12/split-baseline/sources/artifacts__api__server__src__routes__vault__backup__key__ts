/**
 * routes/vault-backup-key.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-only visibility + a manual trigger for the "vault-backup" envelope
 * key chain, plus the namespace-wide backup audit feed.
 *
 * VLT-GAP-08: every handler below is a thin delegating adapter. Auth/limiter
 * middleware, request parsing and response mapping stay here; the logic,
 * DB access and operational warnings (rotation only affects NEW backups; it is
 * unrelated to VAULT_MASTER_KEY; no wrapped_dek or key material is ever
 * returned) live in vault/application/backup/key.ts and
 * vault/infrastructure/repositories/vault-backup-repository.ts, unchanged.
 */
import { Router } from "express";
import { requireAdmin, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { getBackupKeyStatus, rotateBackupKey, getAdminBackupAuditLog } from "../vault/application/backup/key";

const router = Router();

// ─── GET /admin/vault-backup/key-status — list DEK versions (metadata only) ─
router.get("/admin/vault-backup/key-status", requireAdmin, async (_req, res): Promise<void> => {
  const out = await getBackupKeyStatus();
  res.status(out.status).json(out.body);
});

// ─── POST /admin/vault-backup/rotate-key — generate + activate a new DEK ────
router.post("/admin/vault-backup/rotate-key", requireAdmin, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const adminId = getRequestUserId(req);
  const out = await rotateBackupKey(adminId, req);
  res.status(out.status).json(out.body);
});

// ─── GET /admin/vault-backup/audit-log — backup-security event feed ────────
router.get("/admin/vault-backup/audit-log", requireAdmin, async (req, res): Promise<void> => {
  const out = await getAdminBackupAuditLog({ userId: req.query.userId, limit: req.query.limit });
  res.status(out.status).json(out.body);
});

export default router;
