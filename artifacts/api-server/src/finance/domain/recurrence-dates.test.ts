import assert from "node:assert/strict";
import test from "node:test";
import { addMonthsClamped, advanceRecurringDate } from "./recurrence-dates";

// Expected values were captured from the pre-extraction implementations
// (lib/finance-accounting.ts addMonths and lib/finance-recurring-cron.ts advance)
// before they were removed. Dates are compared as local calendar dates, so the
// fixtures hold in any process timezone.
const ADD_MONTHS: Array<[string, number, string]> = [
  ["2024-01-31", 1, "2024-02-29"],
  ["2023-01-31", 1, "2023-02-28"],
  ["2024-02-29", 12, "2025-02-28"],
  ["2024-03-31", -1, "2024-02-29"],
  ["2023-12-31", 2, "2024-02-29"],
  ["2024-05-31", 1, "2024-06-30"],
  ["2024-01-30", 1, "2024-02-29"],
  ["2024-08-31", 6, "2025-02-28"],
  ["2024-01-15", 25, "2026-02-15"],
  ["2024-10-31", -8, "2024-02-29"],
];
const ADVANCE: Array<[string, string, number, string]> = [
  ["2024-01-31", "monthly", 1, "2024-02-29"],
  ["2024-02-29", "yearly", 1, "2025-02-28"],
  ["2024-02-29", "yearly", 4, "2028-02-29"],
  ["2024-12-31", "monthly", 2, "2025-02-28"],
  ["2024-03-01", "weekly", 2, "2024-03-15"],
  ["2024-12-30", "daily", 5, "2025-01-04"],
  ["2024-01-31", "fortnightly", 1, "2024-02-29"],
  ["2024-01-31", "", 3, "2024-04-30"],
  ["2024-11-30", "monthly", 3, "2025-02-28"],
  ["2023-03-31", "monthly", -1, "2023-02-28"],
];

const local = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
};
const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("addMonthsClamped matches baseline outputs and clamps to month end", () => {
  for (const [start, n, expected] of ADD_MONTHS) {
    assert.equal(ymd(addMonthsClamped(local(start), n)), expected, `${start} + ${n} months`);
  }
});

test("advanceRecurringDate matches baseline outputs, incl. unknown-frequency fallback", () => {
  for (const [start, frequency, n, expected] of ADVANCE) {
    assert.equal(ymd(advanceRecurringDate(local(start), frequency, n)), expected, `${start} ${frequency} x${n}`);
  }
});

test("date helpers never mutate their input", () => {
  const input = local("2024-01-31");
  const before = input.getTime();
  addMonthsClamped(input, 1);
  advanceRecurringDate(input, "monthly", 1);
  advanceRecurringDate(input, "weekly", 1);
  assert.equal(input.getTime(), before);
});

test("invalid dates stay invalid, as before", () => {
  assert.ok(Number.isNaN(addMonthsClamped(new Date(NaN), 1).getTime()));
  assert.ok(Number.isNaN(advanceRecurringDate(new Date(NaN), "monthly", 1).getTime()));
});
