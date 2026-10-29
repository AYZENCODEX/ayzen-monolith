/**
 * finance/jobs/recurring.ts (moved from lib/finance-recurring-cron.ts, FIN-WP-5a)
 * ─────────────────────────────────────────────────────────────────────────────
 * Finance recurring engine. Once a day, scans finance_recurring_rules for any
 * rule whose nextRunDate has passed, materializes a real
 * finance_ledger_entries row from it (tagged with recurringRuleId so it's
 * traceable back to the template), and advances nextRunDate by the rule's
 * frequency. A rule can fall behind (server downtime, etc) — each sweep
 * catches it up one period at a time rather than looping unboundedly, and
 * will finish catching up on the following day's sweep.
 */
import cron from "node-cron";
import { db, financeRecurringRulesTable, financeLedgerEntriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";
// WP-6 owns invoices; until then the sweep reaches the legacy invoice module (approved edge in the validator).
import { createAndSendRuleInvoice } from "../invoices/rule-invoice";
import { postEntryJournal } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";
import { advanceRecurringDate } from "../domain/recurrence-dates";
import { selectDueRecurringRules } from "./due-rules";

// Next-run date arithmetic (month-end clamping for monthly/yearly rules) is owned by
// ../finance/domain/recurrence-dates.ts (`advanceRecurringDate`).

/**
 * Runs due recurring rules. The scheduled cron calls this with no options and
 * processes every user's rules; the manual "run now" route passes the caller's
 * `userId` so a user can only trigger (and see counts for) their own rules.
 */
export async function runFinanceRecurringSweep(
  options: { userId?: number } = {},
): Promise<{ rulesChecked: number; entriesCreated: number }> {
  const now = new Date();
  const dueRules = await selectDueRecurringRules(now, options.userId);

  let entriesCreated = 0;

  for (const rule of dueRules) {
    if (rule.endDate && rule.nextRunDate > rule.endDate) {
      await db.update(financeRecurringRulesTable).set({ active: 0, updatedAt: new Date() }).where(eq(financeRecurringRulesTable.id, rule.id));
      continue;
    }

    // financeRecurringRulesTable has no bookId of its own — resolve the
    // rule owner's default book so this entry follows the same "every
    // write path resolves a concrete bookId before insert" rule as every
    // other entry-creation path (see financeLedgerEntriesTable.bookId's
    // doc comment). Without this, entries land with bookId = null and
    // silently disappear from GET /finance/entries, which always filters
    // on a resolved (non-null) bookId.
    const resolvedBookId = await resolveBookId(rule.userId);

    const [entry] = await db.insert(financeLedgerEntriesTable).values({
      userId: rule.userId,
      bookId: resolvedBookId,
      kind: rule.kind,
      title: rule.title,
      amount: rule.amount,
      currency: rule.currency,
      partyId: rule.partyId,
      projectId: rule.projectId,
      category: rule.category,
      interestRate: rule.interestRate,
      dueDate: rule.nextRunDate,
      occurredDate: rule.nextRunDate,
      status: "pending",
      notes: rule.notes,
      recurringRuleId: rule.id,
    }).returning();
    entriesCreated++;

    // Every other entry-creation path (POST /finance/entries, amortization
    // installments, late-fee accrual, ...) posts an opening journal entry
    // so Trial Balance / Balance Sheet / Income Statement stay accurate.
    // This was previously skipped here, so every recurring-generated entry
    // (rent, EMI, subscriptions) was silently invisible to those reports.
    if (entry) postEntryJournal(entry).catch(() => {}); // best-effort — never blocks the sweep

    // Rent/loan-EMI style: also mint + auto-send an invoice against the
    // entry just created, if this rule opted in.
    if (rule.autoInvoice && entry) {
      createAndSendRuleInvoice(entry, rule).catch(() => {});
    }

    const next = advanceRecurringDate(rule.nextRunDate, rule.frequency, rule.intervalCount);
    const stillActive = !rule.endDate || next <= rule.endDate;
    await db.update(financeRecurringRulesTable)
      .set({ nextRunDate: next, lastRunAt: now, active: stillActive ? 1 : 0, updatedAt: new Date() })
      .where(eq(financeRecurringRulesTable.id, rule.id));
  }

  return { rulesChecked: dueRules.length, entriesCreated };
}

let scheduled = false;

export function startFinanceRecurringCron() {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.FINANCE_RECURRING_CRON ?? "15 0 * * *"; // 00:15 daily
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "FINANCE_RECURRING_CRON is not a valid cron expression — finance recurring cron disabled");
    logBus.warn(`Finance recurring cron disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    runFinanceRecurringSweep().catch((err) => {
      logger.error({ err }, "Finance recurring sweep failed");
      logBus.error(`Finance recurring sweep failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Finance recurring cron scheduled ("${expr}")`);
  logger.info({ expr }, "Finance recurring cron scheduled");
}
