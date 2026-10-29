import { and, desc, eq, ne, sql } from "drizzle-orm";
import {
  db,
  financeAssetOwnersTable,
  financeAssetsTable,
  financeDepreciationTable,
  financeLedgerEntriesTable,
} from "@workspace/db";
import { generateAmortizationSchedule, listAmortizationForEntry } from "../schedules/amortization";
import { generateDepreciationSchedule, listDepreciationForAsset, postDepreciationJournalInTx } from "../schedules/depreciation";

// Fixed/financial assets, their owners, and the amortization/depreciation schedule use cases.
// Moved from routes/finance.ts (FIN-WP-4); bodies unchanged except postDepreciationPeriod (F10a,
// see below). Routes keep HTTP validation, PDP ownership middleware and response formatting.

type AssetRow = typeof financeAssetsTable.$inferSelect;
type OwnerRow = typeof financeAssetOwnersTable.$inferSelect;

export async function listAssets(userId: number, assetType?: string): Promise<Array<{ asset: AssetRow; owners: OwnerRow[] }>> {
  const conditions = [eq(financeAssetsTable.userId, userId)];
  if (assetType) conditions.push(eq(financeAssetsTable.assetType, assetType));

  const assets = await db.select().from(financeAssetsTable).where(and(...conditions)).orderBy(desc(financeAssetsTable.createdAt));
  const assetIds = assets.map(a => a.id);
  const owners = assetIds.length
    ? await db.select().from(financeAssetOwnersTable).where(sql`${financeAssetOwnersTable.assetId} IN (${sql.join(assetIds.map(id => sql`${id}`), sql`, `)})`)
    : [];

  return assets.map(a => ({ asset: a, owners: owners.filter(o => o.assetId === a.id) }));
}

/** Caller must have validated that assetType and a non-blank name are present. */
export async function createAsset(userId: number, b: Record<string, any>): Promise<{ asset: AssetRow; owners: OwnerRow[] }> {
  const [asset] = await db.insert(financeAssetsTable).values({
    userId,
    assetType: b.assetType,
    name: b.name.trim(),
    provider: b.provider ?? null,
    totalValue: Number(b.totalValue) || 0,
    purchasedValue: b.purchasedValue != null ? Number(b.purchasedValue) : null,
    interestRate: b.interestRate != null ? Number(b.interestRate) : null,
    purchaseDate: b.purchaseDate ? new Date(b.purchaseDate) : null,
    maturityDate: b.maturityDate ? new Date(b.maturityDate) : null,
    liquidity: b.liquidity ?? null,
    notes: b.notes ?? null,
  }).returning();

  const owners: Array<{ partyId?: number | null; ownerName: string; ownershipPercent: number }> =
    Array.isArray(b.owners) && b.owners.length ? b.owners : [{ partyId: null, ownerName: "You", ownershipPercent: 100 }];

  const ownerRows = owners.length
    ? await db.insert(financeAssetOwnersTable).values(
        owners.map(o => ({ assetId: asset.id, partyId: o.partyId ?? null, ownerName: o.ownerName, ownershipPercent: Number(o.ownershipPercent) || 0 }))
      ).returning()
    : [];

  return { asset, owners: ownerRows };
}

export type UpdateAssetOutcome =
  | { status: "ok"; asset: AssetRow; owners: OwnerRow[] }
  | { status: "invalid"; error: string }
  | { status: "not_found" };

