import type { Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  financeInvoicesTable,
  financeInvoiceEventsTable,
  financePaymentAgreementsTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  usersTable,
} from "@workspace/db";
import { computeInvoiceTotals, type InvoiceLineItemInput } from "../domain/invoice-totals";
import { formatInvoiceNumber } from "../domain/invoice-format";
import { REPAYABLE_KINDS, postRepaymentReversalJournalInTx } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";
import { listActivePaymentMethods, PAYMENT_METHOD_LABELS } from "../payment-methods/payment-methods";
import { generateInvoiceToken, generateAgreementToken, financeInvoiceUrl, financePaymentAgreementUrl, generateInvoicePayLinkQrDataUrl } from "../invoices/links";
import { logInvoiceEvent, type InvoiceEventRequest } from "../invoices/events";
import { getInvoiceByToken, getInvoiceLineItems, replaceInvoiceLineItemsInTx, getCreditorProfile } from "../invoices/store";
import { streamInvoicePdf, type InvoiceBranding } from "../invoices/pdf";
import { iso, money } from "../invoices/format";
import { sendInvoiceEmail, sendPaymentAgreementEmail } from "../../lib/email";
import { sendToUserWithButton } from "../../lib/telegram";
import { createNotification } from "../../lib/create-notification";

// Creditor-side and public-link invoice use cases: list, create, line-item edit, detail, PDF, send, cancel,
// public view and PDF, payment-claim submission, and reopen after a dispute. Moved from routes/finance-invoices.ts
// (FIN-WP-6a). The route keeps authentication, id parsing, request-shape validation, the PDP ownership checks,
// the Express-specific PDF streaming call and response formatting (dates via iso). Messages and status mapping
// are the exact ones the routes returned. The six payment-agreement handlers (public view, passkey options and
// verify, evidence PDF, verify, dispute) moved to application/payment-agreements.ts in WP-6b.
//
// Logic changes, all recorded in finance-safety-findings.md and covered by wp6a-use-cases.db.test.ts:
//  - F15 create is one transaction (invoice row, number, line items); replaceInvoiceLineItems is atomic.
//  - F16 the line-item edit runs under a row lock and re-checks "no payment claim yet" inside the transaction,
//    so a claim cannot land between the check and the edit. Amount, discount and tax are written with the lines.
//  - F17 status changes made by send, the public view and reopen are conditional in SQL instead of derived from
//    a previously read value, so they can no longer overwrite a status that changed in between (for example send
//    turning a just-submitted payment back into "sent" while its email was still going out).
//  - F18 submitting a payment claim is one transaction under the invoice row lock (status checks, remaining
//    balance, agreement insert and status flip), and a claim must be a positive, finite amount.
//  - F22 (WP-6b) cancelling is one transaction under the invoice row lock and refuses a settled invoice.
// Best-effort notifications and evidence events stay fire-and-forget after the commit, as before.

type InvoiceRow = typeof financeInvoicesTable.$inferSelect;

// ─── Request-shape helpers ───────────────────────────────────────────────────

/**
 * Accepts either the new `lineItems: [{description, quantity, unitPrice}]`
 * shape or the legacy single `amount` (kept working as a one-line invoice
 * named after the notes/a generic label, so old integrations and the
 * recurring-rule auto-invoice path don't need to change).
 */
export function parseLineItemsFromBody(body: Record<string, any>): InvoiceLineItemInput[] {
  if (Array.isArray(body.lineItems) && body.lineItems.length > 0) {
    return body.lineItems.map((l: any) => ({
      description: String(l.description ?? "").trim(),
      quantity: Number(l.quantity) || 1,
      unitPrice: Number(l.unitPrice) || 0,
    }));
  }
  if (body.amount) {
    return [{ description: "Invoice total", quantity: 1, unitPrice: Number(body.amount) }];
  }
  return [];
}

