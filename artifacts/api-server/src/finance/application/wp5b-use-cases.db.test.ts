import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeAttachmentsTable,
  financeBooksTable,
  financeInvoiceLinesTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
} from "@workspace/db";
import {
  MAX_ATTACHMENT_BYTES,
  addRepayment,
  createEntry,
  deleteEntry,
  deleteEntryAttachment,
  getEntryAttachment,
  importEntriesCsv,
  listEntries,
  listEntryAttachments,
  listInvoiceLines,
  listRepayments,
  replaceInvoiceLines,
  updateEntry,
  uploadEntryAttachment,
} from "./entries";

// WP-5b characterization tests for ledger entries, repayments, attachments, invoice lines and CSV import,
// moved out of routes/finance.ts, plus F14 (invoice-line replacement is one transaction). Isolated Finance
// test schema only (pnpm test:finance-db). NOT YET EXECUTED. Notifications are loaded on demand and fire
// best-effort; in this schema they fail silently, which is also the production contract. Idempotent replay,
// conflict and atomic balance are covered by ledger-invariants.db.test.ts (recordRepayment).

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
    // Let fire-and-forget journal postings settle before cleanup.
    await new Promise((r) => setTimeout(r, 300));
    for (const userId of testUserIds) {
      const entries = await db.select({ id: financeLedgerEntriesTable.id }).from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.userId, userId));
      for (const e of entries) {
        await db.delete(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, e.id));
        await db.delete(financeInvoiceLinesTable).where(eq(financeInvoiceLinesTable.entryId, e.id));
      }
      await db.delete(financeAttachmentsTable).where(eq(financeAttachmentsTable.userId, userId));
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

const newEntry = (userId: number, over: Record<string, any> = {}) =>
  createEntry(userId, { kind: "receivable", title: "  Invoice  ", ...over }, over.amount ?? 100);

// ─── Entries ─────────────────────────────────────────────────────────────────

test("createEntry applies the route defaults, trims the title and resolves the default book", async () => {
  const userId = nextTestUserId();
  const e = await newEntry(userId);
  assert.equal(e.userId, userId);
  assert.equal(e.title, "Invoice");
  assert.equal(e.amount, 100);
  assert.equal(e.currency, "BDT");
  assert.equal(e.status, "pending");
  assert.equal(e.interestPaid, 0);
  assert.equal(e.lateFeeGraceDays, 0);
  assert.ok(e.bookId, "bookId must be resolved, not null");
});

test("listEntries is scoped to the caller and filters by kind, status and project; newest occurredDate first", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const old = await newEntry(userA, { occurredDate: "2020-01-01T00:00:00.000Z", kind: "payable", status: "paid", projectId: 7 });
  const recent = await newEntry(userA, { occurredDate: "2024-01-01T00:00:00.000Z" });
  const foreign = await newEntry(userB);

  const all = await listEntries(userA);
  assert.deepEqual(all.map((e) => e.id), [recent.id, old.id]);
  assert.ok(!all.some((e) => e.id === foreign.id));
  assert.deepEqual((await listEntries(userA, { kind: "payable" })).map((e) => e.id), [old.id]);
  assert.deepEqual((await listEntries(userA, { status: "paid" })).map((e) => e.id), [old.id]);
  assert.deepEqual((await listEntries(userA, { projectId: 7 })).map((e) => e.id), [old.id]);
});

test("updateEntry changes only the given fields, validates numbers, and is scoped to the owner", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA, { notes: "keep" });

  const ok = await updateEntry(userA, e.id, { title: "Renamed", amount: "250", dueDate: "2031-01-01T00:00:00.000Z" });
  assert.equal(ok.status, "ok");
  if (ok.status !== "ok") return;
  assert.equal(ok.entry.title, "Renamed");
  assert.equal(ok.entry.amount, 250);
  assert.equal(ok.entry.notes, "keep");
  assert.equal(ok.entry.remindedAt, null, "changing the due date re-arms the reminder");

  assert.deepEqual(await updateEntry(userA, e.id, { amount: "abc" }), { status: "invalid", error: "amount must be a valid number" });
  assert.deepEqual(await updateEntry(userA, e.id, { amount: -5 }), { status: "invalid", error: "amount must be a positive number" });
  assert.deepEqual(await updateEntry(userA, e.id, { interestPaid: Number.NaN }), { status: "invalid", error: "interestPaid must be a valid number" });
  assert.deepEqual(await updateEntry(userB, e.id, { title: "hijack" }), { status: "not_found" });
  const [stored] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, e.id));
  assert.equal(stored.title, "Renamed");
  assert.equal(stored.amount, 250, "rejected updates changed nothing");
});

