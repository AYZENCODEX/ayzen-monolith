import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeAmortizationTable,
  financeBooksTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
} from "@workspace/db";
import { applyPrincipalRepayment, payAmortizationInstallment, recordRepayment } from "./ledger/repayments";
import { computeAccountBalances } from "./ledger/balances";
import {
  deleteJournalForEntry,
  deleteLedgerEntryCascade,
  postEntryAdjustmentJournal,
  postEntryJournal,
  postJournal,
  postRepaymentJournal,
} from "./ledger/journal";
import { ensureSystemAccounts } from "./ledger/system-accounts";
import { resolveBookId } from "./ledger/books";

// WP-1 (FIN-03) ledger safety gate. Runs only inside the isolated, Finance-only test
// schema created by src/lib/finance-accounting.db-runner.mjs (pnpm test:finance-db).
// Tests marked KNOWN GAP (none at present) characterize behavior that looks wrong today; they
// pass while the gap exists and fail when it is fixed, so the fix must flip them deliberately.
// (F2 unknown account codes, F3 second-book accounts and F4 repayment atomicity/idempotency were
// fixed and are ordinary regression tests now; no KNOWN GAP tests remain.)


if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();
const nextTestUserId = (): number => {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
};

async function newReceivable(userId: number, amount = 100) {
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId,
    kind: "receivable",
    title: `WP-1 receivable ${randomInt(1, 1_000_000)}`,
    amount,
    currency: "BDT",
    status: "pending",
  }).returning();
  return entry;
}

const journalsFor = (userId: number) =>
  db.select().from(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.userId, userId));

async function linesForJournals(journalIds: number[]) {
  if (journalIds.length === 0) return [];
  return db.select().from(financeJournalLinesTable)
    .where(inArray(financeJournalLinesTable.journalEntryId, journalIds));
}