export function brandingFromUser(u: {
  financeInvoiceLogoUrl: string | null;
  financeInvoiceThemeColor: string | null;
  financeInvoiceBusinessName: string | null;
  financeInvoiceBusinessAddress: string | null;
  financeInvoiceFooterNote: string | null;
  financeInvoiceTaxId?: string | null;
  financeInvoiceBusinessEmail?: string | null;
  financeInvoiceBusinessPhone?: string | null;
  financeInvoiceWebsite?: string | null;
  financeInvoiceTerms?: string | null;
} | undefined): InvoiceBranding {
  return {
    logoUrl: u?.financeInvoiceLogoUrl ?? null,
    themeColor: u?.financeInvoiceThemeColor ?? null,
    businessName: u?.financeInvoiceBusinessName ?? null,
    businessAddress: u?.financeInvoiceBusinessAddress ?? null,
    footerNote: u?.financeInvoiceFooterNote ?? null,
    taxId: u?.financeInvoiceTaxId ?? null,
    businessEmail: u?.financeInvoiceBusinessEmail ?? null,
    businessPhone: u?.financeInvoiceBusinessPhone ?? null,
    website: u?.financeInvoiceWebsite ?? null,
    termsText: u?.financeInvoiceTerms ?? null,
  };
}

const lineInputs = (lines: Array<{ description: string; quantity: number; unitPrice: number }>): InvoiceLineItemInput[] =>
  lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice }));

// ─── Ownership lookup for the PDP resource builders ──────────────────────────

/** The creditor's user id for an invoice, or undefined when it does not exist. Used by the route's PDP checks. */
export async function findInvoiceOwnerId(invoiceId: number): Promise<number | undefined> {
  const [row] = await db.select({ userId: financeInvoicesTable.userId }).from(financeInvoicesTable)
    .where(eq(financeInvoicesTable.id, invoiceId)).limit(1);
  return row?.userId;
}

// ─── Creditor side ───────────────────────────────────────────────────────────

export async function listInvoices(userId: number, entryId?: number): Promise<InvoiceRow[]> {
  const conditions = [eq(financeInvoicesTable.userId, userId)];
  if (entryId) conditions.push(eq(financeInvoicesTable.entryId, entryId));

  return db.select().from(financeInvoicesTable)
    .where(and(...conditions))
    .orderBy(desc(financeInvoicesTable.createdAt));
}

export type CreateInvoiceResult =
  | { status: "ok"; invoice: InvoiceRow; lineItems: Awaited<ReturnType<typeof getInvoiceLineItems>> }
  | { status: "entry_not_found" }
  | { status: "entry_not_repayable"; kind: string };

/** Caller must have validated debtorName, at least one described line item, and a debtor email or Telegram chat id. */
export async function createInvoice(userId: number, body: Record<string, any>, lineItems: InvoiceLineItemInput[]): Promise<CreateInvoiceResult> {
  // If linked to an existing entry, confirm ownership so an invoice can't be
  // minted against someone else's ledger row. Also confirm the entry's kind
  // actually supports repayments — the payment-agreement verify flow
  // posts a real repayment against invoice.entryId once the payer confirms,
  // and the ledger's KIND_REPAYMENT_POSTING has no mapping
  // for 'expense'/'income' (immediate cash transactions, nothing "owed"),
  // so allowing an invoice to link there would let a payer "pay off" an
  // entry that silently never posts to the double-entry books.
  if (body.entryId) {
    const [entry] = await db.select({ id: financeLedgerEntriesTable.id, kind: financeLedgerEntriesTable.kind }).from(financeLedgerEntriesTable)
      .where(and(eq(financeLedgerEntriesTable.id, body.entryId), eq(financeLedgerEntriesTable.userId, userId)));
    if (!entry) return { status: "entry_not_found" };
    if (!REPAYABLE_KINDS.has(entry.kind)) return { status: "entry_not_repayable", kind: entry.kind };
  }

  const bookId = await resolveBookId(userId, body.bookId ?? null);
  const discountType = body.discountType === "flat" || body.discountType === "percent" ? body.discountType : null;
  const discountValue = discountType ? (Number(body.discountValue) || 0) : 0;
  const taxRate = Number(body.taxRate) > 0 ? Math.min(Number(body.taxRate), 100) : 0;
  const totals = computeInvoiceTotals(lineItems, { discountType, discountValue, taxRate });

  // F15: the row, its number and its lines commit together.
  const numbered = await db.transaction(async (tx) => {
    const [row] = await tx.insert(financeInvoicesTable).values({
      userId,
      entryId: body.entryId ?? null,
      bookId,
      debtorName: body.debtorName,
      debtorEmail: body.debtorEmail ?? null,
      debtorTelegramChatId: body.debtorTelegramChatId ?? null,
      amount: totals.total,
      currency: body.currency ?? "BDT",
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      notes: body.notes ?? null,
      poNumber: body.poNumber ?? null,
      discountType, discountValue, taxRate,
      taxLabel: body.taxLabel ?? "Tax",
      terms: body.terms ?? null,
      invoiceToken: generateInvoiceToken(),
    }).returning();

    const [creditorForNumber] = await tx.select({ prefix: usersTable.financeInvoiceNumberPrefix }).from(usersTable).where(eq(usersTable.id, userId));
    const invoiceNumber = formatInvoiceNumber(creditorForNumber?.prefix, row.id, row.createdAt);
    const [updated] = await tx.update(financeInvoicesTable).set({ invoiceNumber }).where(eq(financeInvoicesTable.id, row.id)).returning();

    await replaceInvoiceLineItemsInTx(tx, row.id, lineItems);
    return updated;
  });

  return { status: "ok", invoice: numbered, lineItems: await getInvoiceLineItems(numbered.id) };
}

