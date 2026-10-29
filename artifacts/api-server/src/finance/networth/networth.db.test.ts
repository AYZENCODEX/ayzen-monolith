import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAssetsTable,
  financeAssetOwnersTable,
  financeCurrencyRatesTable,
  financeLedgerEntriesTable,
} from "@workspace/db";
import { computeNetWorthBreakdown } from "./networth";

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
      await db.delete(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, assetId));
    }
    for (const userId of userIds) {
      await db.delete(financeAssetsTable).where(eq(financeAssetsTable.userId, userId));
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      await db.delete(financeCurrencyRatesTable).where(eq(financeCurrencyRatesTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("net worth converts currencies and counts only the user's asset share", async () => {
  const userId = nextTestUserId();
  await db.insert(financeCurrencyRatesTable).values({
    userId,
    currency: "USD",
    rateToBase: 120,
  });

  await db.insert(financeLedgerEntriesTable).values([
    { userId, kind: "receivable", title: "USD receivable", amount: 25, currency: "USD", status: "pending" },
    { userId, kind: "payable", title: "Payable", amount: 10, currency: "BDT", status: "pending" },
    { userId, kind: "borrowed", title: "Borrowed", amount: 5, currency: "BDT", status: "pending" },
    { userId, kind: "lending", title: "Lending", amount: 4, currency: "BDT", status: "pending" },
    { userId, kind: "investment", title: "Investment", amount: 6, currency: "BDT", status: "pending" },
  ]);

  const [asset] = await db.insert(financeAssetsTable).values({
    userId,
    assetType: "other",
    name: "Shared asset",
    totalValue: 100,
  }).returning({ id: financeAssetsTable.id });
  assetIds.add(asset.id);
  await db.insert(financeAssetOwnersTable).values({
    assetId: asset.id,
    ownerName: "Test owner",
    partyId: null,
    ownershipPercent: 25,
  });

  const breakdown = await computeNetWorthBreakdown(userId);
  assert.deepEqual(breakdown, {
    netWorth: 3020,
    totalAssets: 25,
    totalReceivable: 3000,
    totalPayable: 10,
    totalBorrowed: 5,
    totalLending: 4,
    totalInvested: 6,
  });
});
