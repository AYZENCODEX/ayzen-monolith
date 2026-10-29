import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeBooksTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeRecurringRulesTable,
} from "@workspace/db";
import { postJournal } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";
import { createRecurringRule, deleteRecurringRule, listRecurringRules, updateRecurringRule } from "./recurring";
import { createManualJournal, deleteManualJournal, getJournalEntry, listJournal } from "./journal";

// WP-5a characterization tests for recurring-rule CRUD and manual journal use cases, moved out of
// routes/finance.ts, plus F13 (manual journal delete is one transaction). Isolated Finance test schema
// only (pnpm test:finance-db). NOT YET EXECUTED. Not covered: the recurring sweep itself and run-now
// (they load the legacy invoice module); the sweep's due-rule selection is covered by jobs/due-rules.db.test.ts.

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
      const journals = await db.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
        .where(eq(financeJournalEntriesTable.userId, userId));
      for (const j of journals) await db.delete(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, j.id));
      await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.userId, userId));
      await db.delete(financeRecurringRulesTable).where(eq(financeRecurringRulesTable.userId, userId));
      await db.delete(financeAccountsTable).where(eq(financeAccountsTable.userId, userId));
      await db.delete(financeBooksTable).where(eq(financeBooksTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

// ─── Recurring rules ─────────────────────────────────────────────────────────

test("createRecurringRule applies the route defaults and stores the rule for the caller", async () => {
  const userId = nextTestUserId();
  const rule = await createRecurringRule(userId, { kind: "expense", title: "  Rent  ", amount: "1200.5" });
  assert.equal(rule.userId, userId);
  assert.equal(rule.title, "Rent", "title is trimmed");
  assert.equal(rule.amount, 1200.5);
  assert.equal(rule.currency, "BDT");
  assert.equal(rule.frequency, "monthly");
  assert.equal(rule.intervalCount, 1);
  assert.equal(rule.active, 1);
  assert.equal(rule.endDate, null);
  assert.equal(rule.nextRunDate.getTime(), rule.startDate.getTime(), "nextRunDate defaults to startDate");
});

test("createRecurringRule honours explicit fields and active: false", async () => {
  const userId = nextTestUserId();
  const rule = await createRecurringRule(userId, {
    kind: "income", title: "Retainer", amount: 50, currency: "USD", frequency: "weekly", intervalCount: 2,
    startDate: "2030-01-01T00:00:00.000Z", nextRunDate: "2030-02-01T00:00:00.000Z", endDate: "2031-01-01T00:00:00.000Z",
    active: false, notes: "n",
  });
  assert.equal(rule.currency, "USD");
  assert.equal(rule.frequency, "weekly");
  assert.equal(rule.intervalCount, 2);
  assert.equal(rule.active, 0);
  assert.equal(rule.nextRunDate.toISOString(), "2030-02-01T00:00:00.000Z");
  assert.equal(rule.endDate?.toISOString(), "2031-01-01T00:00:00.000Z");
  assert.equal(rule.notes, "n");
});

test("listRecurringRules returns only the caller's rules ordered by nextRunDate", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const late = await createRecurringRule(userA, { kind: "expense", title: "late", amount: 1, nextRunDate: "2031-01-01T00:00:00.000Z" });
  const early = await createRecurringRule(userA, { kind: "expense", title: "early", amount: 1, nextRunDate: "2029-01-01T00:00:00.000Z" });
  const other = await createRecurringRule(userB, { kind: "expense", title: "other", amount: 1 });
  const rows = await listRecurringRules(userA);
  assert.deepEqual(rows.map((r) => r.id), [early.id, late.id]);
  assert.ok(!rows.some((r) => r.id === other.id));
});

test("updateRecurringRule changes only the given fields and is scoped to the owner", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const rule = await createRecurringRule(userA, { kind: "expense", title: "Gym", amount: 30, notes: "keep" });

  const updated = await updateRecurringRule(userA, rule.id, { title: "Gym 2", active: false, endDate: "2032-01-01T00:00:00.000Z" });
  assert.ok(updated);
  assert.equal(updated.title, "Gym 2");
  assert.equal(updated.amount, 30, "untouched field kept");
  assert.equal(updated.notes, "keep");
  assert.equal(updated.active, 0);
  assert.equal(updated.endDate?.toISOString(), "2032-01-01T00:00:00.000Z");

  const cleared = await updateRecurringRule(userA, rule.id, { endDate: null, active: true });
  assert.equal(cleared?.endDate, null);
  assert.equal(cleared?.active, 1);

  assert.equal(await updateRecurringRule(userB, rule.id, { title: "hijack" }), undefined, "another user's rule is not updated");
  const [stored] = await db.select().from(financeRecurringRulesTable).where(eq(financeRecurringRulesTable.id, rule.id));
  assert.equal(stored.title, "Gym 2");
});

test("deleteRecurringRule removes the caller's rule and silently ignores a foreign or missing id", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const rule = await createRecurringRule(userA, { kind: "expense", title: "Del", amount: 5 });

  await deleteRecurringRule(userB, rule.id);
  assert.equal((await listRecurringRules(userA)).length, 1, "another user cannot delete the rule");
  await deleteRecurringRule(userA, rule.id);
  assert.equal((await listRecurringRules(userA)).length, 0);
  await deleteRecurringRule(userA, rule.id); // second delete: no throw
});

// ─── Manual journal ──────────────────────────────────────────────────────────

async function accountIdByCode(userId: number, bookId: number, code: string): Promise<number> {
  const rows = await db.select().from(financeAccountsTable).where(eq(financeAccountsTable.userId, userId));
  const row = rows.find((a) => a.bookId === bookId && a.code === code);
  assert.ok(row, `account ${code} missing`);
  return row.id;
}

