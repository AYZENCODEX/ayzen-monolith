/**
 * finance/jobs/reminder.ts (moved from lib/finance-reminder-cron.ts, FIN-WP-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance due-date reminders. Once a day, scans finance_ledger_entries for anything due within the next 3 days
 * (payables, receivables, borrowed funds) that hasn't been reminded about yet and fires an in-app notification.
 * remindedAt is per-entry so it only ever fires once per due date, even if the sweep runs daily and the item stays
 * in the "next 3 days" window across multiple runs (changing the due date re-arms it, see application/entries).
 *
 * Behavior changes from the legacy file (F24, see finance-safety-findings.md):
 *   - the entry is CLAIMED (remindedAt set, conditional on it still being null, unsettled and on the due date
 *     the sweep read) before the notification goes out, so two overlapping sweeps notify once; a notification that
 *     throws releases the claim so the next sweep retries it;
 *   - one failing entry no longer aborts the rest of the sweep.
 */
import cron from "node-cron";
import { db, financeLedgerEntriesTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";

const KIND_ICON: Record<string, string> = {
  payable: "📤", borrowed: "🏦", receivable: "📥", lending: "🤝", expense: "💸",
};

// Mirrors artifacts/ayzen/src/config/finance.ts's CURRENCY_SYMBOLS — kept as
// a local copy since the API server and the frontend app are separate
// packages. Falls back to the raw currency code (e.g. "XYZ ") for anything
// not in the map, same as the frontend's fmtMoney().
const CURRENCY_SYMBOLS: Record<string, string> = {
  BDT: "৳", USD: "$", EUR: "€", GBP: "£", INR: "₹", AED: "د.إ", SGD: "S$",
};
function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

const REMINDER_SETTLED_STATUSES = ["paid", "closed"];

export type ReminderNotify = (
  userId: number, type: string, title: string, message: string, data?: Record<string, unknown>,
) => Promise<unknown>;

export interface ReminderSweepOptions {
  /** Clock; defaults to the current time. */
  now?: Date;
  /** Restrict the sweep to these users (tests and manual runs). The scheduled sweep omits it. */
  userIds?: number[];
  /** In-app notification; defaults to lib/create-notification (loaded on demand). */
  notify?: ReminderNotify;
}

async function defaultNotify(...args: Parameters<ReminderNotify>): Promise<unknown> {
  const { createNotification } = await import("../../lib/create-notification");
  return createNotification(...args);
}

export async function runFinanceReminderSweep(options: ReminderSweepOptions = {}): Promise<{ entriesChecked: number; remindersSent: number }> {
  const nowMs = (options.now ?? new Date()).getTime();
  const notify = options.notify ?? defaultNotify;
  const windowEnd = new Date(nowMs + 3 * 24 * 60 * 60 * 1000);

  const dueEntries = await db.select().from(financeLedgerEntriesTable)
    .where(and(
      isNotNull(financeLedgerEntriesTable.dueDate),
      isNull(financeLedgerEntriesTable.remindedAt),
      lte(financeLedgerEntriesTable.dueDate, windowEnd),
      notInArray(financeLedgerEntriesTable.status, REMINDER_SETTLED_STATUSES),
      options.userIds ? inArray(financeLedgerEntriesTable.userId, options.userIds) : undefined,
    ));

  let remindersSent = 0;

  for (const e of dueEntries) {
    const claimedAt = new Date(options.now ? options.now.getTime() : Date.now());
    try {
      const [claimed] = await db.update(financeLedgerEntriesTable).set({ remindedAt: claimedAt })
        .where(and(
          eq(financeLedgerEntriesTable.id, e.id),
          isNull(financeLedgerEntriesTable.remindedAt),
          // Same due date as the read. Compared at millisecond precision (the precision of a JS Date), so an
          // entry whose due date was written by SQL with microseconds can still be claimed; the ISO string is UTC,
          // the convention drizzle stores timestamps in.
          sql`date_trunc('milliseconds', ${financeLedgerEntriesTable.dueDate}) = ${e.dueDate!.toISOString()}::timestamp`,
          notInArray(financeLedgerEntriesTable.status, REMINDER_SETTLED_STATUSES),
        )).returning({ id: financeLedgerEntriesTable.id });
      if (!claimed) continue; // reminded by another sweep, settled, or its due date changed since the read

      const days = Math.max(0, Math.ceil((e.dueDate!.getTime() - nowMs) / 86400000));
      const icon = KIND_ICON[e.kind] ?? "💰";
      const direction = e.kind === "payable" || e.kind === "borrowed" ? "dite hobe" : "pabe";
      try {
        await notify(
          e.userId,
          "finance_reminder",
          `${icon} ${e.title} — ${days === 0 ? "today" : `${days}d`}`,
          `${e.title}: ${currencySymbol(e.currency)}${e.amount.toLocaleString()} ${direction}${days === 0 ? " today" : ` in ${days} day(s)`}.`,
          { entryId: e.id, kind: e.kind, dueDate: e.dueDate },
        );
      } catch (err) {
        // Release the claim (only if it is still ours) so the next sweep sends it.
        await db.update(financeLedgerEntriesTable).set({ remindedAt: null })
          .where(and(eq(financeLedgerEntriesTable.id, e.id), eq(financeLedgerEntriesTable.remindedAt, claimedAt)));
        throw err;
      }
      remindersSent++;
    } catch (err: any) {
      logger.error({ err: err?.message, entryId: e.id }, "Failed to send finance due-date reminder");
      logBus.error(`Finance reminder for entry #${e.id} failed: ${err?.message ?? err}`);
    }
  }

  return { entriesChecked: dueEntries.length, remindersSent };
}

let scheduled = false;

export function startFinanceReminderCron() {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_REMINDER_CRON ?? "0 9 * * *"; // 09:00 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_REMINDER_CRON is not a valid cron expression — finance reminder cron disabled");
    logBus.warn(`Finance reminder cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceReminderSweep().catch((err) => {
      logger.error({ err }, "Finance reminder sweep failed");
      logBus.error(`Finance reminder sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance reminder cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance reminder cron scheduled");
}