after(async () => {
  try {
    for (const userId of testUserIds) {
      const journals = await journalsFor(userId);
      const journalIds = journals.map((journal) => journal.id);
      if (journalIds.length > 0) {
        await db.delete(financeJournalLinesTable)
          .where(inArray(financeJournalLinesTable.journalEntryId, journalIds));
      }
      await db.delete(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.userId, userId));

      const entries = await db.select({ id: financeLedgerEntriesTable.id })
        .from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      const entryIds = entries.map((entry) => entry.id);
      if (entryIds.length > 0) {
        await db.delete(financeRepaymentsTable).where(inArray(financeRepaymentsTable.entryId, entryIds));
      }
      await db.delete(financeAmortizationTable).where(eq(financeAmortizationTable.userId, userId));
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      await db.delete(financeAccountsTable).where(eq(financeAccountsTable.userId, userId));
      await db.delete(financeBooksTable).where(eq(financeBooksTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

// ─── Cross-user isolation ────────────────────────────────────────────────────

test("a user cannot resolve or post into another user's book; the request falls back to their own", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const ownerBookId = await resolveBookId(owner);

  const resolvedForOther = await resolveBookId(other, ownerBookId);
  assert.notEqual(resolvedForOther, ownerBookId);

  const journal = await postJournal(other, {
    memo: "WP-1 foreign book id",
    lines: [
      { accountCode: "1000", debit: 10, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 10 },
    ],
    bookId: ownerBookId,
    isManual: true,
  });
  assert.ok(journal);
  assert.equal(journal.bookId, resolvedForOther);
  assert.notEqual(journal.bookId, ownerBookId);
  assert.equal((await journalsFor(owner)).length, 0);
});

test("account balances are computed per user and each user's postings balance", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const lines = (amount: number) => [
    { accountCode: "1100", debit: amount, credit: 0 },
    { accountCode: "4000", debit: 0, credit: amount },
  ];
  assert.ok(await postJournal(userA, { memo: "WP-1 A", lines: lines(100), isManual: true }));
  assert.ok(await postJournal(userB, { memo: "WP-1 B", lines: lines(40), isManual: true }));

  for (const [userId, amount] of [[userA, 100], [userB, 40]] as const) {
    const rows = await computeAccountBalances(userId);
    const byCode = new Map(rows.map((row) => [row.code, row]));
    assert.equal(byCode.get("1100")?.balance, amount);
    assert.equal(byCode.get("4000")?.balance, amount);
    assert.equal(rows.reduce((sum, row) => sum + row.totalDebit, 0), amount);
    assert.equal(rows.reduce((sum, row) => sum + row.totalCredit, 0), amount);
  }
});

// ─── Posting guards ──────────────────────────────────────────────────────────

test("unbalanced, single-line and all-zero journals are rejected without writing anything", async () => {
  const userId = nextTestUserId();
  const attempts = [
    [{ accountCode: "1100", debit: 100, credit: 0 }, { accountCode: "4000", debit: 0, credit: 90 }],
    [{ accountCode: "1100", debit: 100, credit: 0 }],
    [{ accountCode: "1100", debit: 0, credit: 0 }, { accountCode: "4000", debit: 0, credit: 0 }],
  ];
  for (const lines of attempts) {
    assert.equal(await postJournal(userId, { memo: "WP-1 rejected", lines, isManual: true }), null);
  }
  assert.equal((await journalsFor(userId)).length, 0);
});

test("a journal naming an unknown account code is rejected and nothing is written (F2)", async () => {
  const userId = nextTestUserId();
  const journal = await postJournal(userId, {
    memo: "WP-1 unknown account",
    lines: [
      { accountCode: "1100", debit: 50, credit: 0 },
      { accountCode: "9999", debit: 0, credit: 50 },
    ],
    isManual: true,
  });
  assert.equal(journal, null);
  const journals = await journalsFor(userId);
  assert.equal(journals.length, 0);
  assert.equal((await linesForJournals(journals.map((j) => j.id))).length, 0);
});

test("a journal may use a user-defined account that exists in the book", async () => {
  const userId = nextTestUserId();
  const accounts = await ensureSystemAccounts(userId);
  const anyAccount = accounts.get("1000");
  assert.ok(anyAccount);
  await db.insert(financeAccountsTable).values({
    userId,
    bookId: anyAccount.bookId,
    code: "6000",
    name: "WP-1 custom expense",
    type: "expense",
    normalBalance: "debit",
    isSystem: 0,
  });
  const journal = await postJournal(userId, {
    memo: "WP-1 custom account",
    lines: [
      { accountCode: "6000", debit: 25, credit: 0 },
      { accountCode: "1000", debit: 0, credit: 25 },
    ],
    isManual: true,
  });
  assert.ok(journal);
  const stored = await linesForJournals([journal.id]);
  assert.equal(stored.length, 2);
  assert.equal(stored.reduce((sum, line) => sum + Number(line.debit), 0), 25);
  assert.equal(stored.reduce((sum, line) => sum + Number(line.credit), 0), 25);
});

test("each book gets its own seeded chart of accounts; codes stay unique within a book (F3)", async () => {
  const userId = nextTestUserId();
  const firstBookId = await resolveBookId(userId);
  const first = await ensureSystemAccounts(userId, firstBookId);
  const [secondBook] = await db.insert(financeBooksTable).values({
    userId,
    name: "WP-1 second book",
    bookType: "personal",
    isDefault: 0,
  }).returning();
  assert.ok(secondBook);

  // Used to violate UNIQUE(user_id, code): the same codes already existed for the first book.
  const second = await ensureSystemAccounts(userId, secondBook.id);
  assert.equal(second.size, first.size);
  for (const [code, account] of second) {
    assert.equal(account.bookId, secondBook.id);
    assert.notEqual(account.id, first.get(code)?.id);
  }

  const journal = await postJournal(userId, {
    memo: "WP-1 second book posting",
    lines: [
      { accountCode: "1100", debit: 30, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 30 },
    ],
    isManual: true,
    bookId: secondBook.id,
  });
  assert.ok(journal);
  assert.equal(journal.bookId, secondBook.id);

  const secondRows = await computeAccountBalances(userId, { bookId: secondBook.id });
  assert.equal(secondRows.find((row) => row.code === "1100")?.balance, 30);
  const firstRows = await computeAccountBalances(userId, { bookId: firstBookId });
  assert.equal(firstRows.reduce((sum, row) => sum + row.totalDebit + row.totalCredit, 0), 0);

  await assert.rejects(
    db.insert(financeAccountsTable).values({
      userId,
      bookId: secondBook.id,
      code: "1000",
      name: "WP-1 duplicate code in the same book",
      type: "asset",
      normalBalance: "debit",
      isSystem: 0,
    }),
    undefined,
    "the same code must still be unique within one book",
  );
});

// ─── Repayments: duplicates, clamping, concurrency ───────────────────────────

test("principal repayment has no duplicate-request protection: a repeated identical call decrements again", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  assert.equal(await applyPrincipalRepayment(entry.id, 30), 70);
  assert.equal(await applyPrincipalRepayment(entry.id, 30), 40);
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id));
  assert.equal(Number(row.amount), 40);
  assert.equal(row.status, "partial");
  // Any idempotency guarantee (request key, unique repayment reference) must be added
  // above this function; see docs/antas/finance/finance-remaining-scope.md WP-3.
});

