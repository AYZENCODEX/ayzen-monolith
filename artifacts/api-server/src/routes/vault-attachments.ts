import { Router } from "express";
import express from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { sensitiveWriteLimiter } from "../middlewares/security";
import { requireVaultAttachmentEntityOwnership } from "../vault/security/attachment-ownership";
import { deleteAttachment, downloadAttachment, listAttachments, updateAttachment, uploadAttachment } from "../vault/application/attachment/use-cases";
import { respondWithVaultResult } from "../vault/application/use-case-result";


const router = Router();

// Attachment uploads need a bigger body than the app-wide JSON_BODY_LIMIT
// (default 1mb) allows — base64 alone adds ~33% overhead on top of
// MAX_ATTACHMENT_BYTES. Scoped to just this route so no other endpoint's
// body-size budget changes.
const uploadBodyParser = express.json({ limit: "12mb" });

// VLT-GAP-13: every handler is a thin delegating adapter. Auth / ownership gate /
// body parser / limiter, the 401 guard, id parsing and response mapping stay here;
// validation, size/category limits, field encryption, activity events and queries live in
// vault/application/attachment/use-cases (bodies unchanged — see VLT-GAP-10).

// ── GET /vault/:id/attachments — list (metadata only, no file bytes) ────────
router.get("/vault/:id/attachments", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.list"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(entityId)) { res.status(400).json({ error: "Invalid entity id" }); return; }

  respondWithVaultResult(res, await listAttachments(userId, entityId));
});

// ── POST /vault/:id/attachments — upload a new file ─────────────────────────
// Body: { fileName, mimeType, category?, note?, dataBase64 }
router.post("/vault/:id/attachments", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.upload"), uploadBodyParser, sensitiveWriteLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(entityId)) { res.status(400).json({ error: "Invalid entity id" }); return; }

  respondWithVaultResult(res, await uploadAttachment(userId, entityId, req.body));
});

// ── GET /vault/:id/attachments/:attachmentId — download (decrypted) ────────
router.get("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.download"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  respondWithVaultResult(res, await downloadAttachment(userId, entityId, attachmentId, req.query.raw === "1"));
});

// ── PATCH /vault/:id/attachments/:attachmentId — rename / recategorize ─────
router.patch("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.update"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  respondWithVaultResult(res, await updateAttachment(userId, entityId, attachmentId, req.body));
});

// ── DELETE /vault/:id/attachments/:attachmentId ─────────────────────────────
router.delete("/vault/:id/attachments/:attachmentId", requireAuth, requireVaultAttachmentEntityOwnership("vault_entry.attachments.delete"), async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const entityId = parseInt(String(req.params.id), 10);
  const attachmentId = parseInt(String(req.params.attachmentId), 10);
  if (!Number.isFinite(entityId) || !Number.isFinite(attachmentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  respondWithVaultResult(res, await deleteAttachment(userId, entityId, attachmentId));
});

export default router;
