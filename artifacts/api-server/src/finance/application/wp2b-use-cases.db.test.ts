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
} from "@workspace/db";
import {
  createAccount,
  createBook,
  deleteAccount,
  deleteBook,
  listAccounts,
  listUserBooks,
  setDefaultBook,
  updateAccount,
  updateBook,
} from "./books-accounts";
import { postJournal } from "../ledger/journal";
import { findByReceiptToken, mintEntryReceiptLink, revokeEntryReceiptLink } from "./receipts";

// WP-2b characterization tests for books/accounts and receipt links, moved unchanged out of
// routes/finance.ts. They pin the behavior the routes had before the move, including user
// scoping. Isolated Finance test schema only (pnpm test:finance-db). NOT YET EXECUTED.
// Not covered here: ai (parsing is covered by finance-ai.test.ts; commit/sms need notification
// and OCR seams) and invoice-branding (users table is not in the isolated schema).

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
      await db.delete(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      await db.delete(financeAccountsTable).where(eq(financeAccountsTable.userId, userId));
      await db.delete(financeBooksTable).where(eq(financeBooksTable.userId, userId));
    }
  } finally {
    await pool.end();
  }
});

test("books: first list ensures a default book; create seeds its own chart; update is user-scoped", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const initial = await listUserBooks(owner);
  assert.equal(initial.length, 1);
  assert.ok(initial[0].isDefault);

  const book = await createBook(owner, { name: "  Business  ", bookType: "business" });
  assert.equal(book.name, "Business");
  assert.equal(book.currency, "BDT");
  assert.equal(book.isDefault, 0);
  assert.ok((await listAccounts(owner, book.id)).length > 0, "new book starts with a seeded chart");

  assert.equal(await updateBook(other, book.id, { name: "hijack" }), undefined);
  const updated = await updateBook(owner, book.id, { notes: "n" });
  assert.equal(updated?.name, "Business", "undefined fields stay unchanged");
  assert.equal(updated?.notes, "n");
});

test("books: set-default leaves exactly one default and is user-scoped", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  await listUserBooks(owner);
  const second = await createBook(owner, { name: "Second" });
  assert.equal(await setDefaultBook(other, second.id), undefined);
  const row = await setDefaultBook(owner, second.id);
  assert.equal(row?.isDefault, 1);
  const defaults = (await listUserBooks(owner)).filter((b) => b.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, second.id);
});

test("books: delete refuses the default book and books with entries; removes an empty book with its chart", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const [defaultBook] = await listUserBooks(owner);
  assert.deepEqual(await deleteBook(owner, defaultBook.id), { status: "is_default" });
  assert.deepEqual(await deleteBook(other, defaultBook.id), { status: "not_found" });

  const withEntry = await createBook(owner, { name: "HasEntry" });
  await db.insert(financeLedgerEntriesTable).values({
    userId: owner, bookId: withEntry.id, kind: "expense", title: "x", amount: 1, currency: "BDT",
    category: "Other", occurredDate: new Date(), status: "paid",
  });
  assert.deepEqual(await deleteBook(owner, withEntry.id), { status: "has_entries" });

  const empty = await createBook(owner, { name: "Empty" });
  assert.deepEqual(await deleteBook(owner, empty.id), { status: "deleted" });
  assert.equal((await db.select().from(financeAccountsTable).where(eq(financeAccountsTable.bookId, empty.id))).length, 0);
  assert.equal((await db.select().from(financeBooksTable).where(eq(financeBooksTable.id, empty.id))).length, 0);
});

test("accounts: create normalizes normalBalance, rejects duplicate codes, update/delete protect system accounts", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const created = await createAccount(owner, { code: " 9100 ", name: " Custom ", type: "expense", normalBalance: "credit" });
  assert.equal(created.status, "created");
  if (created.status !== "created") return;
  assert.equal(created.account.code, "9100");
  assert.equal(created.account.name, "Custom");
  assert.equal(created.account.normalBalance, "credit");
  assert.equal(created.account.isSystem, 0);
  assert.deepEqual(await createAccount(owner, { code: "9100", name: "Dup", type: "expense" }), { status: "duplicate_code" });

  const odd = await createAccount(owner, { code: "9101", name: "Odd", type: "expense", normalBalance: "bogus" });
  assert.equal(odd.status === "created" && odd.account.normalBalance, "debit");

  assert.equal(await updateAccount(other, created.account.id, { name: "hijack" }), undefined);
  assert.equal((await updateAccount(owner, created.account.id, { name: "Renamed", code: "ignored" }))?.code, "9100", "code is not updatable");

  const system = (await listAccounts(owner)).find((a) => a.isSystem);
  assert.ok(system, "chart is seeded with system accounts");
  assert.equal(await updateAccount(owner, system!.id, { name: "x" }), undefined);
  assert.deepEqual(await deleteAccount(owner, system!.id), { status: "system_account" });
  assert.deepEqual(await deleteAccount(other, created.account.id), { status: "not_found" });
  assert.deepEqual(await deleteAccount(owner, created.account.id), { status: "deleted" });
});

