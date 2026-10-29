import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeAmortizationTable,
  financeAssetOwnersTable,
  financeAssetsTable,
  financeBooksTable,
  financeDepreciationTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
} from "@workspace/db";
import { buildAmortizationRows } from "../domain/schedules";
import { generateAmortizationSchedule } from "../schedules/amortization";
import { generateDepreciationSchedule } from "../schedules/depreciation";
import {
  createAsset,
  deleteAsset,
  generateAmortization,
  generateDepreciation,
  listAmortization,
  listAssets,
  listDepreciation,
  postDepreciationPeriod,
  updateAsset,
} from "./assets";

// WP-4 characterization tests for assets, amortization and depreciation, moved out of routes/finance.ts,
// plus F9 (generate = one transaction), F10a (depreciation post claims the period) and F10b (claim + journal +
// asset update are one transaction). Isolated Finance test schema only (pnpm test:finance-db). NOT YET EXECUTED.

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
      const assets = await db.select({ id: financeAssetsTable.id }).from(financeAssetsTable).where(eq(financeAssetsTable.userId, userId));
      const assetIds = assets.map((a) => a.id);
      if (assetIds.length) await db.delete(financeAssetOwnersTable).where(inArray(financeAssetOwnersTable.assetId, assetIds));
      await db.delete(financeDepreciationTable).where(eq(financeDepreciationTable.userId, userId));
      await db.delete(financeAmortizationTable).where(eq(financeAmortizationTable.userId, userId));
      await db.delete(financeAssetsTable).where(eq(financeAssetsTable.userId, userId));
      const journals = await db.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.userId, userId));
      for (const j of journals) await db.delete(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, j.id));
      await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.userId, userId));
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      await db.delete(financeAccountsTable).where(eq(financeAccountsTable.userId, userId));
      await db.delete(financeBooksTable).where(eq(financeBooksTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

const journalCount = async (userId: number, memo: string) =>
  (await db.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.userId, userId), eq(financeJournalEntriesTable.memo, memo)))).length;

test("assets: create defaults the owner to 100% You; list filters by type and is user-scoped", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const { asset, owners } = await createAsset(owner, { assetType: "bank", name: "  Main  ", totalValue: "250.5" });
  assert.equal(asset.name, "Main");
  assert.equal(asset.totalValue, 250.5);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].ownerName, "You");
  assert.equal(owners[0].ownershipPercent, 100);
  await createAsset(owner, { assetType: "cash", name: "Wallet" });

  assert.equal((await listAssets(owner)).length, 2);
  assert.deepEqual((await listAssets(owner, "bank")).map((a) => a.asset.name), ["Main"]);
  assert.equal((await listAssets(other)).length, 0);
});

test("assets: update validates numbers, is user-scoped and replaces owners; delete checks ownership before touching owners", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "bank", name: "A", totalValue: 10 });

  assert.deepEqual(await updateAsset(owner, asset.id, { totalValue: null }), { status: "invalid", error: "totalValue cannot be null" });
  assert.deepEqual(await updateAsset(owner, asset.id, { interestRate: "abc" }), { status: "invalid", error: "interestRate must be a valid number" });
  assert.deepEqual(await updateAsset(other, asset.id, { name: "hijack" }), { status: "not_found" });

  const ok = await updateAsset(owner, asset.id, { name: "B", owners: [{ ownerName: "X", ownershipPercent: 40 }, { ownerName: "Y", ownershipPercent: 60 }] });
  assert.equal(ok.status === "ok" && ok.asset.name, "B");
  assert.equal(ok.status === "ok" && ok.owners.length, 2);

  assert.equal(await deleteAsset(other, asset.id), false);
  assert.equal((await db.select().from(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, asset.id))).length, 2, "another user's delete must not wipe owners");
  assert.equal(await deleteAsset(owner, asset.id), true);
  assert.equal((await db.select().from(financeAssetOwnersTable).where(eq(financeAssetOwnersTable.assetId, asset.id))).length, 0);
});

