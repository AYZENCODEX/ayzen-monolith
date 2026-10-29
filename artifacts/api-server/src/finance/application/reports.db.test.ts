import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  financeAssetOwnersTable,
  financeAssetsTable,
  financeBudgetsTable,
  financeCurrencyRatesTable,
  financeLedgerEntriesTable,
  financePartiesTable,
} from "@workspace/db";
import {
  getBalanceSheetReport,
  getCashFlowReport,
  getCustomFinanceReport,
  getFinanceAnalytics,
  getFinanceExportRows,
  getFinanceInsights,
  getFinanceProjections,
  getFinanceSummary,
  getIncomeStatementReport,
  getTrialBalanceReport,
} from "./reports";
import { resolveBookId } from "../ledger/books";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const userIds = new Set<number>();
const assetIds = new Set<number>();

function nextTestUserId(): number {
  const userId = -randomInt(1, 2_000_000_000);
  userIds.add(userId);
  return userId;
}

after(async () => {
  try {
    for (const assetId of assetIds) {
      await db.delete(financeAssetOwnersTable).where(
        eq(financeAssetOwnersTable.assetId, assetId),
      );
    }
    for (const userId of userIds) {
      await db.delete(financeAssetsTable).where(
        eq(financeAssetsTable.userId, userId),
      );
      await db.delete(financeLedgerEntriesTable).where(
        eq(financeLedgerEntriesTable.userId, userId),
      );
      await db.delete(financeCurrencyRatesTable).where(
        eq(financeCurrencyRatesTable.userId, userId),
      );
      await db.delete(financeBudgetsTable).where(
        eq(financeBudgetsTable.userId, userId),
      );
      await db.delete(financePartiesTable).where(
        eq(financePartiesTable.userId, userId),
      );
    }
  } finally {
    await pool.end();
  }
});

test("dashboard reports keep currency conversion and asset-share behavior", async () => {
  const userId = nextTestUserId();
  const now = new Date();
  const dueDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await db.insert(financeCurrencyRatesTable).values({ userId, currency: "USD", rateToBase: 120 });
  await db.insert(financeLedgerEntriesTable).values([
    {
      userId,
      kind: "income",
      title: "USD income",
      amount: 10,
      currency: "USD",
      status: "pending",
      occurredDate: now,
      dueDate,
    },
    {
      userId,
      kind: "expense",
      title: "Food expense",
      amount: 5,
      currency: "BDT",
      category: "Food",
      status: "pending",
      occurredDate: now,
    },
  ]);
  const [asset] = await db.insert(financeAssetsTable).values({
    userId,
    assetType: "cash",
    name: "Shared cash",
    totalValue: 1_000,
  }).returning({ id: financeAssetsTable.id });
  assetIds.add(asset.id);
  await db.insert(financeAssetOwnersTable).values([
    { assetId: asset.id, partyId: null, ownerName: "Me", ownershipPercent: 40 },
    { assetId: asset.id, partyId: 42, ownerName: "Co-owner", ownershipPercent: 60 },
  ]);
  await db.insert(financeBudgetsTable).values({ userId, category: "Food", monthlyLimit: 4 });

  const summary = await getFinanceSummary(userId);
  assert.equal(summary.totalIncome, 1_200);
  assert.equal(summary.totalExpense, 5);
  assert.equal(summary.currentBalance, 400);
  assert.equal(summary.netWorth, 400);
  assert.equal(summary.upcoming.length, 1);

  const projections = await getFinanceProjections(userId);
  assert.equal(projections.monthlyIncome, 200);
  assert.equal(projections.currentBalance, 1_000);
  assert.deepEqual(projections.scenarios.map((row) => row.months), [3, 6, 12]);

  const analytics = await getFinanceAnalytics(userId);
  assert.equal(analytics.monthlyTrend.length, 12);
  assert.equal(analytics.expenseByCategory.find((row) => row.category === "Food")?.value, 5);
  assert.equal(analytics.assetAllocation.find((row) => row.assetType === "cash")?.value, 400);
  assert.deepEqual(analytics.projectPnl, []);

  const insights = await getFinanceInsights(userId);
  assert.equal(insights.budgetStatus[0]?.pct, 125);
  assert.equal(insights.alerts.some((alert) => alert.title === "1 budget over limit"), true);
  assert.deepEqual(insights.cashflowForecast.map((row) => row.days), [30, 60, 90]);

  const exportRows = await getFinanceExportRows(userId, "expense");
  assert.equal(exportRows.length, 1);
  assert.equal(exportRows[0]?.title, "Food expense");
});

test("custom report filters by the user's default book and converts totals", async () => {
  const userId = nextTestUserId();
  await db.insert(financeCurrencyRatesTable).values({ userId, currency: "USD", rateToBase: 120 });
  const [party] = await db.insert(financePartiesTable).values({ userId, name: "Report party" }).returning();
  const bookId = await resolveBookId(userId);
  await db.insert(financeLedgerEntriesTable).values([
    {
      userId,
      bookId,
      kind: "income",
      title: "Party income",
      amount: 10,
      currency: "USD",
      partyId: party.id,
      status: "pending",
    },
    {
      userId,
      bookId,
      kind: "expense",
      title: "Local expense",
      amount: 5,
      currency: "BDT",
      partyId: party.id,
      status: "pending",
    },
    {
      userId,
      bookId: null,
      kind: "income",
      title: "Unassigned book",
      amount: 9_999,
      currency: "BDT",
      status: "pending",
    },
  ]);

  const report = await getCustomFinanceReport(userId, { groupBy: "party" });
  assert.equal(report.groupBy, "party");
  assert.equal(report.baseCurrency, "BDT");
  assert.equal(report.entryCount, 2);
  assert.equal(report.groups[0]?.label, "Report party");
  assert.equal(report.grandTotal, 1_205);
  assert.deepEqual(report.filters.kind, []);
});

test("accounting report use cases preserve empty-report response shapes", async () => {
  const userId = nextTestUserId();
  assert.deepEqual(await getTrialBalanceReport(userId, {}), []);

  const balanceSheet = await getBalanceSheetReport(userId, {});
  assert.deepEqual(balanceSheet, {
    assets: [],
    liabilities: [],
    equity: [],
    totalAssets: 0,
    totalLiabilities: 0,
    totalEquity: 0,
    balanced: true,
  });

  assert.deepEqual(await getIncomeStatementReport(userId, {}), {
    income: [],
    expense: [],
    totalIncome: 0,
    totalExpense: 0,
    netIncome: 0,
  });

  const cashFlow = await getCashFlowReport(userId, {});
  assert.equal(cashFlow.from, null);
  assert.equal(cashFlow.beginningCash, 0);
  assert.equal(cashFlow.endingCash, 0);
  assert.equal(cashFlow.netChangeInCash, 0);
  assert.equal(cashFlow.reconciled, true);
});