export async function updateAsset(userId: number, id: number, b: Record<string, any>): Promise<UpdateAssetOutcome> {
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["assetType", "name", "provider", "liquidity", "notes"]) {
    if (b[k] !== undefined) update[k] = b[k];
  }
  // BUG FIX (kept from the route): totalValue/purchasedValue/interestRate used to go straight from
  // `b[k]` into `update[k]` with no coercion or validation — unlike POST /finance/assets, which does
  // `Number(b.totalValue) || 0`. A string, empty value, or NaN would either fail at the DB or be
  // silently coerced downstream and poison every calculation that reads totalValue: net worth
  // (computeNetWorthBreakdown), any goal linked to this asset (syncGoalProgress), and the
  // assetAllocation / analytics breakdowns. Validate the same way POST does.
  for (const k of ["totalValue", "purchasedValue", "interestRate"] as const) {
    if (b[k] !== undefined) {
      if (b[k] === null) {
        if (k === "totalValue") return { status: "invalid", error: "totalValue cannot be null" }; // NOT NULL column
        update[k] = null; // purchasedValue/interestRate are nullable
        continue;
      }
      const n = Number(b[k]);
      if (!Number.isFinite(n)) return { status: "invalid", error: `${k} must be a valid number` };
      update[k] = n;
    }
  }
  if (b.purchaseDate !== undefined) update.purchaseDate = b.purchaseDate ? new Date(b.purchaseDate) : null;
  if (b.maturityDate !== undefined) update.maturityDate = b.maturityDate ? new Date(b.maturityDate) : null;

  const [asset] = await db.update(financeAssetsTable)
    .set(update)
    .where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, userId)))
    .returning();
  if (!asset) return { status: "not_found" };

  let ownerRows = await db.select().from(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
  if (Array.isArray(b.owners)) {
    await db.delete(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
    ownerRows = b.owners.length
      ? await db.insert(financeAssetOwnersTable).values(
          b.owners.map((o: any) => ({ assetId: id, partyId: o.partyId ?? null, ownerName: o.ownerName, ownershipPercent: Number(o.ownershipPercent) || 0 }))
        ).returning()
      : [];
  }

  return { status: "ok", asset, owners: ownerRows };
}

/** Ownership is confirmed BEFORE the owners are deleted, so another user's asset id cannot be wiped. False when not found. */
export async function deleteAsset(userId: number, id: number): Promise<boolean> {
  const [owned] = await db.select({ id: financeAssetsTable.id }).from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, userId)));
  if (!owned) return false;
  await db.delete(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, id));
  await db.delete(financeAssetsTable).where(and(eq(financeAssetsTable.id, id), eq(financeAssetsTable.userId, userId)));
  return true;
}

// ─── Loan amortization ───────────────────────────────────────────────────────

async function ownsEntry(entryId: number, userId: number): Promise<boolean> {
  const rows = await db.select({ id: financeLedgerEntriesTable.id })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** Null when the entry is not this user's. */
export async function listAmortization(userId: number, entryId: number) {
  if (!(await ownsEntry(entryId, userId))) return null;
  return listAmortizationForEntry(entryId);
}

export type GenerateAmortizationOutcome =
  | { status: "ok"; rows: Awaited<ReturnType<typeof generateAmortizationSchedule>> }
  | { status: "not_found" }
  | { status: "wrong_kind" };

/** Caller must have validated months >= 1. */
export async function generateAmortization(userId: number, entryId: number, months: number): Promise<GenerateAmortizationOutcome> {
  const [entry] = await db.select().from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!entry) return { status: "not_found" };
  if (entry.kind !== "borrowed" && entry.kind !== "lending") return { status: "wrong_kind" };
  return { status: "ok", rows: await generateAmortizationSchedule(entry, months) };
}

// ─── Depreciation ────────────────────────────────────────────────────────────

async function findOwnedAsset(userId: number, assetId: number) {
  const [asset] = await db.select().from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, assetId), eq(financeAssetsTable.userId, userId)));
  return asset;
}

/** Null when the asset is not this user's. */
export async function listDepreciation(userId: number, assetId: number) {
  if (!(await findOwnedAsset(userId, assetId))) return null;
  return listDepreciationForAsset(assetId);
}

export interface GenerateDepreciationInput {
  method: "straight_line" | "declining_balance";
  months: number;
  salvageValue?: number;
  startDate?: string;
}

/** Null when the asset is not this user's. Caller must have validated method and months >= 1. */
export async function generateDepreciation(userId: number, assetId: number, input: GenerateDepreciationInput) {
  const asset = await findOwnedAsset(userId, assetId);
  if (!asset) return null;

  const [updatedAsset] = await db.update(financeAssetsTable)
    .set({
      depreciationMethod: input.method,
      usefulLifeMonths: input.months,
      salvageValue: input.salvageValue ?? 0,
      depreciationStartDate: input.startDate ? new Date(input.startDate) : (asset.purchaseDate ?? new Date()),
      updatedAt: new Date(),
    })
    .where(eq(financeAssetsTable.id, assetId))
    .returning();

  return generateDepreciationSchedule(updatedAsset);
}