test("deleteEntry removes the entry and its repayments; a foreign or missing id deletes nothing", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA);
  const rep = await addRepayment(userA, e.id, { amount: 10, isInterest: false });
  assert.equal(rep.status, "created");

  assert.equal(await deleteEntry(userB, e.id), false);
  assert.equal((await listEntries(userA)).length, 1);
  assert.equal(await deleteEntry(userA, e.id), true);
  assert.equal((await listEntries(userA)).length, 0);
  assert.equal((await db.select().from(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, e.id))).length, 0);
  assert.equal(await deleteEntry(userA, e.id), false, "second delete");
});

// ─── Repayments ──────────────────────────────────────────────────────────────

test("addRepayment reduces the principal, then reports the right status for bad inputs", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA, { amount: 100 });

  const created = await addRepayment(userA, e.id, { amount: 30, isInterest: false, notes: "first" });
  assert.equal(created.status, "created");
  if (created.status === "created") assert.equal(created.repayment.amount, 30);
  const [after1] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, e.id));
  assert.equal(after1.amount, 70);

  assert.deepEqual(await addRepayment(userB, e.id, { amount: 1, isInterest: false }), { status: "entry_not_found" });
  const expense = await newEntry(userA, { kind: "expense" });
  assert.deepEqual(await addRepayment(userA, expense.id, { amount: 1, isInterest: false }), { status: "not_repayable", kind: "expense" });

  const list = await listRepayments(userA, e.id);
  assert.equal(list?.length, 1);
  assert.equal(await listRepayments(userB, e.id), undefined);
});

test("addRepayment with the same idempotency key replays; a different amount conflicts", async () => {
  const userId = nextTestUserId();
  const e = await newEntry(userId, { amount: 100 });
  const first = await addRepayment(userId, e.id, { amount: 20, isInterest: false, idempotencyKey: "k-1" });
  assert.equal(first.status, "created");
  const replay = await addRepayment(userId, e.id, { amount: 20, isInterest: false, idempotencyKey: "k-1" });
  assert.equal(replay.status, "replayed");
  assert.deepEqual(await addRepayment(userId, e.id, { amount: 25, isInterest: false, idempotencyKey: "k-1" }), { status: "conflict" });
  const [row] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, e.id));
  assert.equal(row.amount, 80, "applied once");
});

// ─── Attachments ─────────────────────────────────────────────────────────────

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

test("uploadEntryAttachment stores an allowed file and lists metadata only", async () => {
  const userId = nextTestUserId();
  const e = await newEntry(userId);
  const up = await uploadEntryAttachment(userId, e.id, { fileName: "  r.png  ", mimeType: "IMAGE/PNG", note: " scan ", dataBase64: `data:image/png;base64,${PNG_B64}` });
  assert.equal(up.status, "ok");
  if (up.status !== "ok") return;
  assert.equal(up.attachment.fileName, "r.png");
  assert.equal(up.attachment.mimeType, "image/png");
  assert.equal(up.attachment.note, "scan");
  assert.equal(up.attachment.fileSizeBytes, Buffer.from(PNG_B64, "base64").length);

  const list = await listEntryAttachments(userId, e.id);
  assert.equal(list?.length, 1);
  assert.ok(!("contentBase64" in (list![0] as object)), "list must not return file bytes");

  const one = await getEntryAttachment(userId, e.id, up.attachment.id);
  assert.equal(one.status, "ok");
  if (one.status === "ok") assert.equal(one.attachment.contentBase64, PNG_B64, "data-URL prefix is stripped");
});

test("uploadEntryAttachment rejects bad input with the route's messages", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA);
  const good = { fileName: "a.png", mimeType: "image/png", dataBase64: PNG_B64 };

  assert.deepEqual(await uploadEntryAttachment(userB, e.id, good), { status: "entry_not_found" });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, fileName: " " }), { status: "invalid", error: "fileName is required" });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, mimeType: "" }), { status: "invalid", error: "mimeType is required" });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, mimeType: "text/html" }), { status: "invalid", error: 'Unsupported file type "text/html". Only images and PDFs are allowed.' });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, dataBase64: "" }), { status: "invalid", error: "dataBase64 is required" });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, dataBase64: "data:image/png;base64," }), { status: "invalid", error: "File is empty" });
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, { ...good, dataBase64: big }), { status: "too_large", maxBytes: MAX_ATTACHMENT_BYTES });
  assert.deepEqual(await uploadEntryAttachment(userA, e.id, undefined), { status: "invalid", error: "fileName is required" });
  assert.equal((await listEntryAttachments(userA, e.id))?.length, 0, "nothing stored by rejected uploads");
});