test("over-repayment clamps the remaining amount at zero and marks the entry paid", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  assert.equal(await applyPrincipalRepayment(entry.id, 150), 0);
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id));
  assert.equal(Number(row.amount), 0);
  assert.equal(row.status, "paid");
});

test("concurrent over-repayment never drives the amount negative", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  const remaining = await Promise.all([
    applyPrincipalRepayment(entry.id, 60),
    applyPrincipalRepayment(entry.id, 60),
  ]);
  assert.deepEqual(remaining.sort((a, b) => (a ?? -1) - (b ?? -1)), [0, 40]);
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id));
  assert.equal(Number(row.amount), 0);
  // Status is asserted in the dedicated F4 test below (amount and status are one statement now).
});

test("repaying a non-existent entry reports null (not 0) and writes nothing", async () => {
  const missingId = 2_100_000_000;
  assert.equal(await applyPrincipalRepayment(missingId, 10), null);
  const rows = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, missingId));
  assert.equal(rows.length, 0);
});

test("amount and status change together: concurrent over-repayment ends paid with amount 0 (F4)", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  await Promise.all([applyPrincipalRepayment(entry.id, 60), applyPrincipalRepayment(entry.id, 60)]);
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id));
  assert.equal(Number(row.amount), 0);
  assert.equal(row.status, "paid");
});

const repaymentRows = (entryId: number) =>
  db.select().from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, entryId));
const entryRow = async (entryId: number) => {
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entryId));
  return row;
};

test("recordRepayment applies a principal repayment atomically with its repayment row", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  const result = await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false });
  assert.equal(result.status, "created");
  assert.ok(result.status === "created" && result.remainingAmount === 70);
  assert.equal((await repaymentRows(entry.id)).length, 1);
  const row = await entryRow(entry.id);
  assert.equal(Number(row.amount), 70);
  assert.equal(row.status, "partial");
});

test("recordRepayment records interest without touching the principal amount", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  const result = await recordRepayment({ entryId: entry.id, amount: 5, isInterest: true });
  assert.equal(result.status, "created");
  const row = await entryRow(entry.id);
  assert.equal(Number(row.amount), 100);
  assert.equal(Number(row.interestPaid), 5);
});

test("a repeated request with the same idempotency key is replayed, not applied twice (F4)", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  const first = await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false, idempotencyKey: "wp1-key-a" });
  const second = await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false, idempotencyKey: "wp1-key-a" });
  assert.equal(first.status, "created");
  assert.equal(second.status, "replayed");
  assert.ok(first.status === "created" && second.status === "replayed" && first.repayment.id === second.repayment.id);
  assert.equal((await repaymentRows(entry.id)).length, 1);
  assert.equal(Number((await entryRow(entry.id)).amount), 70);
});

test("reusing an idempotency key with a different amount or type is a conflict and changes nothing", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  assert.equal((await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false, idempotencyKey: "wp1-key-b" })).status, "created");
  assert.equal((await recordRepayment({ entryId: entry.id, amount: 31, isInterest: false, idempotencyKey: "wp1-key-b" })).status, "conflict");
  assert.equal((await recordRepayment({ entryId: entry.id, amount: 30, isInterest: true, idempotencyKey: "wp1-key-b" })).status, "conflict");
  assert.equal((await repaymentRows(entry.id)).length, 1);
  assert.equal(Number((await entryRow(entry.id)).amount), 70);
});

test("the same idempotency key may be used on different entries", async () => {
  const userId = nextTestUserId();
  const one = await newReceivable(userId, 100);
  const two = await newReceivable(userId, 100);
  assert.equal((await recordRepayment({ entryId: one.id, amount: 10, isInterest: false, idempotencyKey: "wp1-key-c" })).status, "created");
  assert.equal((await recordRepayment({ entryId: two.id, amount: 10, isInterest: false, idempotencyKey: "wp1-key-c" })).status, "created");
});