export type PostDepreciationOutcome =
  | { status: "ok"; row: typeof financeDepreciationTable.$inferSelect }
  | { status: "not_found" }
  | { status: "asset_not_found" }
  | { status: "journal_failed" };

class DepreciationJournalFailed extends Error {}

/** Test seam: lets a test force the journal step to fail. Production callers never pass it. */
export interface PostDepreciationDeps { postJournalInTx?: typeof postDepreciationJournalInTx }

/**
 * Post one depreciation period.
 *
 * F10a: the period is claimed with a conditional update (`status <> 'posted'`), so concurrent requests
 * cannot each post the journal; losers return the already-posted row, as a sequential repeat always did.
 *
 * F10b: the claim, the journal and the asset's totalValue update are ONE transaction. If the journal
 * cannot be posted, the whole post rolls back (the period stays unposted, the asset is untouched) and the
 * caller gets "journal_failed" to report, instead of the old behaviour of swallowing the failure and
 * leaving a period marked posted with no journal.
 *
 * F10c: periods may be posted in any order. The asset's totalValue always follows the book value of the
 * highest-numbered POSTED period, not of whichever period was posted last (the old behaviour left it at
 * the last-posted period, so posting period 5 and then period 3 showed period 3's higher book value). The
 * asset row is locked (FOR UPDATE) first, so two different periods posted concurrently cannot each compute
 * totalValue from a stale view of the other.
 */
export async function postDepreciationPeriod(userId: number, id: number, deps: PostDepreciationDeps = {}): Promise<PostDepreciationOutcome> {
  const postJournalStep = deps.postJournalInTx ?? postDepreciationJournalInTx;
  const [row] = await db.select().from(financeDepreciationTable)
    .where(and(eq(financeDepreciationTable.id, id), eq(financeDepreciationTable.userId, userId)));
  if (!row) return { status: "not_found" };
  if (row.status === "posted") return { status: "ok", row };

  const [asset] = await db.select().from(financeAssetsTable)
    .where(and(eq(financeAssetsTable.id, row.assetId), eq(financeAssetsTable.userId, userId)));
  if (!asset) return { status: "asset_not_found" };

  try {
    return await db.transaction(async (tx): Promise<PostDepreciationOutcome> => {
      await tx.select({ id: financeAssetsTable.id }).from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id)).for("update");
      const [updated] = await tx.update(financeDepreciationTable)
        .set({ status: "posted", postedAt: new Date() })
        .where(and(eq(financeDepreciationTable.id, id), ne(financeDepreciationTable.status, "posted")))
        .returning();
      if (!updated) {
        // Lost the claim to a concurrent request, which owns the journal post and the asset update.
        const [current] = await tx.select().from(financeDepreciationTable)
          .where(and(eq(financeDepreciationTable.id, id), eq(financeDepreciationTable.userId, userId)));
        return { status: "ok", row: current ?? row };
      }

      if (!(await postJournalStep(tx, userId, asset.name, row.periodDate, row.depreciationAmount))) {
        throw new DepreciationJournalFailed(); // rolls back the claim
      }
      // Keep the asset's headline totalValue in step with its book value as periods post: the book value of
      // the highest-numbered posted period (this one is already counted, the claim above is in this transaction).
      const [latest] = await tx.select({ bookValue: financeDepreciationTable.bookValue }).from(financeDepreciationTable)
        .where(and(eq(financeDepreciationTable.assetId, asset.id), eq(financeDepreciationTable.status, "posted")))
        .orderBy(desc(financeDepreciationTable.periodNo)).limit(1);
      await tx.update(financeAssetsTable).set({ totalValue: latest?.bookValue ?? row.bookValue, updatedAt: new Date() }).where(eq(financeAssetsTable.id, asset.id));

      return { status: "ok", row: updated };
    });
  } catch (err) {
    if (err instanceof DepreciationJournalFailed) return { status: "journal_failed" };
    throw err;
  }
}

// The installment payment stays owned by the ledger; re-exported so the route imports application/* only (FIN-WP-8).
export { payAmortizationInstallment } from "../ledger/repayments";
