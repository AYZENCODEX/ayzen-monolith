import { and, eq, sql } from "drizzle-orm";
import { db, vaultAttachmentsTable, vaultEntriesTable } from "@workspace/db";

export async function assertEntityOwnership(entityId: number, userId: number): Promise<boolean> {
  const rows = await db.select({ id: vaultEntriesTable.id })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, entityId), eq(vaultEntriesTable.userId, userId), sql`${vaultEntriesTable.deletedAt} IS NULL`))
    .limit(1);
  return rows.length > 0;
}
/**
 * DB access for the Vault attachment route handlers, extracted verbatim from
 * routes/vault-attachments.ts (VLT-GAP-10). Column lists, scoping by
 * (vaultEntryId, userId) and ordering are unchanged; callers keep validation,
 * encryption, activity logging and response mapping.
 */

/** Metadata-only list for one entity (never returns encrypted content). */
export async function listAttachmentRows(entityId: number, userId: number) {
  return db.select({
    id: vaultAttachmentsTable.id,
    fileName: vaultAttachmentsTable.fileName,
    mimeType: vaultAttachmentsTable.mimeType,
    fileSizeBytes: vaultAttachmentsTable.fileSizeBytes,
    category: vaultAttachmentsTable.category,
    note: vaultAttachmentsTable.note,
    uploadedAt: vaultAttachmentsTable.uploadedAt,
    updatedAt: vaultAttachmentsTable.updatedAt,
  }).from(vaultAttachmentsTable)
    .where(and(eq(vaultAttachmentsTable.vaultEntryId, entityId), eq(vaultAttachmentsTable.userId, userId)))
    .orderBy(vaultAttachmentsTable.uploadedAt);
}

/** Inserts an (already encrypted) attachment and returns its metadata. */
export async function insertAttachmentRow(values: {
  userId: number; vaultEntryId: number; fileName: string; mimeType: string; fileSizeBytes: number;
  category: string; note: string | null; encryptedContent: string;
}) {
  const [row] = await db.insert(vaultAttachmentsTable).values(values).returning({
    id: vaultAttachmentsTable.id,
    fileName: vaultAttachmentsTable.fileName,
    mimeType: vaultAttachmentsTable.mimeType,
    fileSizeBytes: vaultAttachmentsTable.fileSizeBytes,
    category: vaultAttachmentsTable.category,
    note: vaultAttachmentsTable.note,
    uploadedAt: vaultAttachmentsTable.uploadedAt,
  });
  return row;
}

/** Full attachment row (including encrypted content), scoped to entity + owner. */
export async function getAttachmentRow(attachmentId: number, entityId: number, userId: number) {
  const [row] = await db.select().from(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .limit(1);
  return row;
}

/** Patches metadata; returns the matched id rows (empty = not found). */
export async function updateAttachmentRows(updates: Record<string, unknown>, attachmentId: number, entityId: number, userId: number) {
  return db.update(vaultAttachmentsTable)
    .set(updates as any)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .returning({ id: vaultAttachmentsTable.id });
}

/** Deletes one attachment; returns it (id + fileName) or undefined. */
export async function deleteAttachmentRow(attachmentId: number, entityId: number, userId: number) {
  const [row] = await db.delete(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .returning({ id: vaultAttachmentsTable.id, fileName: vaultAttachmentsTable.fileName });
  return row;
}

export function insertVaultAttachmentsForModule(userId: number, entityId: number, fileName: string, mimeType: string, raw: any, category: string, note: any, encryptedContent: string) {
  return db.insert(vaultAttachmentsTable).values({
    userId,
    vaultEntryId: entityId,
    fileName: fileName.trim().slice(0, 255),
    mimeType: mimeType.trim().slice(0, 100),
    fileSizeBytes: raw.length,
    category,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
    encryptedContent,
  }).returning({
    id: vaultAttachmentsTable.id,
    fileName: vaultAttachmentsTable.fileName,
    mimeType: vaultAttachmentsTable.mimeType,
    fileSizeBytes: vaultAttachmentsTable.fileSizeBytes,
    category: vaultAttachmentsTable.category,
    note: vaultAttachmentsTable.note,
    uploadedAt: vaultAttachmentsTable.uploadedAt,
  });
}

export function selectVaultAttachmentsForModule2(attachmentId: number, entityId: number, userId: number) {
  return db.select().from(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .limit(1);
}

export function deleteVaultAttachmentsForModule(attachmentId: number, entityId: number, userId: number) {
  return db.delete(vaultAttachmentsTable)
    .where(and(
      eq(vaultAttachmentsTable.id, attachmentId),
      eq(vaultAttachmentsTable.vaultEntryId, entityId),
      eq(vaultAttachmentsTable.userId, userId),
    ))
    .returning({ id: vaultAttachmentsTable.id, fileName: vaultAttachmentsTable.fileName });
}

export function selectVaultEntriesForVaultAttachmentEntityResource(id: number) {
  return db.select({ userId: vaultEntriesTable.userId })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), sql`${vaultEntriesTable.deletedAt} IS NULL`))
    .limit(1);
}