test("without an idempotency key a repeated request is applied again (opt-in protection)", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false });
  await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false });
  assert.equal((await repaymentRows(entry.id)).length, 2);
  assert.equal(Number((await entryRow(entry.id)).amount), 40);
});

test("two concurrent requests with the same idempotency key apply exactly once", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  const results = await Promise.all([
    recordRepayment({ entryId: entry.id, amount: 30, isInterest: false, idempotencyKey: "wp1-key-d" }),
    recordRepayment({ entryId: entry.id, amount: 30, isInterest: false, idempotencyKey: "wp1-key-d" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["created", "replayed"]);
  assert.equal((await repaymentRows(entry.id)).length, 1);
  assert.equal(Number((await entryRow(entry.id)).amount), 70);
});

test("recordRepayment on a missing entry writes no repayment row", async () => {
  const missingId = 2_100_000_001;
  assert.equal((await recordRepayment({ entryId: missingId, amount: 10, isInterest: false })).status, "entry_not_found");
  assert.equal((await recordRepayment({ entryId: missingId, amount: 10, isInterest: true })).status, "entry_not_found");
  assert.equal((await repaymentRows(missingId)).length, 0);
});

test("a failed balance update rolls back the repayment row (F4 atomicity)", async () => {
  const entry = await newReceivable(nextTestUserId(), 100);
  const constraintName = `finance_test_reject_amount_${entry.id}_${randomInt(1, 1_000_000)}`;
  await pool.query(
    `ALTER TABLE finance_ledger_entries ADD CONSTRAINT ${constraintName} CHECK (id <> ${entry.id} OR amount <> 70)`,
  );
  try {
    await assert.rejects(recordRepayment({ entryId: entry.id, amount: 30, isInterest: false }));
    assert.equal((await repaymentRows(entry.id)).length, 0, "repayment row must not survive a failed decrement");
    assert.equal(Number((await entryRow(entry.id)).amount), 100);
  } finally {
    await pool.query(`ALTER TABLE finance_ledger_entries DROP CONSTRAINT IF EXISTS ${constraintName}`);
  }
});

// ─── Entry-sourced journals ──────────────────────────────────────────────────

test("deleteJournalForEntry removes only that entry's journals and lines", async () => {
  const userId = nextTestUserId();
  const first = await newReceivable(userId, 100);
  const second = await newReceivable(userId, 200);
  await postEntryJournal(first);
  await postRepaymentJournal(first, 30, false);
  await postEntryJournal(second);

  const before = await journalsFor(userId);
  assert.equal(before.filter((j) => j.sourceLedgerEntryId === first.id).length, 2);
  assert.equal(before.filter((j) => j.sourceLedgerEntryId === second.id).length, 1);

  await deleteJournalForEntry(first.id);

  const after = await journalsFor(userId);
  assert.equal(after.filter((j) => j.sourceLedgerEntryId === first.id).length, 0);
  const remaining = after.filter((j) => j.sourceLedgerEntryId === second.id);
  assert.equal(remaining.length, 1);
  const remainingLines = await linesForJournals(remaining.map((j) => j.id));
  assert.equal(remainingLines.length, 2);
  const stray = await linesForJournals(before.filter((j) => j.sourceLedgerEntryId === first.id).map((j) => j.id));
  assert.equal(stray.length, 0, "deleted journals must not leave orphan lines");
});

test("amount adjustments post balanced delta journals that net out", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  await postEntryJournal(entry);
  await postEntryAdjustmentJournal(entry, 20);
  await postEntryAdjustmentJournal(entry, -20);

  const rows = await computeAccountBalances(userId);
  const byCode = new Map(rows.map((row) => [row.code, row]));
  assert.equal(byCode.get("1100")?.balance, 100);
  assert.equal(byCode.get("4000")?.balance, 100);
  assert.equal(
    rows.reduce((sum, row) => sum + row.totalDebit, 0),
    rows.reduce((sum, row) => sum + row.totalCredit, 0),
  );
});

// ─── Atomic deletes (F5) ─────────────────────────────────────────────────────

// Makes deleting journal headers sourced from `entryId` fail, so we can prove that work done
// earlier in the same operation (lines, repayments, ...) is rolled back with it.
async function withJournalDeleteBlocked<T>(entryId: number, run: () => Promise<T>): Promise<T> {
  const suffix = `${entryId}_${randomInt(1, 1_000_000)}`;
  const fn = `wp1_block_journal_delete_${suffix}`;
  await pool.query(`
    CREATE FUNCTION ${fn}() RETURNS trigger AS $body$
    BEGIN
      IF OLD.source_ledger_entry_id = ${entryId} THEN RAISE EXCEPTION 'wp1 journal delete blocked'; END IF;
      RETURN OLD;
    END $body$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON finance_journal_entries FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    return await run();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${fn} ON finance_journal_entries`);
    await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
}

test("deleteJournalForEntry is atomic: a failure deleting headers restores the lines it already deleted", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  await postEntryJournal(entry);
  await postRepaymentJournal(entry, 30, false);
  const journals = await journalsFor(userId);
  assert.equal(journals.length, 2);
  const linesBefore = (await linesForJournals(journals.map((j) => j.id))).length;
  assert.equal(linesBefore, 4);

  await withJournalDeleteBlocked(entry.id, async () => {
    await assert.rejects(deleteJournalForEntry(entry.id));
  });

  assert.equal((await journalsFor(userId)).length, 2);
  assert.equal((await linesForJournals(journals.map((j) => j.id))).length, linesBefore);
});