async function twoAccounts(userId: number) {
  const bookId = await resolveBookId(userId);
  // Seeded system accounts exist after resolveBookId + a posting; post once to seed the chart.
  await postJournal(userId, { memo: "seed", date: new Date(), lines: [{ accountCode: "1000", debit: 1, credit: 0 }, { accountCode: "3000", debit: 0, credit: 1 }], bookId });
  return { bookId, a: await accountIdByCode(userId, bookId, "1000"), b: await accountIdByCode(userId, bookId, "3000") };
}

test("createManualJournal posts a balanced manual entry with its lines", async () => {
  const userId = nextTestUserId();
  const { bookId, a, b } = await twoAccounts(userId);
  const result = await createManualJournal(userId, { memo: "  Adjust  ", lines: [{ accountId: a, debit: 40, credit: 0 }, { accountId: b, debit: 0, credit: 40 }], bookId });
  assert.ok(result.ok);
  assert.equal(result.entry.memo, "Adjust");
  assert.equal(result.entry.isManual, 1);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines.reduce((s, l) => s + l.debit, 0), result.lines.reduce((s, l) => s + l.credit, 0));
});

test("createManualJournal rejects unbalanced lines, too few valid lines and foreign accounts with the route's messages", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const { bookId, a, b } = await twoAccounts(userA);
  const other = await twoAccounts(userB);

  const unbalanced = await createManualJournal(userA, { memo: "x", lines: [{ accountId: a, debit: 10, credit: 0 }, { accountId: b, debit: 0, credit: 5 }], bookId });
  assert.deepEqual(unbalanced, { ok: false, error: "Debit and credit must balance" });

  const zero = await createManualJournal(userA, { memo: "x", lines: [{ accountId: a, debit: 0, credit: 0 }, { accountId: b, debit: 0, credit: 0 }], bookId });
  assert.deepEqual(zero, { ok: false, error: "At least 2 valid lines are required" });

  const foreign = await createManualJournal(userA, { memo: "x", lines: [{ accountId: a, debit: 10, credit: 0 }, { accountId: other.b, debit: 0, credit: 10 }], bookId });
  assert.deepEqual(foreign, { ok: false, error: "At least 2 valid lines are required" }, "another user's account is dropped, not used");
});

test("listJournal and getJournalEntry are scoped to the caller; listJournal filters by account", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const { bookId, a, b } = await twoAccounts(userA);
  await twoAccounts(userB);
  const created = await createManualJournal(userA, { memo: "only a-b", lines: [{ accountId: a, debit: 7, credit: 0 }, { accountId: b, debit: 0, credit: 7 }], bookId });
  assert.ok(created.ok);

  const all = await listJournal(userA, { bookId });
  assert.ok(all.some((r) => r.entry.id === created.entry.id));
  assert.ok(all.every((r) => r.entry.userId === userA));
  assert.ok(all.every((r) => r.lines.every((l) => l.journalEntryId === r.entry.id)));

  const filtered = await listJournal(userA, { bookId, accountId: a });
  assert.ok(filtered.every((r) => r.lines.some((l) => l.accountId === a)));
  assert.ok(filtered.some((r) => r.entry.id === created.entry.id));
  assert.equal((await listJournal(userA, { bookId, accountId: -1 })).length, 0);
  assert.equal((await listJournal(userA, { bookId, accountId: Number.NaN })).length, 0, "a non-numeric accountId filter matches nothing, as before");

  assert.ok(await getJournalEntry(userA, created.entry.id));
  assert.equal(await getJournalEntry(userB, created.entry.id), undefined);
});

test("deleteManualJournal removes header and lines for manual entries only, scoped to the owner (F13)", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const { bookId, a, b } = await twoAccounts(userA);
  const manual = await createManualJournal(userA, { memo: "m", lines: [{ accountId: a, debit: 3, credit: 0 }, { accountId: b, debit: 0, credit: 3 }], bookId });
  assert.ok(manual.ok);

  assert.equal(await deleteManualJournal(userB, manual.entry.id), "not_found", "another user cannot delete it");
  assert.ok(await getJournalEntry(userA, manual.entry.id));

  const system = (await listJournal(userA, { bookId })).find((r) => !r.entry.isManual);
  assert.ok(system, "seed posting is a non-manual entry");
  assert.equal(await deleteManualJournal(userA, system.entry.id), "not_manual");
  assert.ok(await getJournalEntry(userA, system.entry.id), "system entry untouched");

  assert.equal(await deleteManualJournal(userA, manual.entry.id), "deleted");
  assert.equal(await getJournalEntry(userA, manual.entry.id), undefined);
  const orphan = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, manual.entry.id));
  assert.equal(orphan.length, 0, "no orphan lines");
  assert.equal(await deleteManualJournal(userA, manual.entry.id), "not_found", "second delete");
});

test("concurrent deletes of one manual journal: exactly one wins, no orphan lines (F13)", async () => {
  const userId = nextTestUserId();
  const { bookId, a, b } = await twoAccounts(userId);
  const manual = await createManualJournal(userId, { memo: "race", lines: [{ accountId: a, debit: 9, credit: 0 }, { accountId: b, debit: 0, credit: 9 }], bookId });
  assert.ok(manual.ok);
  const outcomes = await Promise.all([1, 2, 3, 4].map(() => deleteManualJournal(userId, manual.entry.id)));
  assert.equal(outcomes.filter((o) => o === "deleted").length, 1);
  assert.equal(outcomes.filter((o) => o === "not_found").length, 3);
  const lines = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, manual.entry.id));
  assert.equal(lines.length, 0);
});
