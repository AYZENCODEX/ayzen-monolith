import { and, desc, eq } from "drizzle-orm";
import {
  db,
  financeAttachmentsTable,
  financeInvoiceLinesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
} from "@workspace/db";
import { parseCsvObjects } from "../../lib/csv";
import {
  postEntryJournal, postEntryAdjustmentJournal, postRepaymentJournal, deleteLedgerEntryCascade, REPAYABLE_KINDS,
} from "../ledger/journal";
import { recordRepayment } from "../ledger/repayments";
import { resolveBookId } from "../ledger/books";

// Ledger entry use cases: CRUD, repayments, attachments, invoice lines and CSV import. Moved from
// routes/finance.ts (FIN-WP-5b). The route keeps HTTP validation of ids and required fields, the PDP
// ownership middleware, header handling (Idempotency-Key) and response formatting (fmtEntry,
// fmtRepayment, dates). Messages and status mapping below are the exact ones the routes returned.
// Best-effort journal postings and notifications stay fire-and-forget, as before. The notification modules
// (Telegram, email, SSE) are loaded on demand so the use cases and their isolated-schema tests do not load them.
// Only logic change: F14 (invoice-line replacement is one transaction, see finance-safety-findings.md).

type EntryRow = typeof financeLedgerEntriesTable.$inferSelect;
type RepaymentRow = typeof financeRepaymentsTable.$inferSelect;

export async function assertEntryOwnership(entryId: number, userId: number): Promise<boolean> {
  const rows = await db.select({ id: financeLedgerEntriesTable.id })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// ─── Entries ─────────────────────────────────────────────────────────────────

export async function listEntries(
  userId: number,
  filter: { kind?: string; projectId?: number; status?: string; bookId?: number } = {},
): Promise<EntryRow[]> {
  const resolvedBookId = await resolveBookId(userId, filter.bookId);
  const conditions = [eq(financeLedgerEntriesTable.userId, userId), eq(financeLedgerEntriesTable.bookId, resolvedBookId)];
  if (filter.kind) conditions.push(eq(financeLedgerEntriesTable.kind, filter.kind));
  if (filter.projectId !== undefined) conditions.push(eq(financeLedgerEntriesTable.projectId, filter.projectId));
  if (filter.status) conditions.push(eq(financeLedgerEntriesTable.status, filter.status));
  return db.select().from(financeLedgerEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate));
}

/**
 * Caller must have validated kind, a non-blank title and `amount` (finite and > 0: a zero or negative
 * amount would never be journalled and would corrupt downstream sums).
 */
export async function createEntry(userId: number, b: Record<string, any>, amount: number): Promise<EntryRow> {
  const resolvedBookId = await resolveBookId(userId, b.bookId ?? undefined);
  const [row] = await db.insert(financeLedgerEntriesTable).values({
    userId,
    bookId: resolvedBookId,
    kind: b.kind,
    title: b.title.trim(),
    amount,
    currency: b.currency || "BDT",
    partyId: b.partyId ?? null,
    projectId: b.projectId ?? null,
    category: b.category ?? null,
    interestRate: b.interestRate ?? null,
    interestPaid: Number(b.interestPaid) || 0,
    dueDate: b.dueDate ? new Date(b.dueDate) : null,
    occurredDate: b.occurredDate ? new Date(b.occurredDate) : new Date(),
    status: b.status || "pending",
    notes: b.notes ?? null,
    lateFeeType: b.lateFeeType ?? null,
    lateFeeRate: b.lateFeeRate ?? null,
    lateFeeGraceDays: Number(b.lateFeeGraceDays) || 0,
  }).returning();
  postEntryJournal(row).catch(() => {}); // best-effort — never blocks the Finance UI
  // best-effort — mints invoice/receipt link, pushes Telegram + email
  import("../notifications/notify").then((m) => m.notifyEntryCreated(row)).catch(() => {});
  return row;
}

export type UpdateEntryResult =
  | { status: "ok"; entry: EntryRow }
  | { status: "not_found" }
  | { status: "invalid"; error: string };

