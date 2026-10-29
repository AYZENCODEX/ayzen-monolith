import assert from "node:assert/strict";
import test from "node:test";
import {
  LATE_FEE_SETTLED_STATUSES,
  lateFeeAccrual,
  lateFeeAccrualStart,
  lateFeeGraceEnd,
  lateFeeUsesPrincipal,
  originalPrincipal,
  roundLateFee,
} from "./late-fees";

// The reference below is a verbatim copy of computeAccrual() / principal()'s arithmetic from lib/finance-late-fee-cron.ts
// as it was before the FIN-WP-7 extraction (the database read of the repaid principal is replaced by an argument).
// The extracted functions must agree with it bit for bit over the whole grid.
function referenceComputeAccrual(
  entry: { lateFeeType: string | null; lateFeeRate: number | null; lateFeeAccrued: number },
  base: number, since: Date, now: Date,
): number {
  const rate = entry.lateFeeRate ?? 0;
  if (rate <= 0) return 0;

  if (entry.lateFeeType === "flat") {
    return entry.lateFeeAccrued > 0 ? 0 : rate;
  }
  const daysElapsed = Math.max(0, (now.getTime() - since.getTime()) / 86400000);
  if (daysElapsed <= 0) return 0;

  if (entry.lateFeeType === "daily_percent") {
    return base * (rate / 100) * daysElapsed;
  }
  if (entry.lateFeeType === "monthly_percent") {
    return base * (rate / 100) * (daysElapsed / 30);
  }
  return 0;
}

const NOW = new Date("2026-06-15T10:30:00.000Z");
const TYPES = ["flat", "daily_percent", "monthly_percent", "weird", null];
const RATES = [null, -1, 0, 0.5, 1, 2.5, 10, 33.333, 150];
const ACCRUED = [0, 0.01, 12.5];
const BASES = [0, 0.01, 99.99, 1000, 123456.789, 2_500_000_000];
const SINCE_OFFSETS_MS = [-86_400_000 * 400, -86_400_000 * 30, -86_400_000 * 3 - 1234, -3_600_000, -1, 0, 1, 3_600_000];

test("lateFeeAccrual matches the pre-extraction arithmetic bit for bit over the whole grid", () => {
  let cases = 0;
  for (const type of TYPES) for (const rate of RATES) for (const accrued of ACCRUED) for (const base of BASES) for (const off of SINCE_OFFSETS_MS) {
    const since = new Date(NOW.getTime() + off);
    const want = referenceComputeAccrual({ lateFeeType: type, lateFeeRate: rate, lateFeeAccrued: accrued }, base, since, NOW);
    const got = lateFeeAccrual({ type, rate, accrued }, base, since, NOW);
    assert.ok(Object.is(got, want), `type=${type} rate=${rate} accrued=${accrued} base=${base} off=${off}: ${got} vs ${want}`);
    cases++;
  }
  assert.equal(cases, TYPES.length * RATES.length * ACCRUED.length * BASES.length * SINCE_OFFSETS_MS.length);
});

test("flat fee is charged once, percentage fees scale with days", () => {
  const since = new Date(NOW.getTime() - 10 * 86_400_000);
  assert.equal(lateFeeAccrual({ type: "flat", rate: 25, accrued: 0 }, 1000, since, NOW), 25);
  assert.equal(lateFeeAccrual({ type: "flat", rate: 25, accrued: 25 }, 1000, since, NOW), 0);
  assert.equal(lateFeeAccrual({ type: "daily_percent", rate: 1, accrued: 0 }, 1000, since, NOW), 1000 * 0.01 * 10);
  assert.equal(lateFeeAccrual({ type: "monthly_percent", rate: 3, accrued: 0 }, 1000, since, NOW), 1000 * 0.03 * (10 / 30));
  assert.equal(lateFeeAccrual({ type: "daily_percent", rate: 1, accrued: 0 }, 1000, NOW, NOW), 0, "nothing elapsed, nothing owed");
  assert.equal(lateFeeAccrual({ type: "daily_percent", rate: 1, accrued: 0 }, 1000, new Date(NOW.getTime() + 1000), NOW), 0, "since in the future");
  assert.equal(lateFeeAccrual({ type: "nope", rate: 1, accrued: 0 }, 1000, since, NOW), 0);
});

test("only the percentage types need the principal", () => {
  assert.equal(lateFeeUsesPrincipal("daily_percent"), true);
  assert.equal(lateFeeUsesPrincipal("monthly_percent"), true);
  assert.equal(lateFeeUsesPrincipal("flat"), false);
  assert.equal(lateFeeUsesPrincipal(null), false);
});

test("originalPrincipal adds repaid principal back and never goes negative", () => {
  assert.equal(originalPrincipal(1000, 0, 0), 1000);
  assert.equal(originalPrincipal(1050, 50, 0), 1000);
  assert.equal(originalPrincipal(600, 50, 450), 1000, "600 owed, of which 50 is fee, after 450 of principal was repaid: 1000 original");
  assert.equal(originalPrincipal(10, 50, 0), 0);
});

test("grace end and accrual start", () => {
  const due = new Date(2026, 0, 31, 12, 0, 0); // local time, like the original setDate arithmetic
  const grace = lateFeeGraceEnd(due, 3);
  assert.equal(grace.getFullYear(), 2026);
  assert.equal(grace.getMonth(), 1);
  assert.equal(grace.getDate(), 3);
  assert.equal(due.getDate(), 31, "the input is not mutated");
  assert.equal(lateFeeGraceEnd(due, null).getTime(), due.getTime());
  assert.equal(lateFeeGraceEnd(due, undefined).getTime(), due.getTime());

  const after = new Date(grace.getTime() + 1);
  assert.equal(lateFeeAccrualStart(null, grace), grace);
  assert.equal(lateFeeAccrualStart(after, grace), after);
  assert.equal(lateFeeAccrualStart(new Date(grace.getTime() - 1), grace), grace);
  assert.equal(lateFeeAccrualStart(new Date(grace.getTime()), grace), grace, "equal counts as not later");
});

test("settled statuses are the ones the sweep has always skipped", () => {
  assert.deepEqual([...LATE_FEE_SETTLED_STATUSES], ["paid", "closed"]);
});

test("roundLateFee rounds to whole cents and leaves the accrual arithmetic alone", () => {
  assert.equal(roundLateFee(33.3333333), 33.33);
  assert.equal(roundLateFee(33.335), 33.34);
  assert.equal(roundLateFee(1.005), 1.01, "half-cent cases round up despite binary representation");
  assert.equal(roundLateFee(0.004), 0);
  assert.equal(roundLateFee(25), 25);
  assert.equal(roundLateFee(0), 0);
  const since = new Date(NOW.getTime() - 7 * 86_400_000);
  const raw = lateFeeAccrual({ type: "daily_percent", rate: 1, accrued: 0 }, 333.33, since, NOW);
  assert.notEqual(raw, roundLateFee(raw), "the formula itself is unrounded");
  assert.equal(roundLateFee(raw), 23.33);
});
