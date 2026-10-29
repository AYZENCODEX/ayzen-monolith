import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  financeBudgetsTable,
  financeCurrencyRatesTable,
  financeGoalsTable,
  financeLedgerEntriesTable,
  financePartiesTable,
  financeReportSchedulesTable,
} from "@workspace/db";
import { createParty, deleteParty, listParties, updateParty } from "./parties";
import { listCurrencyRates, upsertCurrencyRate } from "./currencies";
import {
  REPORT_SCHEDULE_TYPES,
  createReportSchedule,
  deleteReportSchedule,
  listReportSchedules,
  normalizeDayOfMonth,
  updateReportSchedule,
} from "./report-schedules";
import {
  contributeToGoal,
  createGoal,
  deleteBudget,
  deleteGoal,
  listBudgetsWithSpent,
  listGoals,
  updateGoal,
  upsertBudget,
} from "./goals-budgets";

// WP-2 characterization tests for the use cases moved out of routes/finance.ts. They pin the
// behavior the routes had before the move (including user scoping). They run only in the
// isolated Finance test schema (pnpm test:finance-db).

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();
const nextTestUserId = (): number => {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
};

after(async () => {
  try {
    for (const userId of testUserIds) {
      await db.delete(financePartiesTable).where(eq(financePartiesTable.userId, userId));
      await db.delete(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
      await db.delete(financeReportSchedulesTable).where(eq(financeReportSchedulesTable.userId, userId));
      await db.delete(financeGoalsTable).where(eq(financeGoalsTable.userId, userId));
      await db.delete(financeBudgetsTable).where(eq(financeBudgetsTable.userId, userId));
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

// ─── Parties ─────────────────────────────────────────────────────────────────

test("parties: create trims the name, list and mutations are scoped to the user", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const party = await createParty(owner, { name: "  Rahim  ", contact: "0170", notes: "friend" });
  assert.equal(party.name, "Rahim");
  assert.equal(party.userId, owner);

  assert.equal((await listParties(owner)).length, 1);
  assert.equal((await listParties(other)).length, 0);

  assert.equal(await updateParty(other, party.id, { name: "Hijacked" }), undefined);
  assert.equal((await listParties(owner))[0].name, "Rahim");

  // Undefined fields are left unchanged.
  const updated = await updateParty(owner, party.id, { notes: "colleague" });
  assert.ok(updated);
  assert.equal(updated.name, "Rahim");
  assert.equal(updated.contact, "0170");
  assert.equal(updated.notes, "colleague");

  await deleteParty(other, party.id);
  assert.equal((await listParties(owner)).length, 1);
  await deleteParty(owner, party.id);
  assert.equal((await listParties(owner)).length, 0);
});

// ─── Currencies ──────────────────────────────────────────────────────────────

test("currencies: upsert keeps one row per user and currency; rates are per user", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const first = await upsertCurrencyRate(owner, "USD", 100);
  const second = await upsertCurrencyRate(owner, "USD", 110);
  assert.equal(first.id, second.id);
  assert.equal(second.rateToBase, 110);
  await upsertCurrencyRate(other, "USD", 90);

  const ownerRates = await listCurrencyRates(owner);
  assert.equal(ownerRates.length, 1);
  assert.equal(ownerRates[0].rateToBase, 110);
  assert.equal((await listCurrencyRates(other))[0].rateToBase, 90);
});

// ─── Report schedules ────────────────────────────────────────────────────────

test("normalizeDayOfMonth caps to 1..28 and defaults to 1", () => {
  assert.equal(normalizeDayOfMonth(0), 1);
  assert.equal(normalizeDayOfMonth(-5), 1);
  assert.equal(normalizeDayOfMonth(15), 15);
  assert.equal(normalizeDayOfMonth(31), 28);
  assert.equal(normalizeDayOfMonth("abc"), 1);
  assert.equal(normalizeDayOfMonth(undefined), 1);
  assert.deepEqual(REPORT_SCHEDULE_TYPES, ["income_statement", "balance_sheet", "trial_balance", "cash_flow"]);
});

test("report schedules: defaults, clamped updates and user scoping", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const schedule = await createReportSchedule(owner, { dayOfMonth: 40 });
  assert.equal(schedule.reportType, "income_statement");
  assert.equal(schedule.frequency, "monthly");
  assert.equal(schedule.dayOfMonth, 28);
  assert.equal(schedule.active, 1);
  assert.equal(schedule.bookId, null);

  assert.equal(await updateReportSchedule(other, schedule.id, { active: false }), undefined);
  const off = await updateReportSchedule(owner, schedule.id, { active: false, dayOfMonth: 0 });
  assert.ok(off);
  assert.equal(off.active, 0);
  assert.equal(off.dayOfMonth, 1);

  assert.equal((await listReportSchedules(other)).length, 0);
  await deleteReportSchedule(other, schedule.id);
  assert.equal((await listReportSchedules(owner)).length, 1);
  await deleteReportSchedule(owner, schedule.id);
  assert.equal((await listReportSchedules(owner)).length, 0);
});

// ─── Goals ───────────────────────────────────────────────────────────────────

test("goals: create defaults and pins asset-linked goals to the base currency", async () => {
  const userId = nextTestUserId();
  const plain = await createGoal(userId, { title: "  Laptop ", targetAmount: 1000, currency: "USD" });
  assert.equal(plain.title, "Laptop");
  assert.equal(plain.goalType, "savings");
  assert.equal(plain.currency, "USD");
  assert.equal(plain.currentAmount, 0);
  assert.equal(plain.status, "active");

  const linked = await createGoal(userId, { title: "House", targetAmount: 5000, currency: "USD", linkedAssetId: 2_100_000_010 });
  assert.equal(linked.currency, "BDT");
  assert.equal(linked.linkedAssetId, 2_100_000_010);
  assert.equal((await listGoals(userId)).length, 2);
});

test("goals: update and delete are scoped to the owner; an asset link pins the currency", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const goal = await createGoal(owner, { title: "Trip", targetAmount: 500, currency: "USD" });

  assert.equal(await updateGoal(other, goal.id, { title: "Hijacked" }), null);
  const renamed = await updateGoal(owner, goal.id, { title: " Trip 2 ", notes: "  note " });
  assert.ok(renamed);
  assert.equal(renamed.title, "Trip 2");
  assert.equal(renamed.notes, "note");
  assert.equal(renamed.currency, "USD");

  const linked = await updateGoal(owner, goal.id, { linkedAssetId: 2_100_000_011, currency: "EUR" });
  assert.ok(linked);
  assert.equal(linked.currency, "BDT");

  await deleteGoal(other, goal.id);
  assert.equal((await listGoals(owner)).length, 1);
  await deleteGoal(owner, goal.id);
  assert.equal((await listGoals(owner)).length, 0);
});

test("goals: contributions add up, flag 'achieved' at the target, and refuse linked or foreign goals", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const goal = await createGoal(owner, { title: "Fund", targetAmount: 100 });

  const partial = await contributeToGoal(owner, goal.id, 40);
  assert.ok(partial.status === "ok" && partial.goal.currentAmount === 40 && partial.goal.status === "active");
  const done = await contributeToGoal(owner, goal.id, 60);
  assert.ok(done.status === "ok" && done.goal.currentAmount === 100 && done.goal.status === "achieved");

  assert.equal((await contributeToGoal(other, goal.id, 10)).status, "not_found");

  const [linkedGoal] = await db.insert(financeGoalsTable).values({
    userId: owner, title: "Linked", goalType: "savings", targetAmount: 100, currentAmount: 0,
    currency: "BDT", linkedAssetId: 2_100_000_012, status: "active",
  }).returning();
  assert.equal((await contributeToGoal(owner, linkedGoal.id, 10)).status, "linked_asset");
});