test("amortization: only borrowed/lending, user-scoped, regenerating replaces the schedule, rows equal the pure math", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const occurred = new Date("2024-01-31T00:00:00.000Z");
  const [loan] = await db.insert(financeLedgerEntriesTable).values({
    userId: owner, kind: "borrowed", title: "Loan", amount: 1200, currency: "BDT", category: "Loan",
    occurredDate: occurred, interestRate: 12, status: "pending",
  }).returning();
  const [expense] = await db.insert(financeLedgerEntriesTable).values({
    userId: owner, kind: "expense", title: "Lunch", amount: 5, currency: "BDT", category: "Food", occurredDate: occurred, status: "paid",
  }).returning();

  assert.deepEqual(await generateAmortization(owner, expense.id, 6), { status: "wrong_kind" });
  assert.deepEqual(await generateAmortization(other, loan.id, 6), { status: "not_found" });
  assert.equal(await listAmortization(other, loan.id), null);

  const first = await generateAmortization(owner, loan.id, 6);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.equal(first.rows.length, 6);
  const expected = buildAmortizationRows({ userId: owner, ledgerEntryId: loan.id, principal: 1200, annualRate: 12, termMonths: 6, startDate: occurred });
  // F11: schedule money columns are double precision now, so stored values must match the float64 math to ~1e-12 relative.
  const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
  first.rows.forEach((r, i) => {
    assert.equal(r.installmentNo, expected[i].installmentNo);
    assert.ok(near(r.principalDue, expected[i].principalDue), `principalDue #${i + 1}`);
    assert.ok(near(r.interestDue, expected[i].interestDue), `interestDue #${i + 1}`);
    assert.ok(near(r.remainingBalance, expected[i].remainingBalance), `remainingBalance #${i + 1}`);
  });

  const second = await generateAmortization(owner, loan.id, 3);
  assert.equal(second.status === "ok" && second.rows.length, 3);
  assert.equal((await listAmortization(owner, loan.id))?.length, 3, "old schedule fully replaced, no leftovers");
});

test("depreciation: generate stores the method on the asset, replaces the schedule, and is user-scoped", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Laptop", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });

  assert.equal(await generateDepreciation(other, asset.id, { method: "straight_line", months: 12 }), null);
  assert.equal(await listDepreciation(other, asset.id), null);

  const rows = await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 });
  assert.equal(rows?.length, 12);
  assert.ok(rows!.every((r) => Math.abs(r.depreciationAmount - 100) < 1e-3));
  const [stored] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));
  assert.equal(stored.depreciationMethod, "straight_line");
  assert.equal(stored.usefulLifeMonths, 12);

  const again = await generateDepreciation(owner, asset.id, { method: "declining_balance", months: 6, salvageValue: 100 });
  assert.equal(again?.length, 6);
  assert.equal((await listDepreciation(owner, asset.id))?.length, 6, "old schedule fully replaced");
});

test("depreciation post: marks posted, posts one journal, syncs the asset value, and is idempotent on repeat", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Press", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;
  const memo = "Depreciation — Press";

  assert.deepEqual(await postDepreciationPeriod(other, rows[0].id), { status: "not_found" });

  const first = await postDepreciationPeriod(owner, rows[0].id);
  assert.equal(first.status === "ok" && first.row.status, "posted");
  assert.equal(await journalCount(owner, memo), 1);
  const [after1] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));
  assert.ok(Math.abs(after1.totalValue - rows[0].bookValue) < 1e-3, "asset totalValue follows book value");

  const repeat = await postDepreciationPeriod(owner, rows[0].id);
  assert.equal(repeat.status === "ok" && repeat.row.status, "posted");
  assert.equal(await journalCount(owner, memo), 1, "a repeat must not post a second journal");
});

test("F10c: posting periods out of order leaves totalValue at the highest posted period's book value", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Order", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;
  const totalValue = async () => (await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id)))[0].totalValue;
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));

  assert.equal((await postDepreciationPeriod(owner, rows[4].id)).status, "ok");
  assert.ok(close(await totalValue(), rows[4].bookValue), "after period 5");
  assert.equal((await postDepreciationPeriod(owner, rows[2].id)).status, "ok");
  assert.ok(close(await totalValue(), rows[4].bookValue), "posting period 3 after 5 must NOT raise totalValue back to period 3's book value");
  assert.equal((await postDepreciationPeriod(owner, rows[7].id)).status, "ok");
  assert.ok(close(await totalValue(), rows[7].bookValue), "a later period moves it forward");
  assert.equal(await journalCount(owner, "Depreciation — Order"), 3, "each period still posts exactly one journal");
});

test("F10c: concurrent posts of different periods end at the highest period's book value", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Mix", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;
  const picks = [rows[1], rows[9], rows[4], rows[6]];
  const results = await Promise.all(picks.map((r) => postDepreciationPeriod(owner, r.id)));
  assert.ok(results.every((r) => r.status === "ok"));
  const [a] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));
  assert.ok(Math.abs(a.totalValue - rows[9].bookValue) < 1e-9 * Math.max(1, Math.abs(rows[9].bookValue)), `totalValue ${a.totalValue} should be period 10's ${rows[9].bookValue}`);
});

