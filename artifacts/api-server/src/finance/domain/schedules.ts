// Pure schedule math: no DB, HTTP, fs or clock. Extracted from lib/finance-accounting.ts (FIN-WP-4).
// The arithmetic and its order are unchanged, so floating-point results are bit-identical; this is
// enforced by schedules.test.ts against schedules.golden.json, captured from the ORIGINAL code
// (scripts/antas/finance/schedule-golden-capture.mjs). Callers resolve defaults (null amount -> 0,
// start-date fallbacks) before calling, because those read the current time.
import { addMonthsClamped } from "./recurrence-dates";

export interface AmortizationInput {
  userId: number;
  ledgerEntryId: number;
  principal: number;
  annualRate: number;
  termMonths: number;
  startDate: Date;
}

export interface AmortizationInsertRow {
  userId: number;
  ledgerEntryId: number;
  installmentNo: number;
  dueDate: Date;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  remainingBalance: number;
  status: "upcoming";
}

/** Equal-principal amortization rows; the last installment absorbs whatever principal remains. */
export function buildAmortizationRows(input: AmortizationInput): AmortizationInsertRow[] {
  const { userId, ledgerEntryId, principal, annualRate, termMonths, startDate } = input;
  const monthlyPrincipal = principal / termMonths;
  const monthlyRate = annualRate / 100 / 12;

  let remaining = principal;
  const rows: AmortizationInsertRow[] = [];
  for (let i = 1; i <= termMonths; i++) {
    const interestDue = Math.max(0, remaining * monthlyRate);
    const principalDue = i === termMonths ? remaining : monthlyPrincipal;
    remaining = Math.max(0, remaining - principalDue);
    rows.push({
      userId,
      ledgerEntryId,
      installmentNo: i,
      dueDate: addMonthsClamped(startDate, i),
      principalDue,
      interestDue,
      totalDue: principalDue + interestDue,
      remainingBalance: remaining,
      status: "upcoming",
    });
  }
  return rows;
}

export interface DepreciationInput {
  userId: number;
  assetId: number;
  /** "declining_balance" is double-declining; any other value is straight-line, as before. */
  method: string;
  cost: number;
  salvage: number;
  months: number;
  startDate: Date;
}

export interface DepreciationInsertRow {
  userId: number;
  assetId: number;
  periodNo: number;
  periodDate: Date;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  bookValue: number;
  status: "upcoming";
}

/**
 * Monthly depreciation rows.
 *
 * straight_line: (cost - salvage) / months every period.
 * declining_balance: 2x straight-line rate applied to the *current* book value each period
 * (double-declining balance), floored so book value never drops below salvage. Double-declining
 * balance is asymptotic, so, same as straight_line, the final period absorbs whatever book value
 * remains, ensuring the asset ends exactly on salvage.
 */
export function buildDepreciationRows(input: DepreciationInput): DepreciationInsertRow[] {
  const { userId, assetId, method, cost, salvage, months, startDate } = input;
  const depreciableBase = Math.max(0, cost - salvage);
  const straightLineAmount = depreciableBase / months;
  const doubleRate = (2 / months);

  let bookValue = cost;
  let accumulated = 0;
  const rows: DepreciationInsertRow[] = [];
  for (let i = 1; i <= months; i++) {
    let amount: number;
    if (method === "declining_balance") {
      // BUG FIX (kept from the original): the rate applies to the current *book value*; salvage is
      // only a floor, not something subtracted from the base before the rate is applied.
      amount = i === months
        ? Math.max(0, bookValue - salvage) // last period absorbs whatever's left so book value lands exactly on salvage
        : Math.min(Math.max(0, bookValue) * doubleRate, Math.max(0, bookValue - salvage));
    } else {
      amount = i === months ? Math.max(0, depreciableBase - accumulated) : straightLineAmount; // last period absorbs rounding
    }
    accumulated += amount;
    bookValue = Math.max(salvage, cost - accumulated);
    rows.push({
      userId,
      assetId,
      periodNo: i,
      periodDate: addMonthsClamped(startDate, i),
      depreciationAmount: amount,
      accumulatedDepreciation: accumulated,
      bookValue,
      status: "upcoming",
    });
  }
  return rows;
}
