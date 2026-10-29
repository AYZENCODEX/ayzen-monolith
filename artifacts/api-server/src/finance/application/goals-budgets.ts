import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db, financeBudgetsTable, financeGoalsTable, financeLedgerEntriesTable } from "@workspace/db";
import { syncGoalProgress } from "../networth/networth";
import { getRateMap, toBase } from "./reports";

// Savings goals and monthly category budgets. Moved unchanged from routes/finance.ts; the routes
// keep HTTP validation and the ownership middleware. Net-worth routes use networth/networth.ts.

// ─── Goals ───────────────────────────────────────────────────────────────────

export interface GoalCreateInput {
  title: string;
  goalType?: string;
  targetAmount: number;
  currentAmount?: number;
  currency?: string;
  targetDate?: string;
  linkedAssetId?: number | null;
  notes?: string;
}

export interface GoalUpdateInput {
  title?: string;
  goalType?: string;
  targetAmount?: number;
  currentAmount?: number;
  currency?: string;
  targetDate?: string | null;
  linkedAssetId?: number | null;
  status?: string;
  notes?: string;
}

export async function listGoals(userId: number) {
  const goals = await db.select().from(financeGoalsTable)
    .where(eq(financeGoalsTable.userId, userId)).orderBy(desc(financeGoalsTable.createdAt));
  return Promise.all(goals.map(syncGoalProgress));
}

export async function createGoal(userId: number, input: GoalCreateInput) {
  // Asset-linked goals mirror the asset's totalValue directly (see syncGoalProgress) and assets
  // carry no currency of their own — they're always stored in the user's base currency. So an
  // asset-linked goal must be forced to base currency too, or currentAmount (base-currency asset
  // value) and targetAmount (whatever currency was requested) would silently get compared/displayed
  // as if they were the same unit.
  const resolvedCurrency = input.linkedAssetId != null ? "BDT" : (input.currency?.trim() || "BDT");
  const [row] = await db.insert(financeGoalsTable).values({
    userId,
    title: input.title.trim(),
    goalType: input.goalType?.trim() || "savings",
    targetAmount: input.targetAmount,
    currentAmount: input.currentAmount ?? 0,
    currency: resolvedCurrency,
    targetDate: input.targetDate ? new Date(input.targetDate) : null,
    linkedAssetId: input.linkedAssetId ?? null,
    notes: input.notes?.trim() || null,
  }).returning();
  return syncGoalProgress(row);
}

/** Returns null when the goal does not exist for this user. */
export async function updateGoal(userId: number, id: number, input: GoalUpdateInput) {
  const [existing] = await db.select().from(financeGoalsTable)
    .where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, userId)));
  if (!existing) return null;
  // Whichever linkedAssetId this update leaves the goal with (the new value if one was sent,
  // otherwise whatever it already had) determines whether currency must stay pinned to base —
  // an asset-linked goal can never carry a non-base currency.
  const effectiveLinkedAssetId = input.linkedAssetId !== undefined ? input.linkedAssetId : existing.linkedAssetId;
  const resolvedCurrency = effectiveLinkedAssetId != null ? "BDT" : input.currency;
  const [row] = await db.update(financeGoalsTable).set({
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.goalType !== undefined ? { goalType: input.goalType } : {}),
    ...(input.targetAmount !== undefined ? { targetAmount: input.targetAmount } : {}),
    ...(input.currentAmount !== undefined ? { currentAmount: input.currentAmount } : {}),
    ...(resolvedCurrency !== undefined ? { currency: resolvedCurrency } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate ? new Date(input.targetDate) : null } : {}),
    ...(input.linkedAssetId !== undefined ? { linkedAssetId: input.linkedAssetId } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
    updatedAt: new Date(),
  }).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, userId))).returning();
  if (!row) return null;
  return syncGoalProgress(row);
}

export type ContributeResult =
  | { status: "ok"; goal: typeof financeGoalsTable.$inferSelect }
  | { status: "not_found" }
  | { status: "linked_asset" };

/**
 * Manual contribution — adds to currentAmount and auto-flags 'achieved' once the target is
 * reached. Not available on goals linked to an asset, since their currentAmount is derived from
 * the asset instead (see syncGoalProgress).
 *
 * The increment, the status flip and the "not linked to an asset" guard are ONE statement, so
 * concurrent contributions serialize on the row lock and each adds to the latest amount (finding
 * F7: the amount used to be computed in JS from a previously read value and one of two racing
 * contributions was lost). Arithmetic runs in double precision, exactly like the JS it replaces
 * (REAL columns are read as doubles), and the result is stored back into the REAL column.
 */
export async function contributeToGoal(userId: number, id: number, amount: number): Promise<ContributeResult> {
  const current = sql`${financeGoalsTable.currentAmount}::float8`;
  const next = sql`(${current} + ${amount}::float8)`;
  const [row] = await db.update(financeGoalsTable).set({
    currentAmount: next,
    status: sql`CASE WHEN ${financeGoalsTable.status} = 'active' AND ${next} >= ${financeGoalsTable.targetAmount}::float8 THEN 'achieved' ELSE ${financeGoalsTable.status} END`,
    updatedAt: new Date(),
  }).where(and(
    eq(financeGoalsTable.id, id),
    eq(financeGoalsTable.userId, userId),
    isNull(financeGoalsTable.linkedAssetId),
  )).returning();
  if (row) return { status: "ok", goal: row };

  // Nothing updated: either the goal is not this user's, or it is tracked through a linked asset.
  const [goal] = await db.select({ linkedAssetId: financeGoalsTable.linkedAssetId }).from(financeGoalsTable)
    .where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, userId)));
  if (!goal) return { status: "not_found" };
  return { status: "linked_asset" };
}

export async function deleteGoal(userId: number, id: number): Promise<void> {
  await db.delete(financeGoalsTable).where(and(eq(financeGoalsTable.id, id), eq(financeGoalsTable.userId, userId)));
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

export async function listBudgetsWithSpent(userId: number) {
  const budgets = await db.select().from(financeBudgetsTable).where(eq(financeBudgetsTable.userId, userId));

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Grouped by category AND currency, then converted to the user's base currency before summing —
  // monthlyLimit has no currency of its own (it's always in base currency), so comparing it against
  // a raw cross-currency sum (e.g. USD + BDT expenses added as if the same unit) would silently
  // misreport "spent" and could show a budget as under/over its limit incorrectly. Same reasoning
  // as /finance/summary's getRateMap/toBase.
  const rates = await getRateMap(userId);
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
  for (const r of spentRows) {
    const key = r.category ?? "Uncategorized";
    spentByCategory.set(key, (spentByCategory.get(key) ?? 0) + toBase(r.spent, r.currency, rates));
  }

  return budgets.map(b => ({ ...b, spent: spentByCategory.get(b.category) ?? 0 }));
}

export async function upsertBudget(userId: number, input: { category: string; monthlyLimit: number; notes?: string }) {
  const [row] = await db.insert(financeBudgetsTable)
    .values({ userId, category: input.category.trim(), monthlyLimit: input.monthlyLimit, notes: input.notes })
    .onConflictDoUpdate({
      target: [financeBudgetsTable.userId, financeBudgetsTable.category],
      set: { monthlyLimit: input.monthlyLimit, notes: input.notes, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function deleteBudget(userId: number, id: number): Promise<void> {
  await db.delete(financeBudgetsTable).where(and(eq(financeBudgetsTable.id, id), eq(financeBudgetsTable.userId, userId)));
}