export type UpdateInvoiceLineItemsResult =
  | { status: "ok"; invoice: InvoiceRow; lineItems: Awaited<ReturnType<typeof getInvoiceLineItems>> }
  | { status: "not_found" }
  | { status: "locked" };

/**
 * Replaces every line item on an invoice and recomputes its total — blocked once money has actually moved
 * against it (a payment claim submitted or verified), same as the rest of this file protects a settled invoice
 * from being quietly edited out from under a debtor who already paid. Caller must have validated that `lines`
 * is a non-empty array and that the caller owns the invoice (PDP).
 */
export async function updateInvoiceLineItems(
  userId: number, invoiceId: number, body: Record<string, any>, lines: any[],
): Promise<UpdateInvoiceLineItemsResult> {
  const result = await db.transaction(async (tx): Promise<{ status: "ok"; invoice: InvoiceRow } | { status: "not_found" } | { status: "locked" }> => {
    // F16: lock the invoice so a payment claim (which locks it too) cannot land between this check and the edit.
    const [invoice] = await tx.select().from(financeInvoicesTable)
      .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)))
      .for("update");
    if (!invoice) return { status: "not_found" };
    if (invoice.paidAmount > 0 || !["sent", "viewed"].includes(invoice.status)) return { status: "locked" };

    const parsed = parseLineItemsFromBody({ lineItems: lines });
    await replaceInvoiceLineItemsInTx(tx, invoiceId, parsed);

    const discountType = "discountType" in body ? (body.discountType === "flat" || body.discountType === "percent" ? body.discountType : null) : invoice.discountType;
    const discountValue = "discountValue" in body ? (Number(body.discountValue) || 0) : invoice.discountValue;
    const taxRate = "taxRate" in body ? Math.min(Math.max(Number(body.taxRate) || 0, 0), 100) : invoice.taxRate;
    const totals = computeInvoiceTotals(parsed, { discountType, discountValue, taxRate });

    const patch: Record<string, any> = { amount: totals.total, discountType, discountValue, taxRate, updatedAt: new Date() };
    if ("poNumber" in body) patch.poNumber = body.poNumber || null;
    if ("terms" in body) patch.terms = body.terms || null;
    if ("taxLabel" in body) patch.taxLabel = body.taxLabel || "Tax";

    const [row] = await tx.update(financeInvoicesTable).set(patch)
      .where(eq(financeInvoicesTable.id, invoiceId)).returning();
    return { status: "ok", invoice: row };
  });
  if (result.status !== "ok") return result;
  return { status: "ok", invoice: result.invoice, lineItems: await getInvoiceLineItems(invoiceId) };
}