test("deleteLedgerEntryCascade removes the entry with its repayments and journals, and nothing else", async () => {
  const userId = nextTestUserId();
  const target = await newReceivable(userId, 100);
  const other = await newReceivable(userId, 200);
  await postEntryJournal(target);
  await postEntryJournal(other);
  assert.equal((await recordRepayment({ entryId: target.id, amount: 30, isInterest: false })).status, "created");
  assert.equal((await recordRepayment({ entryId: other.id, amount: 10, isInterest: false })).status, "created");

  assert.equal(await deleteLedgerEntryCascade(target.id, userId), true);

  assert.equal((await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, target.id))).length, 0);
  assert.equal((await repaymentRows(target.id)).length, 0);
  const journals = await journalsFor(userId);
  assert.ok(journals.every((journal) => journal.sourceLedgerEntryId !== target.id));
  assert.equal(journals.filter((journal) => journal.sourceLedgerEntryId === other.id).length, 1);
  assert.equal((await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, other.id))).length, 1);
  assert.equal((await repaymentRows(other.id)).length, 1);
});

test("deleteLedgerEntryCascade refuses another user's entry and deletes nothing", async () => {
  const owner = nextTestUserId();
  const intruder = nextTestUserId();
  const entry = await newReceivable(owner, 100);
  await postEntryJournal(entry);
  await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false });

  assert.equal(await deleteLedgerEntryCascade(entry.id, intruder), false);

  assert.equal((await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id))).length, 1);
  assert.equal((await repaymentRows(entry.id)).length, 1);
  assert.equal((await journalsFor(owner)).filter((j) => j.sourceLedgerEntryId === entry.id).length, 1);
  assert.equal(await deleteLedgerEntryCascade(2_100_000_002, owner), false);
});

test("deleteLedgerEntryCascade is atomic: a failure late in the delete keeps the entry and its repayments", async () => {
  const userId = nextTestUserId();
  const entry = await newReceivable(userId, 100);
  await postEntryJournal(entry);
  await recordRepayment({ entryId: entry.id, amount: 30, isInterest: false });

  await withJournalDeleteBlocked(entry.id, async () => {
    await assert.rejects(deleteLedgerEntryCascade(entry.id, userId));
  });

  assert.equal((await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, entry.id))).length, 1);
  assert.equal((await repaymentRows(entry.id)).length, 1, "repayment history must survive a failed delete");
  assert.equal((await journalsFor(userId)).filter((j) => j.sourceLedgerEntryId === entry.id).length, 1);
});

// ─── Amortization installment payment (F6) ───────────────────────────────────

