/**
 * finance/jobs/invoice-reminder.ts (moved from lib/finance-invoice-reminder-cron.ts, FIN-WP-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Overdue Finance-invoice nudge — email/Telegram, sent to the DEBTOR, once the invoice's due date has passed.
 * Distinct from jobs/reminder.ts (an in-app notification to the *creditor*, fired up to 3 days *before* a ledger
 * entry is due) — this one runs after the due date, targets whoever owes the money, and re-fires periodically
 * until the invoice is settled or cancelled. Same daily-sweep + lastReminderAt dedup shape as jobs/report-schedule.ts.
 *
 * Owner decision: invoices waiting for the creditor's review of a payment claim are not nudged (see SETTLED_STATUSES).
 *
 * Behavior changes from the legacy file (F25, see finance-safety-findings.md):
 *   - the invoice is CLAIMED (lastReminderAt and reminderCount written, conditional on it still being unsettled and
 *     due for a reminder) before anything is sent, so two overlapping sweeps nudge the debtor once;
 *   - when no channel delivered (no contact details, or the send threw) the claim is restored to the previous
 *     values, so the invoice is retried on the next sweep exactly as before.
 */
import cron from "node-cron";
import { db, financeInvoicesTable, usersTable } from "@workspace/db";
import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";
import { financeInvoiceUrl } from "../invoices/links";
import { logInvoiceEvent } from "../invoices/events";

// "disputed" is intentionally excluded from reminders: the debtor has already
// flagged the payment claim as disputed and is waiting on the creditor's
// review, so nagging them with an overdue reminder is confusing/unwanted UX.
//
// Owner decision (WP-7): "payment_submitted" and "agreement_confirmed" are excluded too — the payer says they have
// paid and the creditor has not reviewed it yet, so an "overdue" nudge is wrong until the review happens (a verify
// moves the invoice on, a dispute parks it as "disputed"). "creditor_verified" is the legacy alias of "paid".
const SETTLED_STATUSES: string[] = [
  "paid", "settled", "cancelled", "void", "disputed", "creditor_verified", "payment_submitted", "agreement_confirmed",
];

function reminderIntervalMs(): number {
  const days = Number(process.env.FINANCE_INVOICE_REMINDER_INTERVAL_DAYS ?? "3");
  return (Number.isFinite(days) && days > 0 ? days : 3) * 24 * 60 * 60 * 1000;
}

export interface OverdueEmail {
  debtorName: string; creditorName: string; title: string;
  amount: string; remainingAmount: string; daysOverdue: number; url: string;
}

export interface InvoiceReminderDeps {
  /** Clock; defaults to the current time. */
  now?: Date;
  /** Restrict the sweep to these creditors (tests and manual runs). The scheduled sweep omits it. */
  userIds?: number[];
  /** Email sender; defaults to lib/email (loaded on demand). */
  sendEmail?: (to: string, data: OverdueEmail) => Promise<{ success: boolean }>;
  /** Telegram sender; defaults to lib/telegram (loaded on demand). */
  sendTelegram?: (chatId: string, text: string, buttonLabel: string, url: string) => Promise<unknown>;
}

async function defaultSendEmail(to: string, data: OverdueEmail): Promise<{ success: boolean }> {
  const { sendInvoiceOverdueReminderEmail } = await import("../../lib/email");
  return sendInvoiceOverdueReminderEmail(to, data);
}

async function defaultSendTelegram(chatId: string, text: string, buttonLabel: string, url: string): Promise<unknown> {
  const { sendToUserWithButton } = await import("../../lib/telegram");
  return sendToUserWithButton(chatId, text, buttonLabel, url);
}