export async function getInvoiceDetail(userId: number, invoiceId: number) {
  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)));
  if (!invoice) return null;

  const events = await db.select().from(financeInvoiceEventsTable)
    .where(eq(financeInvoiceEventsTable.invoiceId, invoiceId)).orderBy(desc(financeInvoiceEventsTable.createdAt));
  const agreements = await db.select().from(financePaymentAgreementsTable)
    .where(eq(financePaymentAgreementsTable.invoiceId, invoiceId)).orderBy(desc(financePaymentAgreementsTable.createdAt));
  const lineItems = await getInvoiceLineItems(invoiceId);
  return { invoice, events, agreements, lineItems };
}

/**
 * Shared by the creditor-authenticated and the public token-gated PDF
 * routes — same branded, itemized document either way, just reached
 * two different ways. Loads the creditor's branding + default payment
 * method QR + the invoice's own pay-link QR (both QR codes appear).
 */
async function streamInvoicePdfFor(res: Response, invoice: InvoiceRow, creditorUserId: number): Promise<void> {
  const creditor = await getCreditorProfile(creditorUserId);
  const lineItems = await getInvoiceLineItems(invoice.id);
  const methods = await listActivePaymentMethods(creditorUserId);
  const defaultMethod = methods.find(m => m.isDefault) ?? methods[0] ?? null;
  const payLinkQrDataUrl = await generateInvoicePayLinkQrDataUrl(financeInvoiceUrl(invoice.invoiceToken));
  const totals = computeInvoiceTotals(
    lineInputs(lineItems),
    { discountType: invoice.discountType, discountValue: invoice.discountValue, taxRate: invoice.taxRate },
  );

  await streamInvoicePdf(res, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber || formatInvoiceNumber(creditor?.financeInvoiceNumberPrefix, invoice.id, invoice.createdAt),
    poNumber: invoice.poNumber,
    creditorName: creditor?.username ?? "AYZEN user",
    debtorName: invoice.debtorName,
    debtorEmail: invoice.debtorEmail,
    currency: invoice.currency,
    lineItems: lineInputs(lineItems),
    subtotal: totals.subtotal,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    discountAmount: totals.discountAmount,
    taxRate: invoice.taxRate,
    taxLabel: invoice.taxLabel,
    taxAmount: totals.taxAmount,
    amount: invoice.amount,
    paidAmount: invoice.paidAmount,
    issueDate: invoice.createdAt,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    terms: invoice.terms || creditor?.financeInvoiceTerms || null,
    status: invoice.status,
    branding: brandingFromUser(creditor),
    payLinkQrDataUrl,
    paymentMethodQrDataUrl: defaultMethod?.qrDataUrl ?? null,
    paymentMethodLabel: defaultMethod ? (defaultMethod.label || PAYMENT_METHOD_LABELS[defaultMethod.methodType]) : null,
  });
}

/** Creditor's own copy. Returns false (nothing written to `res`) when the invoice is missing or not the caller's. */
export async function streamCreditorInvoicePdf(res: Response, userId: number, invoiceId: number): Promise<boolean> {
  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)));
  if (!invoice) return false;
  await streamInvoicePdfFor(res, invoice, userId);
  return true;
}

/** Public copy, addressed by invoice token. Returns false when the link is invalid or the invoice was cancelled. */
export async function streamPublicInvoicePdf(res: Response, token: string): Promise<boolean> {
  const invoice = await getInvoiceByToken(token);
  if (!invoice || invoice.status === "cancelled") return false;
  await streamInvoicePdfFor(res, invoice, invoice.userId);
  return true;
}

export type SendInvoiceResult = { status: "ok"; sentEmail: boolean; sentTelegram: boolean; url: string } | { status: "not_found" };