export async function updateEntry(userId: number, id: number, b: Record<string, any>): Promise<UpdateEntryResult> {
  // Pre-update row: needed to know whether `amount` changed, to keep the double-entry books in sync.
  const [existing] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, userId)));
  if (!existing) return { status: "not_found" };

  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["title", "currency", "partyId", "projectId", "category", "interestRate", "status", "notes", "lateFeeType", "lateFeeRate"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  // Numeric fields are coerced and validated like create: a garbage value must not reach the ledger row,
  // and a non-positive amount would flip the sign of what is owed outside the repayment/adjustment logic.
  for (const k of ["amount", "interestPaid", "lateFeeGraceDays"] as const) {
    if (b[k] !== undefined) {
      const n = Number(b[k]);
      if (!Number.isFinite(n)) return { status: "invalid", error: `${k} must be a valid number` };
      if (k === "amount" && n <= 0) return { status: "invalid", error: "amount must be a positive number" };
      update[k] = n;
    }
  }
  if (b.dueDate !== undefined) {
    update.dueDate = b.dueDate ? new Date(b.dueDate) : null;
    // Due date changed — allow the reminder cron to fire again for the new date.
    update.remindedAt = null;
  }
  if (b.occurredDate !== undefined) update.occurredDate = new Date(b.occurredDate);

  const [row] = await db.update(financeLedgerEntriesTable)
    .set(update)
    .where(and(eq(financeLedgerEntriesTable.id, id), eq(financeLedgerEntriesTable.userId, userId)))
    .returning();
  if (!row) return { status: "not_found" };

  // The opening journal was posted once at creation. If the amount changed, post an adjustment for just
  // the delta instead of deleting and reposting (which would wipe repayment/interest journals).
  if (update.amount !== undefined) {
    const delta = Number(update.amount) - existing.amount;
    postEntryAdjustmentJournal(row, delta).catch(() => {}); // best-effort — never blocks the Finance UI
  }
  return { status: "ok", entry: row };
}

/** False when the entry is not this user's (HTTP 404). One transaction inside deleteLedgerEntryCascade (F5). */
export async function deleteEntry(userId: number, id: number): Promise<boolean> {
  // Ownership first: the cascade's child deletes are keyed on entry id.
  if (!(await assertEntryOwnership(id, userId))) return false;
  return deleteLedgerEntryCascade(id, userId);
}

// ─── Repayments ──────────────────────────────────────────────────────────────

/** Undefined when the entry is not this user's. */
export async function listRepayments(userId: number, entryId: number): Promise<RepaymentRow[] | undefined> {
  if (!(await assertEntryOwnership(entryId, userId))) return undefined;
  return db.select().from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, entryId)).orderBy(desc(financeRepaymentsTable.paidAt));
}

export interface AddRepaymentInput {
  amount: number;
  isInterest: boolean;
  notes?: string;
  paidAt?: string;
  /** Already validated by the route (header or body, 1 to 200 characters). */
  idempotencyKey?: string;
}

export type AddRepaymentResult =
  | { status: "created"; repayment: RepaymentRow }
  | { status: "replayed"; repayment: RepaymentRow }
  | { status: "entry_not_found" }
  | { status: "conflict" }
  | { status: "not_repayable"; kind: string };

/** Caller must have validated amount > 0 and the idempotency key. Atomic and idempotent via recordRepayment (F4). */
export async function addRepayment(userId: number, entryId: number, input: AddRepaymentInput): Promise<AddRepaymentResult> {
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!entry) return { status: "entry_not_found" };
  // 'expense'/'income' are immediate cash transactions with no outstanding balance and no repayment
  // posting map; a repayment would reduce entry.amount with no journal, desyncing the books.
  if (!REPAYABLE_KINDS.has(entry.kind)) return { status: "not_repayable", kind: entry.kind };

  const outcome = await recordRepayment({
    entryId, amount: input.amount, isInterest: input.isInterest, notes: input.notes,
    paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
    idempotencyKey: input.idempotencyKey,
  });
  if (outcome.status === "entry_not_found") return { status: "entry_not_found" };
  if (outcome.status === "conflict") return { status: "conflict" };
  if (outcome.status === "replayed") return { status: "replayed", repayment: outcome.repayment };

  postRepaymentJournal(entry, input.amount, input.isInterest).catch(() => {}); // best-effort
  // Notification Bus: "Ryft repayment posted".
  import("../../lib/notification-bus").then((m) => m.notifyRyftRepaymentPosted(
    userId, entry.title, `${entry.currency} ${input.amount.toLocaleString()}`, input.isInterest,
  )).catch(() => {});
  return { status: "created", repayment: outcome.repayment };
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

// Only images and PDFs may be stored: the stored mimeType is echoed as Content-Type on ?raw=1, so an
// arbitrary client-chosen type (text/html, SVG) would become a stored-script surface.
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "application/pdf",
]);

const attachmentMeta = {
  id: financeAttachmentsTable.id,
  fileName: financeAttachmentsTable.fileName,
  mimeType: financeAttachmentsTable.mimeType,
  fileSizeBytes: financeAttachmentsTable.fileSizeBytes,
  note: financeAttachmentsTable.note,
  uploadedAt: financeAttachmentsTable.uploadedAt,
};

