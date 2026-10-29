import { and, eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import type { Writable } from "node:stream";
import {
  db,
  financeInvoiceLinesTable,
  financeLedgerEntriesTable,
  financePartiesTable,
  usersTable,
} from "@workspace/db";
import { ensureReceiptToken, financeReceiptUrl } from "../receipts/receipt-tokens";

// Public receipt links for ledger entries. Moved unchanged from routes/finance.ts (FIN-WP-2b).
// The routes keep authentication, the PDP ownership middleware, token-presence checks and the
// public-audit middleware. Nothing here is reachable without the owner minting a token.

function iso(d: Date | string | null | undefined) {
  if (!d) return null;
  return typeof d === "string" ? d : d.toISOString();
}

export type MintReceiptOutcome =
  | { status: "ok"; token: string; url: string }
  | { status: "entry_not_found" }
  | { status: "token_failed" };

/** Idempotent: repeat calls return the same token until revoked. */
export async function mintEntryReceiptLink(userId: number, entryId: number): Promise<MintReceiptOutcome> {
  const [owned] = await db.select({ id: financeLedgerEntriesTable.id }).from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!owned) return { status: "entry_not_found" };
  const token = await ensureReceiptToken(entryId, userId);
  if (!token) return { status: "token_failed" };
  return { status: "ok", token, url: financeReceiptUrl(token) };
}

/** Returns false when the entry is not this user's. Any previously shared URL stops working. */
export async function revokeEntryReceiptLink(userId: number, entryId: number): Promise<boolean> {
  const [row] = await db.update(financeLedgerEntriesTable)
    .set({ receiptToken: null, updatedAt: new Date() })
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)))
    .returning({ id: financeLedgerEntriesTable.id });
  return !!row;
}

// Shared lookup used by both the JSON view and the PDF route below.
export async function findByReceiptToken(token: string) {
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.receiptToken, token)).limit(1);
  if (!entry) return null;
  const [party] = entry.partyId
    ? await db.select({ name: financePartiesTable.name }).from(financePartiesTable).where(eq(financePartiesTable.id, entry.partyId)).limit(1)
    : [];
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId)).limit(1);
  const lines = entry.kind === "receivable"
    ? await db.select().from(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, entry.id)).orderBy(financeInvoiceLinesTable.sortOrder)
    : [];
  return { entry, partyName: party?.name ?? null, issuedBy: owner?.username ?? null, lines };
}

// Fields safe to hand to an anonymous holder of the link — no userId,
// partyId, projectId, recurringRuleId, or internal notes.
export function fmtPublicReceipt(e: typeof financeLedgerEntriesTable.$inferSelect, partyName: string | null, issuedBy: string | null, lines: (typeof financeInvoiceLinesTable.$inferSelect)[] = []) {
  return {
    id: e.id,
    kind: e.kind,
    isInvoice: e.kind === "receivable" && e.status !== "paid",
    title: e.title,
    amount: e.amount,
    currency: e.currency,
    category: e.category,
    interestRate: e.interestRate,
    interestPaid: e.interestPaid,
    dueDate: iso(e.dueDate),
    occurredDate: iso(e.occurredDate),
    status: e.status,
    partyName,
    issuedBy,
    lines: lines.map(l => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxPercent: l.taxPercent, lineTotal: l.quantity * l.unitPrice * (1 + l.taxPercent / 100) })),
    generatedAt: new Date().toISOString(),
  };
}

export type ReceiptLookup = NonNullable<Awaited<ReturnType<typeof findByReceiptToken>>>;