export async function sendInvoice(userId: number, invoiceId: number, channels: string[] | undefined, req: InvoiceEventRequest): Promise<SendInvoiceResult> {
  const wantEmail = !channels || channels.includes("email");
  const wantTelegram = !channels || channels.includes("telegram");

  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)));
  if (!invoice) return { status: "not_found" };

  const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, userId));
  const creditorName = creditor?.username ?? "Someone on AYZEN";
  const url = financeInvoiceUrl(invoice.invoiceToken);
  const amountStr = money(invoice.currency, invoice.amount);

  let sentEmail = false, sentTelegram = false;

  if (wantEmail && invoice.debtorEmail) {
    const result = await sendInvoiceEmail(invoice.debtorEmail, {
      debtorName: invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`, amount: amountStr,
      dueDate: invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : null, notes: invoice.notes, url,
    });
    sentEmail = result.success;
  }
  if (wantTelegram && invoice.debtorTelegramChatId) {
    await sendToUserWithButton(
      invoice.debtorTelegramChatId,
      `📄 *Invoice from ${creditorName}*\n\nAmount: *${amountStr}*\n\nTap below to see payment details and repay.`,
      "💳 Repay Now",
      url,
    );
    sentTelegram = true;
  }

  // F17: sending can take seconds. The status is decided by the database at write time (a "sent"/"viewed"
  // invoice goes to "sent", anything else keeps its status), not from the row read before the email went out, so
  // a payment claim submitted in the meantime is not overwritten. The sent-via flags are only ever raised.
  await db.update(financeInvoicesTable).set({
    status: sql`CASE WHEN ${financeInvoicesTable.status} IN ('sent', 'viewed') THEN 'sent' ELSE ${financeInvoicesTable.status} END`,
    ...(sentEmail ? { sentViaEmail: 1 } : {}),
    ...(sentTelegram ? { sentViaTelegram: 1 } : {}),
    lastSentAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)));

  logInvoiceEvent(invoiceId, sentEmail && sentTelegram ? "sent_email_telegram" : sentEmail ? "sent_email" : sentTelegram ? "sent_telegram" : "send_failed", req)
    .catch(() => {});

  return { status: "ok", sentEmail, sentTelegram, url };
}

export type CancelInvoiceResult =
  | { status: "ok"; reversedAmount?: number }
  | { status: "not_found" }
  | { status: "already_paid" };

/**
 * Cancels the caller's invoice.
 *
 * F22: a settled invoice ("paid" or "creditor_verified") is NOT cancelled by a plain cancel, because that left its paid
 * amount and the repayments posted against the entry in place while the invoice said "cancelled".
 *
 * Appeal path (`opts.reversePayments`): when a verified payment turns out not to have been received (fake or reversed
 * payment), the creditor can cancel the invoice and reverse what that payment did, in ONE transaction under the
 * invoice row lock:
 *  - every creditor-verified claim on the invoice is marked "disputed" with the creditor's reason (no schema change:
 *    the dispute columns already exist),
 *  - the repayment row each verify posted against the linked entry is deleted and its amount is added back to the
 *    entry (status goes to "partial" if other principal repayments remain, otherwise "pending"; the late-fee job
 *    moves it to "overdue" again if it is),
 *  - a contra journal entry reverses the repayment's journal (only if that journal exists and is not reversed yet),
 *  - the invoice's paid amount drops by what was reversed and the invoice becomes "cancelled".
 * Without the reason the settled-invoice refusal stands. Every other status can still be cancelled as before; a
 * partly paid invoice cancelled WITHOUT the reversal keeps its paid amount, as before.
 */
export async function cancelInvoice(
  userId: number, invoiceId: number,
  opts?: { reversePayments?: { reason: string }; req?: InvoiceEventRequest },
): Promise<CancelInvoiceResult> {
  const reversal = opts?.reversePayments;
  const outcome = await db.transaction(async (tx): Promise<CancelInvoiceResult> => {
    const [invoice] = await tx.select().from(financeInvoicesTable)
      .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId))).limit(1).for("update");
    if (!invoice) return { status: "not_found" };
    const settled = invoice.status === "paid" || invoice.status === "creditor_verified";
    if (settled && !reversal) return { status: "already_paid" };

    let reversedAmount = 0;
    if (reversal) {
      // Same lock order as verify and dispute: invoice first, then its agreements.
      const verified = await tx.select().from(financePaymentAgreementsTable)
        .where(and(eq(financePaymentAgreementsTable.invoiceId, invoiceId), eq(financePaymentAgreementsTable.status, "creditor_verified")))
        .for("update");
      const now = new Date();
      for (const agreement of verified) {
        if (invoice.entryId) {
          const [entry] = await tx.select().from(financeLedgerEntriesTable)
            .where(and(eq(financeLedgerEntriesTable.id, invoice.entryId), eq(financeLedgerEntriesTable.userId, userId))).for("update");
          if (entry && REPAYABLE_KINDS.has(entry.kind)) {
            // The repayment this verify posted is recognised by the note verify wrote; deleting it is what proves the
            // money is added back only when it was actually taken off.
            const notePrefix = `Verified from Payment Agreement #${agreement.id} (`;
            const posted = await tx.select({ id: financeRepaymentsTable.id, notes: financeRepaymentsTable.notes })
              .from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, entry.id));
            const mine = posted.find((r) => (r.notes ?? "").startsWith(notePrefix));
            if (mine) {
              await tx.delete(financeRepaymentsTable).where(eq(financeRepaymentsTable.id, mine.id));
              await tx.update(financeLedgerEntriesTable).set({
                amount: sql`${financeLedgerEntriesTable.amount} + ${agreement.amount}`,
                status: sql`CASE WHEN EXISTS (SELECT 1 FROM finance_repayments r WHERE r.entry_id = ${entry.id} AND r.is_interest = 0) THEN 'partial' ELSE 'pending' END`,
                updatedAt: now,
              }).where(eq(financeLedgerEntriesTable.id, entry.id));
              await postRepaymentReversalJournalInTx(tx, entry, agreement.amount);
            }
          }
        }
        await tx.update(financePaymentAgreementsTable).set({
          status: "disputed", disputedAt: now, disputedBy: userId,
          disputeReason: `Payment reversed by the creditor: ${reversal.reason}`, updatedAt: now,
        }).where(eq(financePaymentAgreementsTable.id, agreement.id));
        reversedAmount += agreement.amount;
      }
    }

    await tx.update(financeInvoicesTable).set({
      status: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
      ...(reversal ? { paidAmount: sql`GREATEST(0, ${financeInvoicesTable.paidAmount} - ${reversedAmount})` } : {}),
    }).where(eq(financeInvoicesTable.id, invoiceId));
    return reversal && reversedAmount > 0 ? { status: "ok", reversedAmount } : { status: "ok" };
  });
  if (outcome.status === "ok" && outcome.reversedAmount && opts?.req) {
    logInvoiceEvent(invoiceId, "payment_reversed_cancelled", opts.req, { reversedAmount: outcome.reversedAmount, reason: reversal?.reason }).catch(() => {});
  }
  return outcome;
}