/** Metadata only, no file bytes. Undefined when the entry is not this user's. */
export async function listEntryAttachments(userId: number, entryId: number) {
  if (!(await assertEntryOwnership(entryId, userId))) return undefined;
  return db.select(attachmentMeta).from(financeAttachmentsTable)
    .where(and(eq(financeAttachmentsTable.entryId, entryId), eq(financeAttachmentsTable.userId, userId)))
    .orderBy(desc(financeAttachmentsTable.uploadedAt));
}

export type UploadEntryAttachmentResult =
  | { status: "ok"; attachment: { id: number; fileName: string; mimeType: string; fileSizeBytes: number; note: string | null; uploadedAt: Date } }
  | { status: "entry_not_found" }
  | { status: "invalid"; error: string }
  | { status: "too_large"; maxBytes: number };

/** body is the raw JSON body: { fileName, mimeType, note?, dataBase64 }. "invalid" maps to 400, "too_large" to 413. */
export async function uploadEntryAttachment(userId: number, entryId: number, body: Record<string, any> | undefined): Promise<UploadEntryAttachmentResult> {
  if (!(await assertEntryOwnership(entryId, userId))) return { status: "entry_not_found" };

  const { fileName, mimeType, note, dataBase64 } = body ?? {};
  if (typeof fileName !== "string" || !fileName.trim()) return { status: "invalid", error: "fileName is required" };
  if (typeof mimeType !== "string" || !mimeType.trim()) return { status: "invalid", error: "mimeType is required" };
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    return { status: "invalid", error: `Unsupported file type "${mimeType}". Only images and PDFs are allowed.` };
  }
  if (typeof dataBase64 !== "string" || !dataBase64) return { status: "invalid", error: "dataBase64 is required" };

  // Strip a data-URL prefix if the client sent one (e.g. "data:image/jpeg;base64,...").
  const b64 = dataBase64.includes(",") && dataBase64.trim().startsWith("data:")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;

  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return { status: "invalid", error: "dataBase64 is not valid base64" };
  }
  if (raw.length === 0) return { status: "invalid", error: "File is empty" };
  if (raw.length > MAX_ATTACHMENT_BYTES) return { status: "too_large", maxBytes: MAX_ATTACHMENT_BYTES };

  const [row] = await db.insert(financeAttachmentsTable).values({
    userId,
    entryId,
    fileName: fileName.trim().slice(0, 255),
    mimeType: normalizedMimeType,
    fileSizeBytes: raw.length,
    note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null,
    contentBase64: b64,
  }).returning(attachmentMeta);
  return { status: "ok", attachment: row };
}

export type GetEntryAttachmentResult =
  | { status: "ok"; attachment: typeof financeAttachmentsTable.$inferSelect }
  | { status: "entry_not_found" }
  | { status: "attachment_not_found" };

export async function getEntryAttachment(userId: number, entryId: number, attachmentId: number): Promise<GetEntryAttachmentResult> {
  if (!(await assertEntryOwnership(entryId, userId))) return { status: "entry_not_found" };
  const [row] = await db.select().from(financeAttachmentsTable)
    .where(and(
      eq(financeAttachmentsTable.id, attachmentId),
      eq(financeAttachmentsTable.entryId, entryId),
      eq(financeAttachmentsTable.userId, userId),
    ))
    .limit(1);
  if (!row) return { status: "attachment_not_found" };
  return { status: "ok", attachment: row };
}

/** False when the entry is not this user's (HTTP 404). Deleting a missing attachment still succeeds, as before. */
export async function deleteEntryAttachment(userId: number, entryId: number, attachmentId: number): Promise<boolean> {
  if (!(await assertEntryOwnership(entryId, userId))) return false;
  await db.delete(financeAttachmentsTable)
    .where(and(
      eq(financeAttachmentsTable.id, attachmentId),
      eq(financeAttachmentsTable.entryId, entryId),
      eq(financeAttachmentsTable.userId, userId),
    ));
  return true;
}

// ─── Invoice lines (line items on a receivable) ──────────────────────────────

/** Undefined when the entry is not this user's. */
export async function listInvoiceLines(userId: number, entryId: number) {
  if (!(await assertEntryOwnership(entryId, userId))) return undefined;
  return db.select().from(financeInvoiceLinesTable)
    .where(eq(financeInvoiceLinesTable.entryId, entryId))
    .orderBy(financeInvoiceLinesTable.sortOrder);
}

export interface InvoiceLineInput { description: string; quantity?: number; unitPrice?: number; taxPercent?: number }

