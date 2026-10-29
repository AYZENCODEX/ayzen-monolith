import { and, eq } from "drizzle-orm";
import { db, financeReportSchedulesTable } from "@workspace/db";

// Monthly report e-mail schedules (the sending cron is lib/finance-report-schedule-cron.ts and
// has not moved yet). Moved unchanged from routes/finance.ts.

export const REPORT_SCHEDULE_TYPES = ["income_statement", "balance_sheet", "trial_balance", "cash_flow"];

/** Day of month capped to 1..28 so every month has that day; non-numeric input becomes 1. */
export function normalizeDayOfMonth(dayOfMonth: unknown): number {
  return Math.min(28, Math.max(1, Number(dayOfMonth) || 1));
}

export async function listReportSchedules(userId: number) {
  return db.select().from(financeReportSchedulesTable).where(eq(financeReportSchedulesTable.userId, userId));
}

export async function createReportSchedule(
  userId: number,
  input: { bookId?: number; reportType?: string; dayOfMonth?: number },
) {
  const [row] = await db.insert(financeReportSchedulesTable).values({
    userId, bookId: input.bookId ?? null, reportType: input.reportType || "income_statement",
    frequency: "monthly", dayOfMonth: normalizeDayOfMonth(input.dayOfMonth), active: 1,
  }).returning();
  return row;
}

/** Returns undefined when the schedule does not exist for this user. */
export async function updateReportSchedule(
  userId: number,
  id: number,
  input: { active?: boolean; dayOfMonth?: number },
) {
  const update: Record<string, any> = { updatedAt: new Date() };
  if (input.active !== undefined) update.active = input.active ? 1 : 0;
  if (input.dayOfMonth !== undefined) update.dayOfMonth = normalizeDayOfMonth(input.dayOfMonth);
  const [row] = await db.update(financeReportSchedulesTable).set(update)
    .where(and(eq(financeReportSchedulesTable.id, id), eq(financeReportSchedulesTable.userId, userId)))
    .returning();
  return row;
}

export async function deleteReportSchedule(userId: number, id: number): Promise<void> {
  await db.delete(financeReportSchedulesTable)
    .where(and(eq(financeReportSchedulesTable.id, id), eq(financeReportSchedulesTable.userId, userId)));
}