export type ReopenInvoiceResult = { status: "ok"; invoice: InvoiceRow } | { status: "not_found" } | { status: "not_disputed" };

/**
 * Creditor's counterpart to dispute(): the dispute handler sets the invoice to a real "disputed" status, and the
 * public submit-payment route refuses a fresh claim while it is "disputed", so without this a disputed invoice
 * was permanently stuck. Lands back on whichever non-terminal status reflects reality: "partially_paid" if a
 * prior verified agreement already paid some of it (still allows a fresh claim for the remainder), otherwise
 * "viewed" so the payer sees the normal payment form again.
 */
export async function reopenInvoice(userId: number, invoiceId: number, req: InvoiceEventRequest): Promise<ReopenInvoiceResult> {
  const [invoice] = await db.select().from(financeInvoicesTable)
    .where(and(eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId)));
  if (!invoice) return { status: "not_found" };
  if (invoice.status !== "disputed") return { status: "not_disputed" };

  // F17: claim the reopen only while the invoice is still disputed, and pick the landing status from the paid
  // amount the database holds now (an agreement verified in the meantime must not be overwritten by a stale view).
  const [row] = await db.update(financeInvoicesTable).set({
    status: sql`CASE WHEN ${financeInvoicesTable.paidAmount} > 0 THEN 'partially_paid' ELSE 'viewed' END`,
    updatedAt: new Date(),
  }).where(and(
    eq(financeInvoicesTable.id, invoiceId), eq(financeInvoicesTable.userId, userId), eq(financeInvoicesTable.status, "disputed"),
  )).returning();
  if (!row) return { status: "not_disputed" };

  logInvoiceEvent(invoiceId, "reopened_after_dispute", req).catch(() => {});
  return { status: "ok", invoice: row };
}

// ─── Public "Repay" page ─────────────────────────────────────────────────────

export type PublicInvoiceView = Record<string, unknown>;

