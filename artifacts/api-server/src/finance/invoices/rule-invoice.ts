import { db, financeInvoicesTable, usersTable, type FinanceRecurringRule } from "@workspace/db";
import { eq } from "drizzle-orm";
import { formatInvoiceNumber } from "../domain/invoice-format";
import { resolveBookId } from "../ledger/books";
import { sendInvoiceEmail } from "../../lib/email";
import { sendToUserWithButton } from "../../lib/telegram";
import { generateInvoiceToken, financeInvoiceUrl } from "./links";
import { logInvoiceEvent } from "./events";
import { replaceInvoiceLineItemsInTx } from "./store";

/**
 * Mints + auto-sends an invoice for a just-materialized recurring entry
 * (finance/jobs/recurring.ts, rule.autoInvoice) — same create+send path
 * as the manual routes/finance-invoices.ts POST /finance/invoices +
 * POST /finance/invoices/:id/send, collapsed into one call since there's no
 * request/response round trip here. Never throws — a failed auto-invoice
 * shouldn't take down the recurring sweep that's creating real ledger entries.
 *
 * Moved from lib/finance-invoice.ts (FIN-WP-6a). Only change: F15, the invoice row, its line items and its
 * number are written in one transaction (previously three statements, so a failure left a numberless,
 * lineless invoice behind). Sending stays after the commit and best-effort, as before.
 */
export async function createAndSendRuleInvoice(
  entry: { id: number; userId: number; bookId: number | null; amount: number; currency: string; occurredDate: Date; title: string },
  rule: Pick<FinanceRecurringRule, "id" | "invoiceDebtorName" | "invoiceDebtorEmail" | "invoiceDebtorTelegramChatId" | "invoiceDueDays">,
): Promise<void> {
  try {
    if (!rule.invoiceDebtorName || (!rule.invoiceDebtorEmail && !rule.invoiceDebtorTelegramChatId)) return;
    const bookId = await resolveBookId(entry.userId, entry.bookId);
    const dueDate = new Date(entry.occurredDate);
    dueDate.setDate(dueDate.getDate() + (rule.invoiceDueDays ?? 7));

    const invoice = await db.transaction(async (tx) => {
      const [created] = await tx.insert(financeInvoicesTable).values({
        userId: entry.userId,
        entryId: entry.id,
        bookId,
        debtorName: rule.invoiceDebtorName!,
        debtorEmail: rule.invoiceDebtorEmail ?? null,
        debtorTelegramChatId: rule.invoiceDebtorTelegramChatId ?? null,
        amount: entry.amount,
        currency: entry.currency,
        dueDate,
        notes: `Auto-generated from recurring rule #${rule.id}`,
        invoiceToken: generateInvoiceToken(),
        recurringRuleId: rule.id,
      }).returning();

      await replaceInvoiceLineItemsInTx(tx, created.id, [{ description: entry.title, quantity: 1, unitPrice: entry.amount }]);

      const [creditorForNumber] = await tx.select({ prefix: usersTable.financeInvoiceNumberPrefix }).from(usersTable).where(eq(usersTable.id, entry.userId));
      await tx.update(financeInvoicesTable)
        .set({ invoiceNumber: formatInvoiceNumber(creditorForNumber?.prefix, created.id, created.createdAt) })
        .where(eq(financeInvoicesTable.id, created.id));
      return created;
    });

    const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, entry.userId));
    const creditorName = creditor?.username ?? "Someone on AYZEN";
    const url = financeInvoiceUrl(invoice.invoiceToken);
    const amountStr = `${invoice.currency} ${invoice.amount.toLocaleString()}`;

    let sentEmail = false, sentTelegram = false;
    if (invoice.debtorEmail) {
      const result = await sendInvoiceEmail(invoice.debtorEmail, {
        debtorName: invoice.debtorName, creditorName, title: entry.title, amount: amountStr,
        dueDate: dueDate.toLocaleDateString(), notes: invoice.notes, url,
      });
      sentEmail = result.success;
    }
    if (invoice.debtorTelegramChatId) {
      await sendToUserWithButton(
        invoice.debtorTelegramChatId,
        `📄 *Invoice from ${creditorName}*\n\nAmount: *${amountStr}*\n\nTap below to see payment details and repay.`,
        "💳 Repay Now",
        url,
      );
      sentTelegram = true;
    }

    await db.update(financeInvoicesTable).set({
      sentViaEmail: sentEmail ? 1 : 0, sentViaTelegram: sentTelegram ? 1 : 0,
      lastSentAt: new Date(), updatedAt: new Date(),
    }).where(eq(financeInvoicesTable.id, invoice.id));

    logInvoiceEvent(invoice.id, sentEmail && sentTelegram ? "sent_email_telegram" : sentEmail ? "sent_email" : sentTelegram ? "sent_telegram" : "send_failed");
  } catch { /* recurring sweep must never fail because auto-invoicing failed */ }
}
