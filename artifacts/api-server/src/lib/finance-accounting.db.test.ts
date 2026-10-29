import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeBooksTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
} from "@workspace/db";
import { applyPrincipalRepayment } from "../finance/ledger/repayments";
import { ensureSystemAccounts } from "../finance/ledger/system-accounts";
import { postJournal } from "../finance/ledger/journal";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();

function nextTestUserId(): number {
  const userId = -randomInt(1, 2_000_000_000);
  testUserIds.add(userId);
  return userId;
}

after(async () => {
  try {
    for (const userId of testUserIds) {
      const journals = await db.select({ id: financeJournalEntriesTable.id })
        .from(financeJournalEntriesTable)
        .where(eq(financeJournalEntriesTable.userId, userId));
      const journalIds = journals.map((journal) => journal.id);
      if (journalIds.length > 0) {
        await db.delete(financeJournalLinesTable)
          .where(inArray(financeJournalLinesTable.journalEntryId, journalIds));
      }
      await db.delete(financeJournalEntriesTable)
        .where(eq(financeJournalEntriesTable.userId, userId));

      const entries = await db.select({ id: financeLedgerEntriesTable.id })
        .from(financeLedgerEntriesTable)
        .where(eq(financeLedgerEntriesTable.userId, userId));
      const entryIds = entries.map((entry) => entry.id);
      if (entryIds.length > 0) {
        await db.delete(financeRepaymentsTable)
          .where(inArray(financeRepaymentsTable.entryId, entryIds));
      }
      await db.delete(financeLedgerEntriesTable)
        .where(eq(financeLedgerEntriesTable.userId, userId));
      await db.delete(financeAccountsTable)
        .where(eq(financeAccountsTable.userId, userId));
      await db.delete(financeBooksTable)
        .where(eq(financeBooksTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("journal postings store balanced debit and credit lines in the resolved book", async () => {
  const userId = nextTestUserId();
  const journal = await postJournal(userId, {
    memo: "Finance database characterization",
    lines: [
      { accountCode: "1100", debit: 125.5, credit: 0 },
      { accountCode: "4000", debit: 0, credit: 125.5 },
    ],
    isManual: true,
  });

  assert.ok(journal);
  assert.ok(journal.bookId);

  const lines = await db.select().from(financeJournalLinesTable)
    .where(eq(financeJournalLinesTable.journalEntryId, journal.id));
  assert.equal(lines.length, 2);
  const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
  const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
  assert.equal(Math.abs(totalDebit - totalCredit) < 0.01, true);
  assert.equal(lines.reduce((sum, line) => sum + Number(line.debit), 0), 125.5);
  assert.equal(lines.reduce((sum, line) => sum + Number(line.credit), 0), 125.5);
});

test("failed journal-line insertion rolls back its journal header", async () => {
  const userId = nextTestUserId();
  const accounts = await ensureSystemAccounts(userId);
  const rejectedAccountId = accounts.get("1100")?.id;
  assert.ok(rejectedAccountId);
  const constraintName = `finance_test_reject_account_${rejectedAccountId}_${randomInt(1, 1_000_000)}`;
  await pool.query(
    `ALTER TABLE finance_journal_lines ADD CONSTRAINT ${constraintName} CHECK (account_id <> ${rejectedAccountId})`,
  );

  try {
    await assert.rejects(postJournal(userId, {
      memo: "Rollback characterization",
      lines: [
        { accountCode: "1100", debit: 50, credit: 0 },
        { accountCode: "4000", debit: 0, credit: 50 },
      ],
      isManual: true,
    }));

    const journals = await db.select().from(financeJournalEntriesTable)
      .where(eq(financeJournalEntriesTable.userId, userId));
    assert.equal(journals.length, 0);
  } finally {
    await pool.query(`ALTER TABLE finance_journal_lines DROP CONSTRAINT IF EXISTS ${constraintName}`);
  }
});

test("concurrent principal repayments do not lose an amount decrement", async () => {
  const userId = nextTestUserId();
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId,
    kind: "receivable",
    title: "Finance concurrency characterization",
    amount: 100,
    currency: "BDT",
    status: "pending",
  }).returning();

  const remaining = await Promise.all([
    applyPrincipalRepayment(entry.id, 40),
    applyPrincipalRepayment(entry.id, 40),
  ]);
  const [updated] = await db.select({
    amount: financeLedgerEntriesTable.amount,
    status: financeLedgerEntriesTable.status,
  }).from(financeLedgerEntriesTable)
    .where(eq(financeLedgerEntriesTable.id, entry.id));

  assert.deepEqual(remaining.sort((a, b) => (a ?? -1) - (b ?? -1)), [20, 60]);
  assert.equal(Number(updated.amount), 20);
  assert.equal(updated.status, "partial");
});