/** The public invoice page payload (dates as ISO strings), or null when the link is invalid or cancelled. */
export async function getPublicInvoiceView(token: string, req: InvoiceEventRequest): Promise<PublicInvoiceView | null> {
  const invoice = await getInvoiceByToken(token);
  if (!invoice || invoice.status === "cancelled") return null;

  const creditor = await getCreditorProfile(invoice.userId);
  const paymentMethods = await listActivePaymentMethods(invoice.userId);
  const lineItems = await getInvoiceLineItems(invoice.id);
  const payLinkQrDataUrl = await generateInvoicePayLinkQrDataUrl(financeInvoiceUrl(invoice.invoiceToken));

  if (invoice.status === "sent") {
    // F17: only flip "sent" to "viewed". An unconditional update here could turn a status that had just changed
    // (a payment claim submitted a moment ago) back into "viewed". The view event is logged once, by the winner.
    const [claimed] = await db.update(financeInvoicesTable).set({ status: "viewed", updatedAt: new Date() })
      .where(and(eq(financeInvoicesTable.id, invoice.id), eq(financeInvoicesTable.status, "sent")))
      .returning({ id: financeInvoicesTable.id });
    if (claimed) logInvoiceEvent(invoice.id, "viewed", req).catch(() => {});
  }

  const totals = computeInvoiceTotals(
    lineInputs(lineItems),
    { discountType: invoice.discountType, discountValue: invoice.discountValue, taxRate: invoice.taxRate },
  );

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber || formatInvoiceNumber(creditor?.financeInvoiceNumberPrefix, invoice.id, invoice.createdAt),
    poNumber: invoice.poNumber,
    creditorName: creditor?.username ?? "AYZEN user",
    debtorName: invoice.debtorName,
    amount: invoice.amount,
    currency: invoice.currency,
    subtotal: totals.subtotal,
    discountType: invoice.discountType,
    discountValue: invoice.discountValue,
    discountAmount: totals.discountAmount,
    taxRate: invoice.taxRate,
    taxLabel: invoice.taxLabel,
    taxAmount: totals.taxAmount,
    issueDate: iso(invoice.createdAt),
    dueDate: iso(invoice.dueDate),
    notes: invoice.notes,
    terms: invoice.terms || creditor?.financeInvoiceTerms || null,
    status: invoice.status,
    paidAmount: invoice.paidAmount,
    remainingAmount: Math.max(0, invoice.amount - invoice.paidAmount),
    lineItems,
    branding: brandingFromUser(creditor),
    payLinkQrDataUrl,
    paymentMethods,
  };
}

export type SubmitPaymentResult =
  | { status: "ok"; agreementToken: string; agreementUrl: string }
  | { status: "invalid_link" }
  | { status: "already_paid" }
  | { status: "disputed" }
  | { status: "invalid_amount" }
  | { status: "exceeds_remaining"; currency: string; remaining: number }
  | { status: "pending_claims"; currency: string; pending: number; available: number };

/**
 * A logged-in payer says they paid: records the claim (a payment agreement in "submitted") and moves the invoice
 * to "payment_submitted". Caller must have validated that methodType is present. The creditor is notified and the
 * payer gets their "Confirm Payment" link after the commit, best-effort as before.
 */
