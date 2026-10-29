// Pure late-fee arithmetic (FIN-WP-7). No database, clock or framework: the caller passes `now`.
// The formulas are the ones lib/finance-late-fee-cron.ts used, with the same floating-point order of
// operations; domain/late-fees.test.ts compares them with a verbatim copy of the original over a grid.
//
// lateFeeType:
//   'flat'            one-time flat `rate` amount, charged once (nothing further once lateFeeAccrued > 0).
//   'daily_percent'   rate% of the ORIGINAL principal per day overdue.
//   'monthly_percent' rate% of the ORIGINAL principal per 30-day period, prorated daily between sweeps.

export const LATE_FEE_SETTLED_STATUSES: readonly string[] = ["paid", "closed"];

const DAY_MS = 86400000;

export interface LateFeeTerms {
  type: string | null;
  rate: number | null;
  /** Late fee already charged on this entry (entry.lateFeeAccrued). */
  accrued: number;
}

/** True when the fee is a percentage of the original principal, so the caller must look the principal up. */
export function lateFeeUsesPrincipal(type: string | null): boolean {
  return type === "daily_percent" || type === "monthly_percent";
}

/**
 * The original principal. `amount` is the current outstanding balance: it grows when a late fee accrues and shrinks
 * when principal is repaid, so the original is amount - lateFeeAccrued + principal repaid so far (interest-only
 * repayments never touch `amount`, so the caller leaves them out of `repaidPrincipal`).
 */
export function originalPrincipal(amount: number, lateFeeAccrued: number, repaidPrincipal: number): number {
  return Math.max(0, amount - lateFeeAccrued + repaidPrincipal);
}

/** End of the grace period: due date plus `graceDays` calendar days (local-time setDate, as before). */
export function lateFeeGraceEnd(dueDate: Date, graceDays: number | null | undefined): Date {
  const graceEnd = new Date(dueDate);
  graceEnd.setDate(graceEnd.getDate() + (graceDays ?? 0));
  return graceEnd;
}

/** Accrual starts at the later of the previous calculation and the end of the grace period. */
export function lateFeeAccrualStart(lastCalcAt: Date | null, graceEnd: Date): Date {
  return lastCalcAt && lastCalcAt > graceEnd ? lastCalcAt : graceEnd;
}

/** The fee accrued between `since` and `now`. `base` is only read for the percentage types. */
export function lateFeeAccrual(terms: LateFeeTerms, base: number, since: Date, now: Date): number {
  const rate = terms.rate ?? 0;
  if (rate <= 0) return 0;

  if (terms.type === "flat") {
    return terms.accrued > 0 ? 0 : rate;
  }
  const daysElapsed = Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
  if (daysElapsed <= 0) return 0;

  if (terms.type === "daily_percent") {
    return base * (rate / 100) * daysElapsed;
  }
  if (terms.type === "monthly_percent") {
    return base * (rate / 100) * (daysElapsed / 30);
  }
  return 0;
}

/**
 * Round a fee to whole cents (FIN-WP-7 owner decision). Applied to the result of lateFeeAccrual by the sweep, so
 * lateFeeAccrual itself stays bit-identical to the original arithmetic. A fee that rounds to one cent or less is
 * not charged and does not advance the calculation timestamp, so sub-cent amounts keep accumulating until they count.
 */
export function roundLateFee(fee: number): number {
  return Math.round((fee + Number.EPSILON) * 100) / 100;
}
