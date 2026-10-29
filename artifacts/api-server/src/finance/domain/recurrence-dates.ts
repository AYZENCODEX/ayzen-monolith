// Pure calendar arithmetic for Finance schedules (amortization/EMI due dates and
// recurring-rule next-run dates). Moved unchanged from lib/finance-accounting.ts
// (addMonths) and lib/finance-recurring-cron.ts (setMonthClamped/advance), which
// held identical month-clamping logic. All arithmetic uses the process-local
// timezone, exactly as the originals did; no I/O, no imports.
//
// BUG-FIX CONTEXT (preserved): `d.setMonth(d.getMonth() + n)` overflows into the
// following month when the day-of-month does not exist in the target month
// (Jan 31 + 1 month would land on Mar 3). The day is clamped to the last valid
// day of the target month so schedules keep a regular monthly cadence.

/** Add `n` calendar months, clamping the day to the last day of the target month. */
export function addMonthsClamped(date: Date, n: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1); // avoid overflow while shifting the month
  d.setMonth(d.getMonth() + n);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDayOfTargetMonth));
  return d;
}

/**
 * Next run date of a recurring rule. Unknown frequencies fall back to monthly
 * (original `default:` branch). Yearly advances 12 * intervalCount months.
 */
export function advanceRecurringDate(date: Date, frequency: string, intervalCount: number): Date {
  switch (frequency) {
    case "daily": {
      const d = new Date(date);
      d.setDate(d.getDate() + intervalCount);
      return d;
    }
    case "weekly": {
      const d = new Date(date);
      d.setDate(d.getDate() + 7 * intervalCount);
      return d;
    }
    case "yearly":
      return addMonthsClamped(date, 12 * intervalCount);
    case "monthly":
    default:
      return addMonthsClamped(date, intervalCount);
  }
}