export async function submitInvoicePayment(
  payerUserId: number, token: string,
  input: { methodType: string; referenceId?: string; amount?: number },
  req: InvoiceEventRequest,
): Promise<SubmitPaymentResult> {
  const { methodType, referenceId, amount } = input;

  // F18: the checks, the remaining balance, the agreement insert and the status flip happen under the invoice row
  // lock, so a concurrent verify, edit or second claim cannot slip in between them, and the status flip can no
  // longer resurrect a "paid" invoice.
  const outcome = await db.transaction(async (tx): Promise<
    | { status: "ok"; invoice: InvoiceRow; agreement: typeof financePaymentAgreementsTable.$inferSelect }
    | Exclude<SubmitPaymentResult, { status: "ok" }>
  > => {
    const [invoice] = await tx.select().from(financeInvoicesTable)
      .where(eq(financeInvoicesTable.invoiceToken, token)).limit(1).for("update");
    if (!invoice || invoice.status === "cancelled") return { status: "invalid_link" };
    if (invoice.status === "paid" || invoice.status === "creditor_verified") return { status: "already_paid" };
    if (invoice.status === "disputed") return { status: "disputed" };

    const remaining = Math.max(0, invoice.amount - invoice.paidAmount);
    // Claims still waiting for the creditor (submitted or passkey-confirmed) count against the balance, so a payer
    // cannot queue claims that add up to more than is owed. They stop counting once verified (paidAmount) or disputed.
    const [pendingRow] = await tx.select({ total: sql<number>`COALESCE(SUM(${financePaymentAgreementsTable.amount}), 0)::float8` })
      .from(financePaymentAgreementsTable)
      .where(and(eq(financePaymentAgreementsTable.invoiceId, invoice.id), inArray(financePaymentAgreementsTable.status, ["submitted", "passkey_confirmed"])));
    const pending = Number(pendingRow?.total ?? 0);
    const available = Math.max(0, remaining - pending);
    const claimAmount = Number(amount ?? available);
    // A claim must be a real, positive amount: a zero, negative or non-numeric claim would, once verified, lower
    // paidAmount and push money back onto the linked entry.
    if (!Number.isFinite(claimAmount) || claimAmount <= 0) {
      return pending > 0 && available <= 0.01 && amount === undefined
        ? { status: "pending_claims", currency: invoice.currency, pending, available }
        : { status: "invalid_amount" };
    }
    if (claimAmount > remaining + 0.01) return { status: "exceeds_remaining", currency: invoice.currency, remaining };
    if (claimAmount > available + 0.01) return { status: "pending_claims", currency: invoice.currency, pending, available };

    const [agreement] = await tx.insert(financePaymentAgreementsTable).values({
      invoiceId: invoice.id,
      payerUserId,
      methodType,
      referenceId: referenceId ?? null,
      amount: claimAmount,
      submittedAt: new Date(),
      agreementToken: generateAgreementToken(),
    }).returning();

    await tx.update(financeInvoicesTable).set({ status: "payment_submitted", updatedAt: new Date() }).where(eq(financeInvoicesTable.id, invoice.id));
    return { status: "ok", invoice, agreement };
  });
  if (outcome.status !== "ok") return outcome;
  const { invoice, agreement } = outcome;

  logInvoiceEvent(invoice.id, "payment_submitted", req, { methodType, referenceId, amount: agreement.amount }).catch(() => {});

  // Notify the creditor a claim came in.
  createNotification(invoice.userId, "finance_payment_submitted", "Payment submitted",
    `${invoice.debtorName} says they paid ${money(invoice.currency, agreement.amount)} via ${PAYMENT_METHOD_LABELS[methodType] ?? methodType}.`,
    { invoiceId: invoice.id, agreementId: agreement.id }).catch(() => {});

  // Send the payer their own "Confirm Payment" template — same button-based
  // pattern as the invoice email, this time leading to the Payment
  // Agreement / passkey-confirm page.
  const agreementUrl = financePaymentAgreementUrl(agreement.agreementToken);
  const [payer] = await db.select({ email: usersTable.email, username: usersTable.username, telegramChatId: usersTable.telegramChatId })
    .from(usersTable).where(eq(usersTable.id, payerUserId));
  const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, invoice.userId));
  const creditorName = creditor?.username ?? "the creditor";
  if (payer?.email) {
    sendPaymentAgreementEmail(payer.email, {
      debtorName: payer.username ?? invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
      amount: money(invoice.currency, agreement.amount), methodLabel: PAYMENT_METHOD_LABELS[methodType] ?? methodType, url: agreementUrl,
    }).catch(() => {});
  }
  if (payer?.telegramChatId) {
    sendToUserWithButton(
      payer.telegramChatId,
      `✅ *Payment noted*\n\nYou said you paid ${money(invoice.currency, agreement.amount)} to ${creditorName}. Confirm it with your passkey to keep it as evidence.`,
      "🔏 Confirm Payment",
      agreementUrl,
    ).catch(() => {});
  }

  return { status: "ok", agreementToken: agreement.agreementToken, agreementUrl };
}

// Date formatter the invoice routes use for responses; re-exported so the route imports application/* only (FIN-WP-8).
export { iso } from "../invoices/format";
