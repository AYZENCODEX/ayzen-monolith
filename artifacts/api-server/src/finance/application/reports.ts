import {
  db,
  financeAssetOwnersTable,
  financeAssetsTable,
  financeBudgetsTable,
  financeCurrencyRatesTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
  financePartiesTable,
  financeRecurringRulesTable,
  projectsTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { computeAccountBalances } from "../ledger/balances";
import { resolveBookId } from "../ledger/books";
import { computeNetWorthBreakdown } from "../networth/networth";

// Shared database-backed currency helpers used by the report use cases and
// the existing investment/budget route adapters.
export async function getRateMap(userId: number): Promise<Record<string, number>> {
  const rows = await db.select().from(financeCurrencyRatesTable)
    .where(eq(financeCurrencyRatesTable.userId, userId));
  const map: Record<string, number> = { BDT: 1 };
  for (const row of rows) map[row.currency] = row.rateToBase;
  return map;
}

export function toBase(amount: number, currency: string, rates: Record<string, number>): number {
  return amount * (rates[currency] ?? 1);
}

export async function getFinanceSummary(userId: number) {
  // Group by kind AND currency before converting; raw amounts from different
  // currencies must not be added as if they share a unit.
  const rates = await getRateMap(userId);
  const totalsByCurrency = await db.select({
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    interestPaid: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.interestPaid}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    ))
    .groupBy(financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const byKind: Record<string, { total: number; interestPaid: number }> = {};
  for (const row of totalsByCurrency) {
    const bucket = byKind[row.kind] ?? { total: 0, interestPaid: 0 };
    bucket.total += toBase(row.total, row.currency, rates);
    bucket.interestPaid += toBase(row.interestPaid, row.currency, rates);
    byKind[row.kind] = bucket;
  }

  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const upcoming = await db.select().from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      isNotNull(financeLedgerEntriesTable.dueDate),
      gte(financeLedgerEntriesTable.dueDate, now),
      lte(financeLedgerEntriesTable.dueDate, in30),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    ))
    .orderBy(financeLedgerEntriesTable.dueDate);

  const netWorthBreakdown = await computeNetWorthBreakdown(userId);
  const totalReceivable = byKind["receivable"]?.total ?? 0;
  const totalPayable = byKind["payable"]?.total ?? 0;
  const totalBorrowed = byKind["borrowed"]?.total ?? 0;
  const totalLending = byKind["lending"]?.total ?? 0;
  const totalExpense = byKind["expense"]?.total ?? 0;
  const totalIncome = byKind["income"]?.total ?? 0;
  const totalInvested = byKind["investment"]?.total ?? 0;
  const interestPaid = Object.values(byKind).reduce((sum, row) => sum + row.interestPaid, 0);

  const interestOwedRows = await db.select({
    v: financeLedgerEntriesTable.interestRate,
    amount: financeLedgerEntriesTable.amount,
    currency: financeLedgerEntriesTable.currency,
    paid: financeLedgerEntriesTable.interestPaid,
  })
    .from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      sql`${financeLedgerEntriesTable.kind} IN ('borrowed', 'lending', 'investment')`,
      isNotNull(financeLedgerEntriesTable.interestRate),
    ));
  const interestOwed = interestOwedRows.reduce(
    (sum, row) => sum + Math.max(0, toBase(((row.v ?? 0) / 100) * row.amount - row.paid, row.currency, rates)),
    0,
  );

  return {
    totalBorrowed,
    totalReceivable,
    totalPayable,
    totalLending,
    totalInvested,
    totalExpense,
    totalIncome,
    currentBalance: netWorthBreakdown.totalAssets,
    netWorth: netWorthBreakdown.netWorth,
    interestPaid,
    interestOwed,
    upcoming,
  };
}