/** Writes the receipt/invoice PDF (headers included) to the response stream. */
export function renderReceiptPdf(found: ReceiptLookup, res: Writable & { setHeader(name: string, value: string): unknown }): void {
  const { entry: e, partyName, issuedBy, lines } = found;
  const isInvoice = e.kind === "receivable" && e.status !== "paid";
  const docLabel = isInvoice ? "Invoice" : "Transaction Receipt";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="ayzen-${isInvoice ? "invoice" : "receipt"}-${e.id}.pdf"`);
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#00a89f").text("AYZEN", { continued: true }).fillColor("#333").fontSize(12).text(`  ·  ${docLabel}`);
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor("#888").text(`${isInvoice ? "Invoice" : "Receipt"} #${isInvoice ? `INV-${e.id}` : e.id}  ·  Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1.2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(1);

  const row = (label: string, value: string) => {
    doc.fontSize(10).fillColor("#888").text(label, 50, doc.y, { continued: false, width: 150 });
    doc.fontSize(12).fillColor("#111").text(value, 210, doc.y - doc.currentLineHeight(), { width: 335 });
    doc.moveDown(0.7);
  };

  row("Type", e.kind.charAt(0).toUpperCase() + e.kind.slice(1));
  row("Title", e.title);
  if (!lines.length) row("Amount", `${e.currency} ${e.amount.toLocaleString()}`);
  if (partyName) row(isInvoice ? "Bill to" : "Party", partyName);
  if (e.category) row("Category", e.category);
  row("Status", e.status.charAt(0).toUpperCase() + e.status.slice(1));
  row("Date", new Date(e.occurredDate).toLocaleDateString());
  if (e.dueDate) row("Due date", new Date(e.dueDate).toLocaleDateString());
  if (e.interestRate != null) row("Interest rate", `${e.interestRate}%`);
  if (e.interestPaid) row("Interest paid", `${e.currency} ${e.interestPaid.toLocaleString()}`);
  if (issuedBy) row("Issued by", issuedBy);

  if (lines.length) {
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
    doc.moveDown(0.6);
    const colX = { desc: 50, qty: 300, price: 360, tax: 435, total: 480 };
    doc.fontSize(9).fillColor("#888")
      .text("Description", colX.desc, doc.y, { width: 240, continued: false })
      .text("Qty", colX.qty, doc.y - doc.currentLineHeight(), { width: 50 })
      .text("Price", colX.price, doc.y - doc.currentLineHeight(), { width: 65 })
      .text("Tax%", colX.tax, doc.y - doc.currentLineHeight(), { width: 45 })
      .text("Total", colX.total, doc.y - doc.currentLineHeight(), { width: 65 });
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#eee").stroke();
    doc.moveDown(0.3);
    let subtotal = 0, taxTotal = 0;
    for (const l of lines) {
      const lineBase = l.quantity * l.unitPrice;
      const lineTax = lineBase * (l.taxPercent / 100);
      subtotal += lineBase; taxTotal += lineTax;
      const y = doc.y;
      doc.fontSize(10).fillColor("#111")
        .text(l.description, colX.desc, y, { width: 240 })
        .text(String(l.quantity), colX.qty, y, { width: 50 })
        .text(l.unitPrice.toLocaleString(), colX.price, y, { width: 65 })
        .text(l.taxPercent ? `${l.taxPercent}%` : "—", colX.tax, y, { width: 45 })
        .text((lineBase + lineTax).toLocaleString(), colX.total, y, { width: 65 });
      doc.moveDown(0.6);
    }
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#eee").stroke();
    doc.moveDown(0.5);
    const totalsRow = (label: string, value: string, bold = false) => {
      doc.fontSize(bold ? 12 : 10).fillColor(bold ? "#111" : "#888").text(label, 360, doc.y, { width: 120 });
      doc.fontSize(bold ? 12 : 10).fillColor("#111").text(`${e.currency} ${value}`, colX.total, doc.y - doc.currentLineHeight(), { width: 65 });
      doc.moveDown(0.5);
    };
    totalsRow("Subtotal", subtotal.toLocaleString());
    if (taxTotal > 0) totalsRow("Tax", taxTotal.toLocaleString());
    totalsRow("Total", e.amount.toLocaleString(), true);
  }

  if (e.notes) {
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#888").text("Notes");
    doc.fontSize(11).fillColor("#111").text(e.notes, { width: 495 });
  }

  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#ddd").stroke();
  doc.moveDown(0.6);
  doc.fontSize(8).fillColor("#aaa").text(
    isInvoice
      ? "This is a system-generated invoice from AYZEN Finance. Anyone with this link can view it."
      : "This is a system-generated receipt from AYZEN Finance. Anyone with this link can view it.",
    { width: 495 },
  );

  doc.end();
}
