import { db, financeDepreciationTable, type FinanceAsset } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildDepreciationRows } from "../domain/schedules";
import { postJournal, postJournalInTx, type FinanceDbTransaction, type PostJournalOptions } from "../ledger/journal";

// DB-backed depreciation schedule and its journal posting. Persistence moved from
// lib/finance-accounting.ts (FIN-WP-4); the arithmetic is in domain/schedules.ts.

export interface DepreciationRowShape {
  id: number;
  assetId: number;
  periodNo: number;
  periodDate: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  bookValue: number;
  status: string;
  postedAt: string | null;
}

export function fmtDeprecRow(r: typeof financeDepreciationTable.$inferSelect): DepreciationRowShape {
  return {
    id: r.id,
    assetId: r.assetId,
    periodNo: r.periodNo,
    periodDate: r.periodDate.toISOString(),
    depreciationAmount: r.depreciationAmount,
    accumulatedDepreciation: r.accumulatedDepreciation,
    bookValue: r.bookValue,
    status: r.status,
    postedAt: r.postedAt ? r.postedAt.toISOString() : null,
  };
}

/**
 * Monthly depreciation schedule for an asset. Wipes any existing (unposted or posted) schedule for
 * the asset — same "regenerate from scratch" behavior as generateAmortizationSchedule. Caller is
 * responsible for not calling this again after periods have already been posted unless they mean
 * to redo it (posted journal entries from the old schedule are left as-is; only the schedule rows
 * themselves are replaced). The wipe and the insert are ONE transaction (F9).
 *
 * See domain/schedules.ts#buildDepreciationRows for the straight_line / declining_balance rules.
 */
export async function generateDepreciationSchedule(asset: FinanceAsset): Promise<DepreciationRowShape[]> {
  if (!asset.depreciationMethod || !asset.usefulLifeMonths || asset.usefulLifeMonths <= 0) return [];

  const cost = asset.purchasedValue ?? asset.totalValue ?? 0;
  const salvage = asset.salvageValue ?? 0;
  const months = asset.usefulLifeMonths;
  const startDate = asset.depreciationStartDate ?? asset.purchaseDate ?? new Date();

  const rows = buildDepreciationRows({ userId: asset.userId, assetId: asset.id, method: asset.depreciationMethod, cost, salvage, months, startDate });
  const inserted = await db.transaction(async (tx) => {
    await tx.delete(financeDepreciationTable).where(eq(financeDepreciationTable.assetId, asset.id));
    return tx.insert(financeDepreciationTable).values(rows).returning();
  });
  return inserted.map(fmtDeprecRow);
}

export async function listDepreciationForAsset(assetId: number): Promise<DepreciationRowShape[]> {
  const rows = await db.select().from(financeDepreciationTable)
    .where(eq(financeDepreciationTable.assetId, assetId))
    .orderBy(financeDepreciationTable.periodNo);
  return rows.map(fmtDeprecRow);
}

function depreciationJournalOptions(assetName: string, periodDate: Date, amount: number): PostJournalOptions {
  return {
    memo: `Depreciation — ${assetName}`,
    date: periodDate,
    lines: [
      { accountCode: "5200", debit: amount, credit: 0 },
      { accountCode: "1350", debit: 0, credit: amount },
    ],
    isManual: false,
  };
}

/** Post one depreciation period's journal entry: Depreciation Expense (dr) / Accumulated Depreciation (cr). */
export async function postDepreciationJournal(userId: number, assetName: string, periodDate: Date, amount: number): Promise<void> {
  if (!(amount > 0)) return;
  await postJournal(userId, depreciationJournalOptions(assetName, periodDate, amount));
}

/**
 * Same journal, inside the caller's transaction (F10b). Returns false when a journal was required
 * (amount > 0) but could not be posted, so the caller can roll back; true when posted or when there is
 * nothing to post (amount is not positive).
 */
export async function postDepreciationJournalInTx(
  tx: FinanceDbTransaction, userId: number, assetName: string, periodDate: Date, amount: number,
): Promise<boolean> {
  if (!(amount > 0)) return true;
  return (await postJournalInTx(tx, userId, depreciationJournalOptions(assetName, periodDate, amount))) !== null;
}