export async function getFinanceProjections(userId: number) {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const rates = await getRateMap(userId);
  const rowsByCurrency = await db.select({
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      gte(financeLedgerEntriesTable.occurredDate, sixMonthsAgo),
    ))
    .groupBy(financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const byKind: Record<string, number> = {};
  for (const row of rowsByCurrency) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + toBase(row.total, row.currency, rates);
  }
  const monthlyIncome = (byKind["income"] ?? 0) / 6;
  const monthlyExpense = (byKind["expense"] ?? 0) / 6;
  const monthlyNet = monthlyIncome - monthlyExpense;

  // Asset values are already stored in the user's base currency.
  const assets = await db.select().from(financeAssetsTable)
    .where(eq(financeAssetsTable.userId, userId));
  const currentBalance = assets.reduce((sum, asset) => sum + asset.totalValue, 0);

  const receivables = await db.select({
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    currency: financeLedgerEntriesTable.currency,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.kind, "receivable"),
      sql`${financeLedgerEntriesTable.status} != 'paid'`,
    ))
    .groupBy(financeLedgerEntriesTable.currency);
  const payables = await db.select({
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    currency: financeLedgerEntriesTable.currency,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.kind, "payable"),
      sql`${financeLedgerEntriesTable.status} != 'paid'`,
    ))
    .groupBy(financeLedgerEntriesTable.currency);
  const totalReceivable = receivables.reduce((sum, row) => sum + toBase(row.total, row.currency, rates), 0);
  const totalPayable = payables.reduce((sum, row) => sum + toBase(row.total, row.currency, rates), 0);

  const scenarios = [3, 6, 12].map((months) => ({
    months,
    currentTrend: currentBalance + monthlyNet * months,
    allReceivablesCollected: currentBalance + totalReceivable + monthlyNet * months,
    allPayablesPaid: currentBalance - totalPayable + monthlyNet * months,
  }));
  return { monthlyIncome, monthlyExpense, monthlyNet, currentBalance, scenarios };
}

export async function getFinanceExportRows(userId: number, kind?: string) {
  const conditions = [eq(financeLedgerEntriesTable.userId, userId)];
  if (kind) conditions.push(eq(financeLedgerEntriesTable.kind, kind));
  return db.select().from(financeLedgerEntriesTable)
    .where(and(...conditions))
    .orderBy(desc(financeLedgerEntriesTable.occurredDate));
}

export async function getFinanceAnalytics(userId: number) {
  const rates = await getRateMap(userId);
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);

  const rows = await db.select({
    kind: financeLedgerEntriesTable.kind,
    amount: financeLedgerEntriesTable.amount,
    currency: financeLedgerEntriesTable.currency,
    category: financeLedgerEntriesTable.category,
    occurredDate: financeLedgerEntriesTable.occurredDate,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      gte(financeLedgerEntriesTable.occurredDate, twelveMonthsAgo),
    ));

  const monthly = new Map<string, { income: number; expense: number }>();
  for (let i = 0; i < 12; i++) {
    const date = new Date(twelveMonthsAgo);
    date.setMonth(date.getMonth() + i);
    monthly.set(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, {
      income: 0,
      expense: 0,
    });
  }
  for (const row of rows) {
    if (row.kind !== "income" && row.kind !== "expense") continue;
    const key = `${row.occurredDate.getFullYear()}-${String(row.occurredDate.getMonth() + 1).padStart(2, "0")}`;
    const bucket = monthly.get(key);
    if (!bucket) continue;
    const base = toBase(row.amount, row.currency, rates);
    if (row.kind === "income") bucket.income += base;
    else bucket.expense += base;
  }
  const monthlyTrend = [...monthly.entries()].map(([month, value]) => ({
    month,
    ...value,
    net: value.income - value.expense,
  }));

  const byCategory = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "expense") continue;
    const category = row.category?.trim() || "Uncategorized";
    byCategory.set(category, (byCategory.get(category) ?? 0) + toBase(row.amount, row.currency, rates));
  }
  const expenseByCategory = [...byCategory.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value);

  const assets = await db.select().from(financeAssetsTable)
    .where(eq(financeAssetsTable.userId, userId));
  const assetIds = assets.map((asset) => asset.id);
  const owners = assetIds.length > 0
    ? await db.select().from(financeAssetOwnersTable)
      .where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const byType = new Map<string, number>();
  for (const asset of assets) {
    const mine = owners.filter((owner) => owner.assetId === asset.id && owner.partyId == null);
    const percent = mine.length ? mine.reduce((sum, owner) => sum + owner.ownershipPercent, 0) : 100;
    byType.set(asset.assetType, (byType.get(asset.assetType) ?? 0) + asset.totalValue * (percent / 100));
  }
  const assetAllocation = [...byType.entries()].map(([assetType, value]) => ({ assetType, value }));

  const projectRows = await db.select({
    projectId: financeLedgerEntriesTable.projectId,
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      isNotNull(financeLedgerEntriesTable.projectId),
      sql`${financeLedgerEntriesTable.kind} IN ('expense', 'income')`,
    ))
    .groupBy(
      financeLedgerEntriesTable.projectId,
      financeLedgerEntriesTable.kind,
      financeLedgerEntriesTable.currency,
    );
  const projectIds = [...new Set(projectRows.map((row) => row.projectId).filter((id): id is number => id != null))];
  const projects = projectIds.length > 0
    ? await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable)
      .where(sql`${projectsTable.id} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  const nameById = new Map(projects.map((project) => [project.id, project.name]));
  const projectPnlMap = new Map<number, number>();
  for (const row of projectRows) {
    if (row.projectId == null) continue;
    const totalBase = toBase(row.total, row.currency, rates);
    projectPnlMap.set(
      row.projectId,
      (projectPnlMap.get(row.projectId) ?? 0) + (row.kind === "income" ? totalBase : -totalBase),
    );
  }
  const projectPnl = [...projectPnlMap.entries()].map(([projectId, pnl]) => ({
    projectId,
    projectName: nameById.get(projectId) ?? `Project #${projectId}`,
    pnl,
  }));
  return { monthlyTrend, expenseByCategory, assetAllocation, projectPnl };
}

