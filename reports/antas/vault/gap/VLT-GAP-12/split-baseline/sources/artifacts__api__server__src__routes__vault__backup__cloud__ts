/**
 * routes/vault-backup-cloud.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15l — Cloud Backup Delivery (Google Drive / Dropbox): connect /
 * disconnect / status endpoints for the OAuth connections the backup delivery
 * owner uploads through.
 *
 * VLT-GAP-08: every handler below is a thin delegating adapter. The
 * connect-as-JSON design (a browser navigation carries no Authorization
 * header, so GET /connect returns `{ url }` and the frontend navigates), the
 * unauthenticated callback (OAuth `state` carries the userId) and every
 * redirect target now live, unchanged, in
 * vault/application/backup/cloud-connection.ts.
 */
import { Router } from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import {
  listOwnCloudConnections, startCloudConnect, handleCloudCallback, disconnectCloud,
} from "../vault/application/backup/cloud-connection";

const router = Router();

// ─── GET /vault/backup/cloud ─────────────────────────────────────────────
router.get("/vault/backup/cloud", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const out = await listOwnCloudConnections(userId);
  res.status(out.status).json(out.body);
});

// ─── GET /vault/backup/cloud/:provider/connect ──────────────────────────
router.get("/vault/backup/cloud/:provider/connect", requireAuth, (req, res): void => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = startCloudConnect(userId, String(req.params.provider));
  res.status(out.status).json(out.body);
});

// ─── GET /vault/backup/cloud/:provider/callback ─────────────────────────
router.get("/vault/backup/cloud/:provider/callback", async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const out = await handleCloudCallback({ provider: String(req.params.provider), code, state }, req);
  res.redirect(out.redirect);
});

// ─── DELETE /vault/backup/cloud/:provider ───────────────────────────────
router.delete("/vault/backup/cloud/:provider", requireAuth, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await disconnectCloud(userId, String(req.params.provider), req);
  res.status(out.status).json(out.body);
});

export default router;