export async function runFinanceInvoiceReminderSweep(deps: InvoiceReminderDeps = {}): Promise<{ checked: number; sent: number }> {
  const now = deps.now ?? new Date();
  const sendEmail = deps.sendEmail ?? defaultSendEmail;
  const sendTelegram = deps.sendTelegram ?? defaultSendTelegram;
  const reminderCutoff = new Date(now.getTime() - reminderIntervalMs());

  const due = await db.select().from(financeInvoicesTable).where(and(
    lt(financeInvoicesTable.dueDate, now),
    notInArray(financeInvoicesTable.status, SETTLED_STATUSES),
    or(isNull(financeInvoicesTable.lastReminderAt), lt(financeInvoicesTable.lastReminderAt, reminderCutoff)),
    deps.userIds ? inArray(financeInvoicesTable.userId, deps.userIds) : undefined,
  ));

  let sent = 0;
  for (const invoice of due) {
    let claimed = false;
    let delivered = false;
    try {
      const [won] = await db.update(financeInvoicesTable).set({
        lastReminderAt: now, reminderCount: sql`${financeInvoicesTable.reminderCount} + 1`, updatedAt: now,
      }).where(and(
        eq(financeInvoicesTable.id, invoice.id),
        notInArray(financeInvoicesTable.status, SETTLED_STATUSES),
        or(isNull(financeInvoicesTable.lastReminderAt), lt(financeInvoicesTable.lastReminderAt, reminderCutoff)),
      )).returning({ id: financeInvoicesTable.id });
      if (!won) continue; // nudged by another sweep, or settled, since the read
      claimed = true;

      const [creditor] = await db.select({ username: usersTable.username }).from(usersTable).where(sql`id = ${invoice.userId}`);
      const creditorName = creditor?.username ?? "Someone on AYZEN";
      const url = financeInvoiceUrl(invoice.invoiceToken);
      const remaining = Math.max(0, invoice.amount - invoice.paidAmount);
      const daysOverdue = Math.max(0, Math.ceil((now.getTime() - new Date(invoice.dueDate!).getTime()) / 86400000));
      const amountStr = `${invoice.currency} ${invoice.amount.toLocaleString()}`;
      const remainingStr = `${invoice.currency} ${remaining.toLocaleString()}`;

      let sentEmail = false, sentTelegram = false;
      if (invoice.debtorEmail) {
        const result = await sendEmail(invoice.debtorEmail, {
          debtorName: invoice.debtorName, creditorName, title: `Invoice #${invoice.id}`,
          amount: amountStr, remainingAmount: remainingStr, daysOverdue, url,
        });
        sentEmail = result.success;
      }
      if (invoice.debtorTelegramChatId) {
        await sendTelegram(
          invoice.debtorTelegramChatId,
          `⏰ *Payment overdue*\n\nYour invoice from ${creditorName} was due ${daysOverdue} day(s) ago.\n\nRemaining: *${remainingStr}*`,
          "💳 Repay Now",
          url,
        );
        sentTelegram = true;
      }

      if (sentEmail || sentTelegram) {
        delivered = true;
        logInvoiceEvent(invoice.id, "overdue_reminder_sent", undefined, { daysOverdue, sentEmail, sentTelegram }).catch(() => {});
        sent++;
      }
    } catch (err: any) {
      logger.error({ err: err?.message, invoiceId: invoice.id }, "Failed to send overdue invoice reminder");
      logBus.error(`Overdue invoice reminder #${invoice.id} failed: ${err?.message ?? err}`);
    } finally {
      if (claimed && !delivered) {
        // Nothing reached the debtor: give the claim back (only if it is still ours) so the next sweep retries.
        await db.update(financeInvoicesTable).set({
          lastReminderAt: invoice.lastReminderAt, reminderCount: sql`${financeInvoicesTable.reminderCount} - 1`,
        }).where(and(eq(financeInvoicesTable.id, invoice.id), eq(financeInvoicesTable.lastReminderAt, now)))
          .catch((err: any) => logger.error({ err: err?.message, invoiceId: invoice.id }, "Failed to release overdue reminder claim"));
      }
    }
  }

  return { checked: due.length, sent };
}

let scheduled = false;

export function startFinanceInvoiceReminderCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_INVOICE_REMINDER_CRON ?? "30 9 * * *"; // 09:30 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_INVOICE_REMINDER_CRON is not a valid cron expression — overdue invoice reminders disabled");
    logBus.warn(`Overdue invoice reminders cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceInvoiceReminderSweep().catch((err) => {
      logger.error({ err }, "Overdue invoice reminder sweep failed");
      logBus.error(`Overdue invoice reminder sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Overdue invoice reminders cron scheduled ("${expr}")`);
  logger.info({ expr }, "Overdue invoice reminders cron scheduled");
}
