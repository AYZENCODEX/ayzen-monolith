import { assertEntityOwnership, deleteAttachmentRow, getAttachmentRow, insertAttachmentRow, listAttachmentRows, updateAttachmentRows } from "../../infrastructure/repositories/vault-attachment-repository";
import { decryptField, encryptField } from "../../crypto/field-encryption";
import { logActivity } from "../../../lib/activity";
import { type VaultUseCaseResult } from "../use-case-result";

// Raw (pre-encryption, pre-base64) file size cap. Kept small — this is a
// TEXT-column store, not object storage (see file header). 8MB comfortably
// covers ID photos and PDF contracts without letting a single upload bloat
// the vault_attachments table or the JSON body parser.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const ALLOWED_CATEGORIES = new Set(["id_scan", "contract", "screenshot", "other"]);
export type AttachmentResult = VaultUseCaseResult;

/**
 * Vault attachment use cases. Moved unchanged from routes/vault-attachments.ts
 * (VLT-GAP-10): validation, size/category limits, status codes, error bodies,
 * field encryption and activity events are identical. The route keeps auth,
 * the entity-ownership gate, the body parser/limiter, id parsing and response
 * mapping; queries live in the attachment repository.
 */

/** GET /vault/:id/attachments */
export async function listAttachments(userId: number, entityId: number): Promise<AttachmentResult> {
  if (!(await assertEntityOwnership(entityId, userId))) return { status: 404, body: { error: "Entity not found" } };

  const rows = await listAttachmentRows(entityId, userId);

  return { status: 200, body: { items: rows } };
}

/** POST /vault/:id/attachments — base64 JSON upload, stored field-encrypted. */
export async function uploadAttachment(userId: number, entityId: number, body: any): Promise<AttachmentResult> {
  if (!(await assertEntityOwnership(entityId, userId))) return { status: 404, body: { error: "Entity not found" } };

  const { fileName, mimeType, category = "other", note, dataBase64 } = body ?? {};
  if (typeof fileName !== "string" || !fileName.trim()) {
    return { status: 400, body: { error: "fileName is required" } };
  }
  if (typeof mimeType !== "string" || !mimeType.trim()) {
    return { status: 400, body: { error: "mimeType is required" } };
  }
  if (typeof dataBase64 !== "string" || !dataBase64) {
    return { status: 400, body: { error: "dataBase64 is required" } };
  }
  if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category)) {
    return { status: 400, body: { error: "Invalid category", solution: `category must be one of: ${[...ALLOWED_CATEGORIES].join(", ")}` } };
  }

  const b64 = dataBase64.includes(",") && dataBase64.trim().startsWith("data:")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;

  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return { status: 400, body: { error: "dataBase64 is not valid base64" } };
  }
  if (raw.length === 0) return { status: 400, body: { error: "File is empty" } };
  if (raw.length > MAX_ATTACHMENT_BYTES) {
    return {
      status: 413,
      body: {
        error: "File too large",
        code: "ATTACHMENT_TOO_LARGE",
        solution: `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
      },
    };
  }

  const encryptedContent = encryptField(b64)!;

  const row = await insertAttachmentRow({
    userId,
    vaultEntryId: entityId,
    fileName: fileName.trim().slice(0, 255),
    mimeType: mimeType.trim().slice(0, 100),
    fileSizeBytes: raw.length,
    category,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
    encryptedContent,
  });

  await logActivity(userId, "vault_attachment_uploaded", "vault_entry", entityId, fileName, { attachmentId: row.id, category });

  return { status: 201, body: row };
}

/** GET /vault/:id/attachments/:attachmentId — JSON (base64) or raw bytes with `?raw=1`. */
export async function downloadAttachment(userId: number, entityId: number, attachmentId: number, raw: boolean): Promise<AttachmentResult> {
  if (!(await assertEntityOwnership(entityId, userId))) return { status: 404, body: { error: "Entity not found" } };

  const row = await getAttachmentRow(attachmentId, entityId, userId);
  if (!row) return { status: 404, body: { error: "Attachment not found" } };

  const b64 = decryptField(row.encryptedContent);
  await logActivity(userId, "vault_attachment_downloaded", "vault_entry", entityId, row.fileName, { attachmentId });

  if (raw) {
    return {
      status: 200,
      headers: {
        "Content-Type": row.mimeType,
        "Content-Disposition": `attachment; filename="${row.fileName.replace(/"/g, "")}"`,
      },
      send: Buffer.from(b64, "base64"),
    };
  }

  return {
    status: 200,
    body: {
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      fileSizeBytes: row.fileSizeBytes,
      category: row.category,
      note: row.note,
      uploadedAt: row.uploadedAt,
      dataBase64: b64,
    },
  };
}

/** PATCH /vault/:id/attachments/:attachmentId — rename / recategorise / re-note. */
export async function updateAttachment(userId: number, entityId: number, attachmentId: number, body: any): Promise<AttachmentResult> {
  if (!(await assertEntityOwnership(entityId, userId))) return { status: 404, body: { error: "Entity not found" } };

  const { fileName, category, note } = body ?? {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (fileName !== undefined) {
    if (typeof fileName !== "string" || !fileName.trim()) return { status: 400, body: { error: "Invalid fileName" } };
    updates.fileName = fileName.trim().slice(0, 255);
  }
  if (category !== undefined) {
    if (typeof category !== "string" || !ALLOWED_CATEGORIES.has(category)) return { status: 400, body: { error: "Invalid category" } };
    updates.category = category;
  }
  if (note !== undefined) {
    updates.note = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  }

  const result = await updateAttachmentRows(updates, attachmentId, entityId, userId);
  if (!result.length) return { status: 404, body: { error: "Attachment not found" } };

  return { status: 200, body: { ok: true } };
}

/** DELETE /vault/:id/attachments/:attachmentId */
export async function deleteAttachment(userId: number, entityId: number, attachmentId: number): Promise<AttachmentResult> {
  if (!(await assertEntityOwnership(entityId, userId))) return { status: 404, body: { error: "Entity not found" } };

  const row = await deleteAttachmentRow(attachmentId, entityId, userId);
  if (!row) return { status: 404, body: { error: "Attachment not found" } };

  await logActivity(userId, "vault_attachment_deleted", "vault_entry", entityId, row.fileName, { attachmentId });
  return { status: 200, body: { ok: true } };
}