export type ReplaceInvoiceLinesResult =
  | { status: "ok"; entry: EntryRow | undefined; lines: (typeof financeInvoiceLinesTable.$inferSelect)[] }
  | { status: "entry_not_found" }
  | { status: "invalid"; error: string };

/**
 * Replaces the full line set (the invoice editor saves once), recomputes entry.amount and posts a journal
 * adjustment for the delta, so repayment/interest journals already recorded stay intact.
 * F14: delete, insert and the total recompute are one transaction (before: three statements, so a failed
 * insert left the receivable with no lines and a zero amount after the recompute).
 */
export async function replaceInvoiceLines(userId: number, entryId: number, lines: InvoiceLineInput[] | undefined): Promise<ReplaceInvoiceLinesResult> {
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!entry) return { status: "entry_not_found" };
  if (entry.kind !== "receivable") return { status: "invalid", error: "Invoice lines only apply to receivable entries" };
  if (!Array.isArray(lines) || lines.length === 0) return { status: "invalid", error: "At least one line item is required" };

  await db.transaction(async (tx) => {
    await tx.delete(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entryId));
    await tx.insert(financeInvoiceLinesTable).values(
      lines.map((l, i) => ({
        entryId, description: l.description, quantity: l.quantity ?? 1,
        unitPrice: l.unitPrice ?? 0, taxPercent: l.taxPercent ?? 0, sortOrder: i,
      })),
    );
    const saved = await tx.select().from(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entryId));
    const total = saved.reduce((sum, l) => sum + l.quantity * l.unitPrice * (1 + l.taxPercent / 100), 0);
    await tx.update(financeLedgerEntriesTable).set({ amount: total, updatedAt: new Date() })
      .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  });

  // Reconcile the double-entry journal by posting an adjustment for just the delta (never delete-and-repost).
  const [refreshed] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entryId));
  if (refreshed) {
    const delta = refreshed.amount - entry.amount;
    postEntryAdjustmentJournal(refreshed, delta).catch(() => {});
  }

  const savedLines = await db.select().from(financeInvoiceLinesTable)
    .where(eq(financeInvoiceLinesTable.entryId, entryId)).orderBy(financeInvoiceLinesTable.sortOrder);
  return { status: "ok", entry: refreshed, lines: savedLines };
}

// ─── CSV import ──────────────────────────────────────────────────────────────

/**
 * Expected header: kind,title,amount,currency,category,dueDate,status,interestRate,notes.
 * Caller must have validated that csv is non-blank. Bad rows are reported, good rows are inserted.
 */
export async function importEntriesCsv(userId: number, csv: string, bookId?: number) {
  // Every entry-creation path resolves a concrete bookId before insert, or the rows are invisible in the UI.
  const resolvedBookId = await resolveBookId(userId, bookId ?? undefined);

  const validKinds = new Set(["receivable", "payable", "borrowed", "lending", "investment", "expense", "income"]);
  const rows = parseCsvObjects(csv);

  let inserted = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const kind = (r.kind ?? "").trim().toLowerCase();
    const amount = parseFloat(r.amount ?? "");
    if (!validKinds.has(kind)) { errors.push(`Row ${i + 2}: invalid kind "${r.kind}"`); continue; }
    if (!r.title?.trim()) { errors.push(`Row ${i + 2}: missing title`); continue; }
    if (!amount || amount <= 0) { errors.push(`Row ${i + 2}: invalid amount "${r.amount}"`); continue; }
    // A garbage rate ("N/A", "12%") parses to NaN, and NaN in a numeric column poisons every later aggregate.
    let interestRate: number | null = null;
    if (r.interestRate?.trim()) {
      const parsedRate = parseFloat(r.interestRate);
      if (!Number.isFinite(parsedRate)) { errors.push(`Row ${i + 2}: invalid interestRate "${r.interestRate}"`); continue; }
      interestRate = parsedRate;
    }

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId,
      bookId: resolvedBookId,
      kind, title: r.title.trim(),
      amount, currency: r.currency?.trim() || "BDT",
      category: r.category?.trim() || null,
      dueDate: r.dueDate?.trim() ? new Date(r.dueDate.trim()) : null,
      status: r.status?.trim() || "pending",
      interestRate,
      notes: r.notes?.trim() || null,
    }).returning();
    // Opening journal so the double-entry reports include imported rows.
    if (entry) postEntryJournal(entry).catch(() => {}); // best-effort — never blocks the import
    inserted++;
  }

  return { inserted, failed: errors.length, errors: errors.slice(0, 20) };
}
