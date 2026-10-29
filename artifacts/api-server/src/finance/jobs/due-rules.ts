// Due-rule selection for the recurring-rules sweep. Kept separate from the sweep
// (lib/finance-recurring-cron.ts) so the scoping rule can be tested against the
// isolated Finance schema without loading invoice, email or Telegram modules.
import { and, eq, lte } from "drizzle-orm";
import { db, financeRecurringRulesTable } from "@workspace/db";

/**
 * Active rules whose next run date has passed. When `userId` is given only that
 * user's rules are returned (manual "run now"); the scheduled sweep omits it and
 * processes every user's rules.
 */
export async function selectDueRecurringRules(now: Date, userId?: number) {
  return db.select().from(financeRecurringRulesTable).where(and(
    eq(financeRecurringRulesTable.active, 1),
    lte(financeRecurringRulesTable.nextRunDate, now),
    userId === undefined ? undefined : eq(financeRecurringRulesTable.userId, userId),
  ));
}