test("getEntryAttachment and deleteEntryAttachment are scoped to the entry owner", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA);
  const other = await newEntry(userA);
  const up = await uploadEntryAttachment(userA, e.id, { fileName: "a.pdf", mimeType: "application/pdf", dataBase64: PNG_B64 });
  assert.equal(up.status, "ok");
  if (up.status !== "ok") return;
  const id = up.attachment.id;

  assert.deepEqual(await getEntryAttachment(userB, e.id, id), { status: "entry_not_found" });
  assert.deepEqual(await getEntryAttachment(userA, other.id, id), { status: "attachment_not_found" }, "attachment belongs to another entry");
  assert.equal(await deleteEntryAttachment(userB, e.id, id), false);
  assert.equal((await listEntryAttachments(userA, e.id))?.length, 1);
  assert.equal(await deleteEntryAttachment(userA, other.id, id), true, "wrong entry: succeeds but deletes nothing");
  assert.equal((await listEntryAttachments(userA, e.id))?.length, 1);
  assert.equal(await deleteEntryAttachment(userA, e.id, id), true);
  assert.equal((await listEntryAttachments(userA, e.id))?.length, 0);
});

// ─── Invoice lines ───────────────────────────────────────────────────────────

test("replaceInvoiceLines replaces the set, recomputes the amount and keeps line order (F14)", async () => {
  const userId = nextTestUserId();
  const e = await newEntry(userId, { amount: 1 });
  const first = await replaceInvoiceLines(userId, e.id, [
    { description: "A", quantity: 2, unitPrice: 50, taxPercent: 10 },
    { description: "B" },
  ]);
  assert.equal(first.status, "ok");
  if (first.status !== "ok") return;
  assert.deepEqual(first.lines.map((l) => [l.description, l.sortOrder, l.quantity, l.unitPrice, l.taxPercent]), [["A", 0, 2, 50, 10], ["B", 1, 1, 0, 0]]);
  assert.ok(Math.abs(first.entry!.amount - 110) < 1e-9);

  const second = await replaceInvoiceLines(userId, e.id, [{ description: "C", quantity: 1, unitPrice: 20 }]);
  assert.equal(second.status, "ok");
  assert.deepEqual((await listInvoiceLines(userId, e.id))?.map((l) => l.description), ["C"], "old lines are gone");
  const [stored] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, e.id));
  assert.equal(stored.amount, 20);
});

test("replaceInvoiceLines guards: owner, receivable only, at least one line", async () => {
  const userA = nextTestUserId();
  const userB = nextTestUserId();
  const e = await newEntry(userA);
  const payable = await newEntry(userA, { kind: "payable" });
  assert.deepEqual(await replaceInvoiceLines(userB, e.id, [{ description: "x" }]), { status: "entry_not_found" });
  assert.deepEqual(await replaceInvoiceLines(userA, payable.id, [{ description: "x" }]), { status: "invalid", error: "Invoice lines only apply to receivable entries" });
  assert.deepEqual(await replaceInvoiceLines(userA, e.id, []), { status: "invalid", error: "At least one line item is required" });
  assert.deepEqual(await replaceInvoiceLines(userA, e.id, undefined), { status: "invalid", error: "At least one line item is required" });
  assert.equal(await listInvoiceLines(userB, e.id), undefined);
});

test("a failed invoice-line insert rolls back: previous lines and the amount survive (F14)", async () => {
  const userId = nextTestUserId();
  const e = await newEntry(userId, { amount: 1 });
  const ok = await replaceInvoiceLines(userId, e.id, [{ description: "keep", quantity: 1, unitPrice: 40 }]);
  assert.equal(ok.status, "ok");
  // description is NOT NULL: a null description makes the insert throw after the delete.
  await assert.rejects(replaceInvoiceLines(userId, e.id, [{ description: null as unknown as string, unitPrice: 999 }]));
  assert.deepEqual((await listInvoiceLines(userId, e.id))?.map((l) => l.description), ["keep"]);
  const [stored] = await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, e.id));
  assert.equal(stored.amount, 40);
});

// ─── CSV import ──────────────────────────────────────────────────────────────

test("importEntriesCsv inserts valid rows into the default book and reports bad rows with line numbers", async () => {
  const userId = nextTestUserId();
  const csv = [
    "kind,title,amount,currency,category,dueDate,status,interestRate,notes",
    "receivable,Good,100,USD,rent,2030-01-01,,5,n1",
    "weird,Bad kind,10,,,,,,",
    "payable,,10,,,,,,",
    "payable,Bad amount,0,,,,,,",
    "payable,Bad rate,10,,,,,N/A,",
    "EXPENSE,Upper kind,7,,,,,,",
  ].join("\n");
  const result = await importEntriesCsv(userId, csv);
  assert.deepEqual(result, {
    inserted: 2,
    failed: 4,
    errors: [
      'Row 3: invalid kind "weird"',
      "Row 4: missing title",
      'Row 5: invalid amount "0"',
      'Row 6: invalid interestRate "N/A"',
    ],
  });
  const rows = await listEntries(userId);
  assert.equal(rows.length, 2, "imported rows are visible (bookId resolved)");
  const good = rows.find((r) => r.title === "Good")!;
  assert.equal(good.currency, "USD");
  assert.equal(good.status, "pending");
  assert.equal(good.interestRate, 5);
  assert.equal(good.notes, "n1");
  assert.equal(rows.find((r) => r.title === "Upper kind")?.kind, "expense");
});