test("F10a: concurrent posts of the same depreciation period produce exactly one journal", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Race", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;

  const results = await Promise.all([1, 2, 3, 4].map(() => postDepreciationPeriod(owner, rows[0].id)));
  assert.ok(results.every((r) => r.status === "ok" && r.row.status === "posted"), "every caller sees the posted period");
  assert.equal(await journalCount(owner, "Depreciation — Race"), 1);
});

// ─── F9 rollback proof ───────────────────────────────────────────────────────
// An invalid start date makes the INSERT throw (RangeError while serialising the timestamp) AFTER the
// old schedule was deleted inside the same transaction. If delete and insert were separate statements the
// old schedule would be gone; in one transaction it must survive.

test("F9: a failing amortization regenerate rolls back and keeps the previous schedule", async () => {
  const owner = nextTestUserId();
  const [loan] = await db.insert(financeLedgerEntriesTable).values({
    userId: owner, kind: "borrowed", title: "Loan", amount: 600, currency: "BDT", category: "Loan",
    occurredDate: new Date("2024-01-31T00:00:00.000Z"), interestRate: 10, status: "pending",
  }).returning();
  const ok = await generateAmortization(owner, loan.id, 4);
  assert.equal(ok.status, "ok");
  const before = await db.select().from(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, loan.id));
  assert.equal(before.length, 4);

  await assert.rejects(generateAmortizationSchedule({ ...loan, occurredDate: new Date("not a date") }, 6));

  const after = await db.select().from(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, loan.id));
  assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort(), "the original rows are untouched");
});

test("F9: a failing depreciation regenerate rolls back and keeps the previous schedule", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Rig", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  assert.equal((await generateDepreciation(owner, asset.id, { method: "straight_line", months: 5, salvageValue: 0 }))?.length, 5);
  const before = await db.select().from(financeDepreciationTable).where(eq(financeDepreciationTable.assetId, asset.id));
  const [fresh] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));

  await assert.rejects(generateDepreciationSchedule({ ...fresh, depreciationStartDate: new Date("not a date") }));

  const after = await db.select().from(financeDepreciationTable).where(eq(financeDepreciationTable.assetId, asset.id));
  assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort(), "the original rows are untouched");
});

// ─── F10b: atomic depreciation post ──────────────────────────────────────────

test("F10b: when the journal cannot be posted, nothing is committed (period unposted, asset untouched), and a retry succeeds", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Atomic", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;
  const [assetBefore] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));

  const failed = await postDepreciationPeriod(owner, rows[0].id, { postJournalInTx: async () => false });
  assert.deepEqual(failed, { status: "journal_failed" });

  const [period] = await db.select().from(financeDepreciationTable).where(eq(financeDepreciationTable.id, rows[0].id));
  assert.notEqual(period.status, "posted", "the claim was rolled back");
  assert.equal(period.postedAt, null);
  const [assetAfter] = await db.select().from(financeAssetsTable).where(eq(financeAssetsTable.id, asset.id));
  assert.equal(assetAfter.totalValue, assetBefore.totalValue, "asset value untouched");
  assert.equal(await journalCount(owner, "Depreciation — Atomic"), 0);

  const retry = await postDepreciationPeriod(owner, rows[0].id);
  assert.equal(retry.status === "ok" && retry.row.status, "posted");
  assert.equal(await journalCount(owner, "Depreciation — Atomic"), 1);
});

test("F10b: a thrown error in the journal step also rolls the whole post back", async () => {
  const owner = nextTestUserId();
  const { asset } = await createAsset(owner, { assetType: "fixed", name: "Boom", totalValue: 1200, purchasedValue: 1200, purchaseDate: "2024-01-15T00:00:00.000Z" });
  const rows = (await generateDepreciation(owner, asset.id, { method: "straight_line", months: 12, salvageValue: 0 }))!;
  await assert.rejects(postDepreciationPeriod(owner, rows[0].id, { postJournalInTx: async () => { throw new Error("db down"); } }), /db down/);
  const [period] = await db.select().from(financeDepreciationTable).where(eq(financeDepreciationTable.id, rows[0].id));
  assert.notEqual(period.status, "posted");
});