async function newBorrowedWithInstallments(userId: number) {
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId, kind: "borrowed", title: "WP-1 loan", amount: 1000, currency: "BDT", status: "pending",
  }).returning();
  const installments = [];
  for (const installmentNo of [1, 2]) {
    const [row] = await db.insert(financeAmortizationTable).values({
      userId, ledgerEntryId: entry.id, installmentNo, dueDate: new Date(),
      principalDue: 100, interestDue: 10, totalDue: 110, remainingBalance: 1000 - 100 * installmentNo, status: "upcoming",
    }).returning();
    installments.push(row);
  }
  return { entry, installments };
}
const installmentRow = async (id: number) => {
  const [row] = await db.select().from(financeAmortizationTable).where(eq(financeAmortizationTable.id, id));
  return row;
};

test("paying an installment records principal and interest repayments and updates the entry", async () => {
  const userId = nextTestUserId();
  const { entry, installments } = await newBorrowedWithInstallments(userId);
  const result = await payAmortizationInstallment(installments[0].id, userId);
  assert.equal(result.status, "paid");
  const row = await installmentRow(installments[0].id);
  assert.equal(row.status, "paid");
  assert.ok(row.paidAt);
  const repayments = await repaymentRows(entry.id);
  assert.deepEqual(repayments.map((r) => [r.isInterest, r.amount]).sort(), [[0, 100], [1, 10]]);
  const updated = await entryRow(entry.id);
  assert.equal(Number(updated.amount), 900);
  assert.equal(updated.status, "partial");
  assert.equal(Number(updated.interestPaid), 10);
});

test("paying the same installment again changes nothing (already_paid)", async () => {
  const userId = nextTestUserId();
  const { entry, installments } = await newBorrowedWithInstallments(userId);
  assert.equal((await payAmortizationInstallment(installments[0].id, userId)).status, "paid");
  assert.equal((await payAmortizationInstallment(installments[0].id, userId)).status, "already_paid");
  assert.equal((await repaymentRows(entry.id)).length, 2);
  assert.equal(Number((await entryRow(entry.id)).amount), 900);
});

test("two concurrent payments of one installment are applied exactly once", async () => {
  const userId = nextTestUserId();
  const { entry, installments } = await newBorrowedWithInstallments(userId);
  const results = await Promise.all([
    payAmortizationInstallment(installments[1].id, userId),
    payAmortizationInstallment(installments[1].id, userId),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_paid", "paid"]);
  assert.equal((await repaymentRows(entry.id)).length, 2);
  assert.equal(Number((await entryRow(entry.id)).amount), 900);
});

test("paying another user's installment is not found and writes nothing", async () => {
  const owner = nextTestUserId();
  const intruder = nextTestUserId();
  const { entry, installments } = await newBorrowedWithInstallments(owner);
  assert.equal((await payAmortizationInstallment(installments[0].id, intruder)).status, "not_found");
  assert.equal((await installmentRow(installments[0].id)).status, "upcoming");
  assert.equal((await repaymentRows(entry.id)).length, 0);
});

test("a failed balance update rolls the installment payment back completely", async () => {
  const userId = nextTestUserId();
  const { entry, installments } = await newBorrowedWithInstallments(userId);
  const constraintName = `finance_test_reject_inst_${entry.id}_${randomInt(1, 1_000_000)}`;
  await pool.query(
    `ALTER TABLE finance_ledger_entries ADD CONSTRAINT ${constraintName} CHECK (id <> ${entry.id} OR amount <> 900)`,
  );
  try {
    await assert.rejects(payAmortizationInstallment(installments[0].id, userId));
    assert.equal((await installmentRow(installments[0].id)).status, "upcoming", "installment must not stay marked paid");
    assert.equal((await repaymentRows(entry.id)).length, 0);
    assert.equal(Number((await entryRow(entry.id)).amount), 1000);
  } finally {
    await pool.query(`ALTER TABLE finance_ledger_entries DROP CONSTRAINT IF EXISTS ${constraintName}`);
  }
});

test("an installment whose entry no longer exists reports entry_not_found and stays unpaid", async () => {
  const userId = nextTestUserId();
  const [row] = await db.insert(financeAmortizationTable).values({
    userId, ledgerEntryId: 2_100_000_003, installmentNo: 1, dueDate: new Date(),
    principalDue: 100, interestDue: 10, totalDue: 110, remainingBalance: 900, status: "upcoming",
  }).returning();
  assert.equal((await payAmortizationInstallment(row.id, userId)).status, "entry_not_found");
  assert.equal((await installmentRow(row.id)).status, "upcoming");
});