test("goals: concurrent contributions are all counted and the goal is achieved exactly at the target (F7)", async () => {
  const userId = nextTestUserId();
  const goal = await createGoal(userId, { title: "Concurrent fund", targetAmount: 100 });

  const results = await Promise.all(Array.from({ length: 10 }, () => contributeToGoal(userId, goal.id, 10)));
  assert.ok(results.every((result) => result.status === "ok"));

  const [row] = await db.select().from(financeGoalsTable).where(eq(financeGoalsTable.id, goal.id));
  assert.equal(row.currentAmount, 100, "no contribution may be lost");
  assert.equal(row.status, "achieved");
});

test("goals: a contribution never reopens or changes a non-active goal's status (F7)", async () => {
  const userId = nextTestUserId();
  const goal = await createGoal(userId, { title: "Paused", targetAmount: 100 });
  await updateGoal(userId, goal.id, { status: "paused" });
  const result = await contributeToGoal(userId, goal.id, 150);
  assert.ok(result.status === "ok" && result.goal.currentAmount === 150 && result.goal.status === "paused");
});

test("goals: a contribution to a linked-asset goal changes nothing", async () => {
  const userId = nextTestUserId();
  const [linkedGoal] = await db.insert(financeGoalsTable).values({
    userId, title: "Linked", goalType: "savings", targetAmount: 100, currentAmount: 5,
    currency: "BDT", linkedAssetId: 2_100_000_013, status: "active",
  }).returning();
  assert.equal((await contributeToGoal(userId, linkedGoal.id, 10)).status, "linked_asset");
  const [row] = await db.select().from(financeGoalsTable).where(eq(financeGoalsTable.id, linkedGoal.id));
  assert.equal(row.currentAmount, 5);
});

// ─── Budgets ─────────────────────────────────────────────────────────────────

test("budgets: upsert is keyed by category; delete is scoped to the owner", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const first = await upsertBudget(owner, { category: "  Food ", monthlyLimit: 500 });
  const second = await upsertBudget(owner, { category: "Food", monthlyLimit: 700, notes: "raised" });
  assert.equal(first.category, "Food");
  assert.equal(first.id, second.id);
  assert.equal(second.monthlyLimit, 700);

  await deleteBudget(other, first.id);
  assert.equal((await listBudgetsWithSpent(owner)).length, 1);
  await deleteBudget(owner, first.id);
  assert.equal((await listBudgetsWithSpent(owner)).length, 0);
});

test("budgets: spent counts this month's expenses converted to base currency and ignores older ones", async () => {
  const userId = nextTestUserId();
  await upsertBudget(userId, { category: "Food", monthlyLimit: 1000 });
  await upsertBudget(userId, { category: "Rent", monthlyLimit: 5000 });
  await upsertCurrencyRate(userId, "USD", 100);

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const addExpense = (category: string, amount: number, currency: string, occurredDate: Date) =>
    db.insert(financeLedgerEntriesTable).values({
      userId, kind: "expense", title: "WP-2 expense", category, amount, currency, status: "paid", occurredDate,
    });
  await addExpense("Food", 100, "BDT", now);
  await addExpense("Food", 2, "USD", now); // 2 USD * 100 = 200 BDT
  await addExpense("Food", 999, "BDT", lastMonth); // not this month
  await addExpense("Misc", 50, "BDT", now); // no budget for this category

  const budgets = await listBudgetsWithSpent(userId);
  const byCategory = new Map(budgets.map((budget) => [budget.category, budget]));
  assert.equal(byCategory.get("Food")?.spent, 300);
  assert.equal(byCategory.get("Rent")?.spent, 0);
  assert.equal(byCategory.has("Misc"), false);
});