const DIRECTION: Record<string, 1 | -1> = {
  receivable: 1, lending: 1, income: 1, investment: 1,
  payable: -1, borrowed: -1, expense: -1,
};

function countRecurringOccurrences(
  rule: { frequency: string; intervalCount: number; nextRunDate: Date; endDate: Date | null },
  from: Date,
  to: Date,
): number {
  let cursor = new Date(Math.max(rule.nextRunDate.getTime(), from.getTime()));
  const hardStop = rule.endDate && rule.endDate < to ? rule.endDate : to;
  let count = 0;
  for (let i = 0; i < 500 && cursor <= hardStop; i++) {
    count++;
    const next = new Date(cursor);
    const interval = Math.max(1, rule.intervalCount || 1);
    if (rule.frequency === "daily") next.setDate(next.getDate() + interval);
    else if (rule.frequency === "weekly") next.setDate(next.getDate() + interval * 7);
    else if (rule.frequency === "yearly") next.setFullYear(next.getFullYear() + interval);
    else next.setMonth(next.getMonth() + interval);
    cursor = next;
  }
  return count;
}

function fmtBase(amount: number): string {
  return `${Math.round(amount).toLocaleString()} BDT`;
}

export async function getFinanceInsights(userId: number) {
  const rates = await getRateMap(userId);
  const now = new Date();
  const openEntries = await db.select().from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      sql`${financeLedgerEntriesTable.status} NOT IN ('paid', 'closed')`,
    ));
  const alerts: Array<{ severity: "critical" | "warning" | "info"; title: string; detail: string; link?: string }> = [];

  const overdue = openEntries.filter((entry) => entry.dueDate && entry.dueDate < now);
  if (overdue.length) {
    const total = overdue.reduce((sum, entry) => sum + toBase(entry.amount, entry.currency, rates), 0);
    alerts.push({
      severity: "critical",
      title: `${overdue.length} overdue ${overdue.length === 1 ? "entry" : "entries"}`,
      detail: `Totaling ~${fmtBase(total)} past their due date — collect or settle these first.`,
      link: "/finance/ledger",
    });
  }

  const in7 = new Date(now.getTime() + 7 * 86400000);
  const dueSoon = openEntries.filter((entry) => entry.dueDate && entry.dueDate >= now && entry.dueDate <= in7);
  if (dueSoon.length) {
    const total = dueSoon.reduce((sum, entry) => sum + toBase(entry.amount, entry.currency, rates), 0);
    alerts.push({
      severity: "warning",
      title: `${dueSoon.length} due within 7 days`,
      detail: `~${fmtBase(total)} coming due this week.`,
      link: "/finance/ledger",
    });
  }

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const budgets = await db.select().from(financeBudgetsTable)
    .where(eq(financeBudgetsTable.userId, userId));
  const spentRows = await db.select({
    category: financeLedgerEntriesTable.category,
    currency: financeLedgerEntriesTable.currency,
    spent: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.kind, "expense"),
      gte(financeLedgerEntriesTable.occurredDate, monthStart),
    ))
    .groupBy(financeLedgerEntriesTable.category, financeLedgerEntriesTable.currency);
  const spentByCategory = new Map<string, number>();
  for (const row of spentRows) {
    const key = row.category ?? "Uncategorized";
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + toBase(row.spent, row.currency, rates));
  }

  let overBudgetCount = 0;
  let nearBudgetCount = 0;
  const budgetStatus = budgets.map((budget) => {
    const spent = spentByCategory.get(budget.category) ?? 0;
    const pct = budget.monthlyLimit > 0 ? (spent / budget.monthlyLimit) * 100 : 0;
    if (pct >= 100) overBudgetCount++;
    else if (pct >= 80) nearBudgetCount++;
    return { category: budget.category, spent, monthlyLimit: budget.monthlyLimit, pct: Math.round(pct) };
  }).sort((a, b) => b.pct - a.pct);

  if (overBudgetCount) {
    alerts.push({
      severity: "critical",
      title: `${overBudgetCount} budget${overBudgetCount === 1 ? "" : "s"} over limit`,
      detail: "This month's spend has crossed the cap you set for that category.",
      link: "/finance/budgets",
    });
  }
  if (nearBudgetCount) {
    alerts.push({
      severity: "warning",
      title: `${nearBudgetCount} budget${nearBudgetCount === 1 ? "" : "s"} near the limit`,
      detail: "80%+ of this month's cap used already.",
      link: "/finance/budgets",
    });
  }

  const interestOwedRows = openEntries.filter(
    (entry) => entry.interestRate != null
      && (entry.kind === "borrowed" || entry.kind === "lending" || entry.kind === "investment"),
  );
  const interestOwed = interestOwedRows.reduce(
    (sum, entry) => sum + Math.max(
      0,
      toBase(((entry.interestRate ?? 0) / 100) * entry.amount - entry.interestPaid, entry.currency, rates),
    ),
    0,
  );
  if (interestOwed > 0) {
    alerts.push({
      severity: "info",
      title: "Unsettled interest",
      detail: `~${fmtBase(interestOwed)} of accrued interest hasn't been recorded as paid yet.`,
      link: "/finance/interest",
    });
  }

  if (!alerts.length) {
    alerts.push({
      severity: "info",
      title: "All clear",
      detail: "No overdue items, budget overruns, or dues in the next 7 days.",
    });
  }

  const assets = await db.select().from(financeAssetsTable)
    .where(eq(financeAssetsTable.userId, userId));
  const assetIds = assets.map((asset) => asset.id);
  const owners = assetIds.length > 0
    ? await db.select().from(financeAssetOwnersTable)
      .where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map((id) => sql`${id}`), sql`, `)})`)
    : [];
  let currentBalance = 0;
  for (const asset of assets) {
    const mine = owners.filter((owner) => owner.assetId === asset.id && owner.partyId == null);
    const percent = mine.length ? mine.reduce((sum, owner) => sum + owner.ownershipPercent, 0) : 100;
    currentBalance += asset.totalValue * (percent / 100);
  }

  const recurringRules = await db.select().from(financeRecurringRulesTable)
    .where(and(
      eq(financeRecurringRulesTable.userId, userId),
      eq(financeRecurringRulesTable.active, 1),
    ));
  const cashflowForecast = [30, 60, 90].map((days) => {
    const horizon = new Date(now.getTime() + days * 86400000);
    const ledgerNet = openEntries
      .filter((entry) => entry.dueDate && entry.dueDate >= now && entry.dueDate <= horizon)
      .reduce((sum, entry) => sum + (DIRECTION[entry.kind] ?? 0) * toBase(entry.amount, entry.currency, rates), 0);
    const recurringNet = recurringRules.reduce((sum, rule) => {
      const occurrences = countRecurringOccurrences(rule, now, horizon);
      return sum + occurrences * (DIRECTION[rule.kind] ?? 0) * toBase(rule.amount, rule.currency, rates);
    }, 0);
    return { days, netChange: ledgerNet + recurringNet, projectedBalance: currentBalance + ledgerNet + recurringNet };
  });

  let score = 100;
  score -= Math.min(32, overdue.length * 8);
  score -= Math.min(30, overBudgetCount * 10);
  score -= Math.min(12, nearBudgetCount * 4);
  const totalReceivableLike = openEntries
    .filter((entry) => entry.kind === "receivable" || entry.kind === "lending")
    .reduce((sum, entry) => sum + toBase(entry.amount, entry.currency, rates), 0);
  const totalPayableLike = openEntries
    .filter((entry) => entry.kind === "payable" || entry.kind === "borrowed")
    .reduce((sum, entry) => sum + toBase(entry.amount, entry.currency, rates), 0);
  const netWorth = currentBalance + totalReceivableLike - totalPayableLike;
  if (netWorth < 0) score -= 15;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const healthLabel = score >= 80 ? "Healthy" : score >= 60 ? "Stable" : score >= 40 ? "Needs Attention" : "At Risk";

  return { healthScore: score, healthLabel, alerts, budgetStatus, cashflowForecast };
}

export const REPORT_GROUP_BY = ["kind", "category", "party", "month", "status", "currency"] as const;
export type ReportGroupBy = typeof REPORT_GROUP_BY[number];
export type CustomFinanceReport = {
  groupBy: ReportGroupBy;
  baseCurrency: "BDT";
  from: string | null;
  to: string | null;
  filters: { kind: string[]; category: string[]; bookId: number };
  groups: { label: string; count: number; total: number }[];
  grandTotal: number;
  entryCount: number;
};

export async function getCustomFinanceReport(
  userId: number,
  query: Record<string, string | undefined>,
): Promise<CustomFinanceReport> {
  const groupBy = (REPORT_GROUP_BY as readonly string[]).includes(query.groupBy ?? "")
    ? query.groupBy as ReportGroupBy
    : "kind";
  const resolvedBookId = await resolveBookId(
    userId,
    query.bookId ? parseInt(query.bookId, 10) : undefined,
  );
  const conditions = [
    eq(financeLedgerEntriesTable.userId, userId),
    eq(financeLedgerEntriesTable.bookId, resolvedBookId),
  ];
  if (query.from) conditions.push(gte(financeLedgerEntriesTable.occurredDate, new Date(query.from)));
  if (query.to) conditions.push(lte(financeLedgerEntriesTable.occurredDate, new Date(query.to)));
  const kinds = query.kind ? query.kind.split(",").filter(Boolean) : [];
  if (kinds.length > 0) conditions.push(inArray(financeLedgerEntriesTable.kind, kinds));
  const categories = query.category ? query.category.split(",").filter(Boolean) : [];
  if (categories.length > 0) conditions.push(inArray(financeLedgerEntriesTable.category, categories));

  const [entries, parties, rates] = await Promise.all([
    db.select().from(financeLedgerEntriesTable)
      .where(and(...conditions))
      .orderBy(desc(financeLedgerEntriesTable.occurredDate)),
    db.select().from(financePartiesTable).where(eq(financePartiesTable.userId, userId)),
    getRateMap(userId),
  ]);
  const partyName = new Map(parties.map((party) => [party.id, party.name]));
  const keyOf = (entry: typeof financeLedgerEntriesTable.$inferSelect): string => {
    switch (groupBy) {
      case "kind": return entry.kind;
      case "category": return entry.category || "Uncategorized";
      case "party": return entry.partyId ? (partyName.get(entry.partyId) || `Party #${entry.partyId}`) : "No party";
      case "month": return entry.occurredDate.toISOString().slice(0, 7);
      case "status": return entry.status;
      case "currency": return entry.currency;
    }
  };
  const groups = new Map<string, { label: string; count: number; totalBase: number }>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!groups.has(key)) groups.set(key, { label: key, count: 0, totalBase: 0 });
    const group = groups.get(key)!;
    group.count += 1;
    group.totalBase += toBase(entry.amount, entry.currency, rates);
  }
  const groupRows = [...groups.values()]
    .map((group) => ({
      label: group.label,
      count: group.count,
      total: Math.round(group.totalBase * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = Math.round(groupRows.reduce((sum, group) => sum + group.total, 0) * 100) / 100;
  return {
    groupBy,
    baseCurrency: "BDT",
    from: query.from || null,
    to: query.to || null,
    filters: { kind: kinds, category: categories, bookId: resolvedBookId },
    groups: groupRows,
    grandTotal,
    entryCount: entries.length,
  };
}

export async function getTrialBalanceReport(
  userId: number,
  query: Record<string, string | undefined>,
) {
  const { asOf, bookId } = query;
  return computeAccountBalances(userId, {
    to: asOf ? new Date(asOf) : undefined,
    bookId: bookId ? parseInt(bookId, 10) : undefined,
  });
}

export async function getBalanceSheetReport(
  userId: number,
  query: Record<string, string | undefined>,
) {
  const { asOf, bookId } = query;
  const rows = await computeAccountBalances(userId, {
    to: asOf ? new Date(asOf) : undefined,
    bookId: bookId ? parseInt(bookId, 10) : undefined,
  });
  const assets = rows.filter((row) => row.type === "asset");
  const liabilities = rows.filter((row) => row.type === "liability");
  const equity = rows.filter((row) => row.type === "equity");
  const income = rows.filter((row) => row.type === "income");
  const expense = rows.filter((row) => row.type === "expense");
  const netIncome = income.reduce((sum, row) => sum + row.balance, 0)
    - expense.reduce((sum, row) => sum + row.balance, 0);
  const equityRows = netIncome !== 0
    ? [...equity, {
      accountId: -1,
      code: "3900",
      name: "Current Earnings",
      type: "equity" as const,
      totalDebit: 0,
      totalCredit: 0,
      balance: netIncome,
    }]
    : equity;
  const totalAssets = assets.reduce((sum, row) => sum + row.balance, 0);
  const totalLiabilities = liabilities.reduce((sum, row) => sum + row.balance, 0);
  const totalEquity = equityRows.reduce((sum, row) => sum + row.balance, 0);
  return {
    assets,
    liabilities,
    equity: equityRows,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

export async function getIncomeStatementReport(
  userId: number,
  query: Record<string, string | undefined>,
) {
  const { from, to, bookId } = query;
  const rows = await computeAccountBalances(userId, {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
    bookId: bookId ? parseInt(bookId, 10) : undefined,
  });
  const income = rows.filter((row) => row.type === "income");
  const expense = rows.filter((row) => row.type === "expense");
  const totalIncome = income.reduce((sum, row) => sum + row.balance, 0);
  const totalExpense = expense.reduce((sum, row) => sum + row.balance, 0);
  return { income, expense, totalIncome, totalExpense, netIncome: totalIncome - totalExpense };
}

export async function getCashFlowReport(
  userId: number,
  query: Record<string, string | undefined>,
) {
  const { from, to, bookId } = query;
  const resolvedBookId = bookId ? parseInt(bookId, 10) : undefined;
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;
  const rows = await computeAccountBalances(userId, {
    from: fromDate,
    to: toDate,
    bookId: resolvedBookId,
  });
  const byCode = new Map(rows.map((row) => [row.code, row]));
  const changeOf = (code: string) => byCode.get(code)?.balance ?? 0;
  const income = rows.filter((row) => row.type === "income");
  const expense = rows.filter((row) => row.type === "expense");
  const netIncome = income.reduce((sum, row) => sum + row.balance, 0)
    - expense.reduce((sum, row) => sum + row.balance, 0);
  const depreciationAddback = changeOf("5200");
  const operatingActivities = [
    { label: "Net Income", amount: netIncome },
    { label: "Depreciation & Amortization", amount: depreciationAddback },
    { label: "Change in Accounts Receivable", amount: -changeOf("1100") },
    { label: "Change in Accounts Payable", amount: changeOf("2000") },
  ];
  const netOperating = operatingActivities.reduce((sum, row) => sum + row.amount, 0);
  const investingActivities = [
    { label: "Change in Loans Receivable (Lending)", amount: -changeOf("1200") },
    { label: "Change in Investments", amount: -changeOf("1300") },
  ];
  const netInvesting = investingActivities.reduce((sum, row) => sum + row.amount, 0);
  const financingActivities = [
    { label: "Change in Loans Payable (Borrowed Funds)", amount: changeOf("2100") },
    { label: "Change in Owner's Equity", amount: changeOf("3000") },
  ];
  const netFinancing = financingActivities.reduce((sum, row) => sum + row.amount, 0);
  const netChangeInCash = netOperating + netInvesting + netFinancing;

  const [beginningRows, endingRows] = await Promise.all([
    fromDate
      ? computeAccountBalances(userId, { to: fromDate, bookId: resolvedBookId })
      : Promise.resolve([]),
    computeAccountBalances(userId, { to: toDate, bookId: resolvedBookId }),
  ]);
  const beginningCash = beginningRows.find((row) => row.code === "1000")?.balance ?? 0;
  const endingCash = endingRows.find((row) => row.code === "1000")?.balance ?? 0;
  return {
    from: fromDate ? fromDate.toISOString() : null,
    to: toDate ? toDate.toISOString() : new Date().toISOString(),
    operatingActivities,
    netOperating,
    investingActivities,
    netInvesting,
    financingActivities,
    netFinancing,
    netChangeInCash,
    beginningCash,
    endingCash,
    reconciled: Math.abs((endingCash - beginningCash) - netChangeInCash) < 0.01,
  };
}

/**
 * Per-project investment rollup (invested / spent / earned / interest owed), converted to the
 * user's base currency. Moved unchanged from routes/finance.ts GET /finance/investments.
 */
export async function getProjectInvestments(userId: number) {
  // Grouped by project AND kind AND currency, then converted to the user's base currency before
  // being summed — same reasoning as /finance/summary and /finance/projections (see
  // getRateMap/toBase): a project funded in both USD and BDT can't have its rows added together
  // as raw numbers.
  const rates = await getRateMap(userId);
  const rows = await db.select({
    projectId: financeLedgerEntriesTable.projectId,
    kind: financeLedgerEntriesTable.kind,
    currency: financeLedgerEntriesTable.currency,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
    // Actual interest amount owed (investment principal × rate%), not the raw interestRate
    // percentage itself — summing interestRate directly (e.g. two 10% rows -> "20") produced a
    // meaningless number.
    interestOwed: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount} * COALESCE(${financeLedgerEntriesTable.interestRate}, 0) / 100.0), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      isNotNull(financeLedgerEntriesTable.projectId),
      sql`${financeLedgerEntriesTable.kind} IN ('investment', 'expense', 'income')`,
    ))
    .groupBy(financeLedgerEntriesTable.projectId, financeLedgerEntriesTable.kind, financeLedgerEntriesTable.currency);

  const projectIds = [...new Set(rows.map(r => r.projectId).filter((x): x is number => x != null))];
  const projects = projectIds.length
    ? await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable)
        .where(sql`${projectsTable.id} IN (${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})`)
    : [];
  const nameById = new Map(projects.map(p => [p.id, p.name]));

  const byProject = new Map<number, { invested: number; spent: number; earned: number; interestOwed: number }>();
  for (const r of rows) {
    if (r.projectId == null) continue;
    const cur = byProject.get(r.projectId) ?? { invested: 0, spent: 0, earned: 0, interestOwed: 0 };
    const totalBase = toBase(r.total, r.currency, rates);
    if (r.kind === "investment") {
      cur.invested += totalBase;
      cur.interestOwed += toBase(r.interestOwed, r.currency, rates);
    }
    if (r.kind === "expense") cur.spent += totalBase;
    if (r.kind === "income") cur.earned += totalBase;
    byProject.set(r.projectId, cur);
  }

  return [...byProject.entries()].map(([projectId, v]) => ({
    projectId,
    projectName: nameById.get(projectId) ?? `Project #${projectId}`,
    invested: v.invested,
    spent: v.spent,
    earned: v.earned,
    interestOwed: v.interestOwed,
    netPnl: v.earned - v.spent,
    netPosition: v.invested - v.spent + v.earned,
  }));
}