test("receipts: mint is idempotent and owner-scoped; the public lookup works until revoked", async () => {
  const owner = nextTestUserId();
  const other = nextTestUserId();
  const [book] = await listUserBooks(owner);
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId: owner, bookId: book.id, kind: "income", title: "Receipt me", amount: 10, currency: "BDT",
    category: "Other", occurredDate: new Date(), status: "paid",
  }).returning();

  assert.deepEqual(await mintEntryReceiptLink(other, entry.id), { status: "entry_not_found" });
  const first = await mintEntryReceiptLink(owner, entry.id);
  const second = await mintEntryReceiptLink(owner, entry.id);
  assert.equal(first.status, "ok");
  assert.equal(second.status === "ok" && second.token, first.status === "ok" && first.token);

  if (first.status !== "ok") return;
  const found = await findByReceiptToken(first.token);
  assert.equal(found?.entry.id, entry.id);
  assert.equal(await findByReceiptToken("not-a-token"), null);

  assert.equal(await revokeEntryReceiptLink(other, entry.id), false);
  assert.equal(await revokeEntryReceiptLink(owner, entry.id), true);
  assert.equal(await findByReceiptToken(first.token), null);
});

// ─── F8: transactional book delete ───────────────────────────────────────────

test("F8: deleting a book removes its journal headers, lines and accounts, and leaves other books intact", async () => {
  const owner = nextTestUserId();
  await listUserBooks(owner);
  const doomed = await createBook(owner, { name: "Doomed" });
  const keeper = await createBook(owner, { name: "Keeper" });
  const post = (bookId: number) => postJournal(owner, {
    memo: "m", date: new Date(), bookId, isManual: true,
    lines: [{ accountCode: "1000", debit: 5, credit: 0 }, { accountCode: "3000", debit: 0, credit: 5 }],
  });
  const doomedJournal = await post(doomed.id);
  const keeperJournal = await post(keeper.id);
  assert.ok(doomedJournal && keeperJournal, "both journals must post");

  assert.deepEqual(await deleteBook(owner, doomed.id), { status: "deleted" });

  const doomedHeaders = await db.select().from(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.bookId, doomed.id));
  assert.equal(doomedHeaders.length, 0);
  const orphanLines = await db.select().from(financeJournalLinesTable)
    .where(inArray(financeJournalLinesTable.journalEntryId, [doomedJournal!.id]));
  assert.equal(orphanLines.length, 0, "no orphaned journal lines");
  assert.equal((await db.select().from(financeAccountsTable).where(eq(financeAccountsTable.bookId, doomed.id))).length, 0);

  const keeperHeaders = await db.select().from(financeJournalEntriesTable).where(eq(financeJournalEntriesTable.bookId, keeper.id));
  assert.equal(keeperHeaders.length, 1, "the other book's journal is untouched");
  assert.ok((await listAccounts(owner, keeper.id)).length > 0, "the other book's chart is untouched");
});

test("F8: two concurrent deletes of the same book yield exactly one deletion", async () => {
  const owner = nextTestUserId();
  await listUserBooks(owner);
  const book = await createBook(owner, { name: "Race" });
  const results = await Promise.all([deleteBook(owner, book.id), deleteBook(owner, book.id)]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["deleted", "not_found"]);
});

test("F8: delete is refused for a book that has entries, and nothing of it is removed", async () => {
  const owner = nextTestUserId();
  await listUserBooks(owner);
  const book = await createBook(owner, { name: "Busy" });
  await db.insert(financeLedgerEntriesTable).values({
    userId: owner, bookId: book.id, kind: "expense", title: "x", amount: 1, currency: "BDT",
    category: "Other", occurredDate: new Date(), status: "paid",
  });
  const chartBefore = (await listAccounts(owner, book.id)).length;
  assert.deepEqual(await deleteBook(owner, book.id), { status: "has_entries" });
  assert.equal((await listAccounts(owner, book.id)).length, chartBefore, "chart untouched after refusal");
});
