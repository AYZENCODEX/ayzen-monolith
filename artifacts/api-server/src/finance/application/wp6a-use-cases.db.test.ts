import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeBooksTable,
  financeInvoiceEventsTable,
  financeInvoiceLineItemsTable,
  financeInvoicesTable,
  financeLedgerEntriesTable,
  financePaymentAgreementsTable,
} from "@workspace/db";
import {
  brandingFromUser,
  cancelInvoice,
  createInvoice,
  findInvoiceOwnerId,
  getInvoiceDetail,
  getPublicInvoiceView,
  listInvoices,
  parseLineItemsFromBody,
  reopenInvoice,
  sendInvoice,
  streamCreditorInvoicePdf,
  streamPublicInvoicePdf,
  submitInvoicePayment,
  updateInvoiceLineItems,
} from "./invoices";
import { replaceInvoiceLineItems, getInvoiceLineItems } from "../invoices/store";
import { logInvoiceEvent } from "../invoices/events";
import { createAndSendRuleInvoice } from "../invoices/rule-invoice";
import { financeInvoiceUrl, financePaymentAgreementUrl, generateAgreementToken, generateInvoiceToken } from "../invoices/links";

// WP-6a characterization tests for the invoice use cases moved out of routes/finance-invoices.ts, plus the new
// guarantees F15 to F18 (see finance-safety-findings.md). Isolated Finance test schema only (pnpm test:finance-db).
//
// Race tests do not rely on timing luck. A second connection takes the invoice row lock (and makes its change),
// the use case is started, the test waits until the use case's statement is really blocked on that lock
// (pg_stat_activity), and only then commits. The use case therefore has a stale pre-commit view when its write
// runs, which is exactly the interleaving the old code mishandled. Failure injection uses throwaway triggers
// that live in the isolated schema and are dropped right after.

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
    await new Promise((r) => setTimeout(r, 300)); // let fire-and-forget event rows settle
    const ids = [...testUserIds];
    if (ids.length) {
      const invoices = await db.select({ id: financeInvoicesTable.id }).from(financeInvoicesTable).where(inArray(financeInvoicesTable.userId, ids));
      const invoiceIds = invoices.map((i) => i.id);
      if (invoiceIds.length) {
        await db.delete(financeInvoiceEventsTable).where(inArray(financeInvoiceEventsTable.invoiceId, invoiceIds));
        await db.delete(financePaymentAgreementsTable).where(inArray(financePaymentAgreementsTable.invoiceId, invoiceIds));
        await db.delete(financeInvoiceLineItemsTable).where(inArray(financeInvoiceLineItemsTable.invoiceId, invoiceIds));
        await db.delete(financeInvoicesTable).where(inArray(financeInvoicesTable.id, invoiceIds));
      }
      await db.delete(financeLedgerEntriesTable).where(inArray(financeLedgerEntriesTable.userId, ids));
      await db.delete(financeAccountsTable).where(inArray(financeAccountsTable.userId, ids));
      await db.delete(financeBooksTable).where(inArray(financeBooksTable.userId, ids));
      await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    }
  } finally {
    await pool.end();
  }
});

// drizzle wraps driver errors as 'Failed query: ...'; the trigger's own message is on `cause`.
const INJECTED = (err: any) => /injected failure/.test(`${err?.message} ${err?.cause?.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const req = { ip: "::ffff:203.0.113.9", socket: {}, headers: { "user-agent": "wp6a-test" } } as any;

async function newUser(over: { prefix?: string; terms?: string } = {}): Promise<number> {
  const id = nextTestUserId();
  await pool.query(
    "INSERT INTO users (id, username, email, finance_invoice_number_prefix, finance_invoice_terms) VALUES ($1, $2, $3, $4, $5)",
    [id, `user${-id}`, `user${-id}@test.local`, over.prefix ?? "INV", over.terms ?? null],
  );
  return id;
}

const LINES = [{ description: "Design", quantity: 2, unitPrice: 50 }]; // subtotal 100
async function newInvoice(userId: number, over: Record<string, any> = {}, lines = LINES) {
  const result = await createInvoice(userId, { debtorName: "Dee", debtorEmail: null, ...over }, lines);
  assert.equal(result.status, "ok");
  return (result as Extract<typeof result, { status: "ok" }>).invoice;
}
const invoiceRow = async (id: number) => (await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, id)))[0];
const setInvoice = (id: number, patch: Record<string, any>) => db.update(financeInvoicesTable).set(patch).where(eq(financeInvoicesTable.id, id));
const eventTypes = async (invoiceId: number) =>
  (await db.select().from(financeInvoiceEventsTable).where(eq(financeInvoiceEventsTable.invoiceId, invoiceId))).map((e) => e.eventType).sort();

/** Holds the invoice row lock on a second connection and applies `statements` inside that transaction. */
async function holdInvoice(invoiceId: number, statements: Array<[string, any[]]>) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM finance_invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
  for (const [text, params] of statements) await client.query(text, params);
  return {
    async commit() { await client.query("COMMIT"); client.release(); },
  };
}
async function waitUntilBlocked(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows[0].n > 0) return;
    await sleep(30);
  }
  throw new Error("the use case never blocked on the invoice lock; the interleaving was not exercised");
}
async function raceWithCommit<T>(invoiceId: number, statements: Array<[string, any[]]>, run: () => Promise<T>): Promise<T> {
  const held = await holdInvoice(invoiceId, statements);
  const pending = run();
  pending.catch(() => {});
  await waitUntilBlocked();
  await held.commit();
  return pending;
}

async function withFailingTrigger<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  const name = `wp6a_boom_${randomInt(1, 1_000_000)}`;
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await pool.query(`DROP TRIGGER ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION ${name}()`);
  }
}

// ─── Request-shape helpers and links ─────────────────────────────────────────

test("parseLineItemsFromBody accepts lineItems, falls back to the legacy single amount, and trims", () => {
  assert.deepEqual(parseLineItemsFromBody({ lineItems: [{ description: "  A ", quantity: "3", unitPrice: "2.5" }] }), [{ description: "A", quantity: 3, unitPrice: 2.5 }]);
  assert.deepEqual(parseLineItemsFromBody({ lineItems: [{ description: "B" }] }), [{ description: "B", quantity: 1, unitPrice: 0 }]);
  assert.deepEqual(parseLineItemsFromBody({ amount: 40 }), [{ description: "Invoice total", quantity: 1, unitPrice: 40 }]);
  assert.deepEqual(parseLineItemsFromBody({}), []);
  assert.deepEqual(parseLineItemsFromBody({ lineItems: [] }), []);
});

test("brandingFromUser maps every field and tolerates a missing user", () => {
  assert.equal(brandingFromUser(undefined).logoUrl, null);
  const b = brandingFromUser({
    financeInvoiceLogoUrl: "l", financeInvoiceThemeColor: "#111111", financeInvoiceBusinessName: "n", financeInvoiceBusinessAddress: "a",
    financeInvoiceFooterNote: "f", financeInvoiceTaxId: "t", financeInvoiceBusinessEmail: "e", financeInvoiceBusinessPhone: "p",
    financeInvoiceWebsite: "w", financeInvoiceTerms: "x",
  });
  assert.deepEqual(b, { logoUrl: "l", themeColor: "#111111", businessName: "n", businessAddress: "a", footerNote: "f", taxId: "t", businessEmail: "e", businessPhone: "p", website: "w", termsText: "x" });
});

test("invoice and agreement tokens are unguessable and the URLs keep their public shape", () => {
  assert.notEqual(generateInvoiceToken(), generateInvoiceToken());
  assert.notEqual(generateAgreementToken(), generateAgreementToken());
  assert.match(generateInvoiceToken(), /^[A-Za-z0-9_-]{27}$/);
  assert.match(financeInvoiceUrl("tok"), /\/finance\/invoice\/tok$/);
  assert.match(financePaymentAgreementUrl("tok"), /\/finance\/payment-agreement\/tok$/);
});

// ─── Create ──────────────────────────────────────────────────────────────────

test("createInvoice computes totals, numbers the invoice with the creditor's prefix and stores the lines", async () => {
  const userId = await newUser({ prefix: "ACME" });
  const result = await createInvoice(userId, {
    debtorName: "Dee", debtorEmail: "dee@x.test", currency: "USD", discountType: "percent", discountValue: 10, taxRate: 15,
    poNumber: "PO-7", taxLabel: "VAT", terms: "Net 7", notes: "thanks", dueDate: "2026-12-01T00:00:00Z",
  }, [{ description: "Design", quantity: 2, unitPrice: 50 }, { description: "Build", quantity: 1, unitPrice: 100 }]);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const inv = result.invoice;
  // subtotal 200, 10% discount -> 180, 15% tax -> 207
  assert.equal(inv.amount, 207);
  assert.match(inv.invoiceNumber ?? "", /^ACME-\d{4}-\d{5}$/);
  assert.equal(inv.userId, userId);
  assert.equal(inv.status, "sent");
  assert.equal(inv.currency, "USD");
  assert.equal(inv.taxLabel, "VAT");
  assert.equal(inv.poNumber, "PO-7");
  assert.equal(inv.terms, "Net 7");
  assert.equal(inv.paidAmount, 0);
  assert.ok(inv.bookId, "a book is resolved for the creditor");
  assert.equal(result.lineItems.length, 2);
  assert.deepEqual(result.lineItems.map((l) => [l.description, l.sortOrder]), [["Design", 0], ["Build", 1]]);
});

test("createInvoice defaults: BDT, no discount unless a valid type is given, tax clamped to 100", async () => {
  const userId = await newUser();
  const a = await newInvoice(userId, { discountValue: 50 }); // no type: value ignored
  assert.equal(a.amount, 100);
  assert.equal(a.currency, "BDT");
  assert.equal(a.discountType, null);
  assert.equal(a.discountValue, 0);
  const b = await newInvoice(userId, { taxRate: 500 });
  assert.equal(b.taxRate, 100);
  assert.equal(b.amount, 200);
  const c = await newInvoice(userId, { discountType: "flat", discountValue: 30 });
  assert.equal(c.amount, 70);
});

test("createInvoice links only to the caller's repayable entries", async () => {
  const userId = await newUser();
  const other = await newUser();
  const mkEntry = async (uid: number, kind: string) => (await db.insert(financeLedgerEntriesTable).values({ userId: uid, kind, title: "e", amount: 100 }).returning())[0];
  const receivable = await mkEntry(userId, "receivable");
  const expense = await mkEntry(userId, "expense");
  const foreign = await mkEntry(other, "receivable");

  const ok = await createInvoice(userId, { debtorName: "Dee", entryId: receivable.id }, LINES);
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") assert.equal(ok.invoice.entryId, receivable.id);

  assert.deepEqual(await createInvoice(userId, { debtorName: "Dee", entryId: foreign.id }, LINES), { status: "entry_not_found" });
  assert.deepEqual(await createInvoice(userId, { debtorName: "Dee", entryId: 987654321 }, LINES), { status: "entry_not_found" });
  assert.deepEqual(await createInvoice(userId, { debtorName: "Dee", entryId: expense.id }, LINES), { status: "entry_not_repayable", kind: "expense" });
  const count = (await listInvoices(userId)).length;
  assert.equal(count, 1, "rejected links must not leave an invoice behind");
});

test("F15: a failure while saving the lines rolls the whole creation back (no invoice without lines)", async () => {
  const userId = await newUser();
  await withFailingTrigger("finance_invoice_line_items", "NEW.description = 'BOOM'", async () => {
    await assert.rejects(createInvoice(userId, { debtorName: "Dee" }, [{ description: "BOOM", quantity: 1, unitPrice: 5 }]), INJECTED);
  });
  assert.deepEqual(await listInvoices(userId), [], "the invoice row must not survive a failed line insert");
  const next = await newInvoice(userId); // and the creditor can still create invoices afterwards
  assert.ok(next.invoiceNumber);
});

test("F15: replaceInvoiceLineItems is atomic: a failed insert keeps the previous lines", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  await withFailingTrigger("finance_invoice_line_items", "NEW.description = 'BOOM'", async () => {
    await assert.rejects(replaceInvoiceLineItems(inv.id, [{ description: "BOOM", quantity: 1, unitPrice: 1 }]), INJECTED);
  });
  const lines = await getInvoiceLineItems(inv.id);
  assert.deepEqual(lines.map((l) => l.description), ["Design"], "the delete must have been rolled back");
  // normal replacement still works and keeps at least one row
  const total = await replaceInvoiceLineItems(inv.id, [{ description: "   ", quantity: 1, unitPrice: 9 }]);
  assert.equal(total, 0);
  assert.deepEqual((await getInvoiceLineItems(inv.id)).map((l) => l.description), ["Invoice total"]);
});

test("F15: the recurring-rule auto-invoice writes the invoice, its line and its number together", async () => {
  const userId = await newUser({ prefix: "REC" });
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "Retainer", amount: 250 }).returning())[0];
  const rule = { id: 7, invoiceDebtorName: "Dee", invoiceDebtorEmail: "dee@x.test", invoiceDebtorTelegramChatId: null, invoiceDueDays: 5 };
  await createAndSendRuleInvoice({ id: entry.id, userId, bookId: null, amount: 250, currency: "BDT", occurredDate: new Date("2026-01-10T00:00:00Z"), title: "Retainer" }, rule);
  const [inv] = await listInvoices(userId);
  assert.ok(inv, "the invoice was created");
  assert.equal(inv.amount, 250);
  assert.equal(inv.recurringRuleId, 7);
  assert.match(inv.invoiceNumber ?? "", /^REC-\d{4}-\d{5}$/);
  assert.equal(inv.entryId, entry.id);
  assert.deepEqual((await getInvoiceLineItems(inv.id)).map((l) => [l.description, l.unitPrice]), [["Retainer", 250]]);
  assert.equal(inv.sentViaEmail, 0, "no email transport in tests: not marked as sent");

  // never throws, and skips when there is nobody to send to
  await createAndSendRuleInvoice({ id: entry.id, userId, bookId: null, amount: 1, currency: "BDT", occurredDate: new Date(), title: "x" },
    { id: 8, invoiceDebtorName: null, invoiceDebtorEmail: null, invoiceDebtorTelegramChatId: null, invoiceDueDays: 7 });
  assert.equal((await listInvoices(userId)).length, 1);

  // a failed line insert leaves nothing behind
  await withFailingTrigger("finance_invoice_line_items", "NEW.description = 'BOOM'", async () => {
    await createAndSendRuleInvoice({ id: entry.id, userId, bookId: null, amount: 9, currency: "BDT", occurredDate: new Date(), title: "BOOM" }, rule);
  });
  assert.equal((await listInvoices(userId)).length, 1, "the half-written invoice must have been rolled back");
});

// ─── Read paths ──────────────────────────────────────────────────────────────

test("listInvoices is scoped to the caller, newest first, and filters by entry", async () => {
  const userId = await newUser();
  const other = await newUser();
  const entry = (await db.insert(financeLedgerEntriesTable).values({ userId, kind: "receivable", title: "e", amount: 100 }).returning())[0];
  const first = await newInvoice(userId);
  await sleep(15);
  const linked = (await createInvoice(userId, { debtorName: "Dee", entryId: entry.id }, LINES)) as any;
  await newInvoice(other);
  const all = await listInvoices(userId);
  assert.deepEqual(all.map((i) => i.id), [linked.invoice.id, first.id]);
  assert.deepEqual((await listInvoices(userId, entry.id)).map((i) => i.id), [linked.invoice.id]);
  assert.deepEqual(await listInvoices(userId, 123456789), []);
  assert.equal((await listInvoices(other)).length, 1);
});

test("getInvoiceDetail returns lines, events and agreements for the owner only", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);
  await logInvoiceEvent(inv.id, "viewed", req, { a: 1 });
  const detail = await getInvoiceDetail(userId, inv.id);
  assert.ok(detail);
  assert.equal(detail.invoice.id, inv.id);
  assert.equal(detail.lineItems.length, 1);
  assert.deepEqual(detail.events.map((e) => e.eventType), ["viewed"]);
  assert.equal(detail.events[0].ipAddress, "203.0.113.9", "the ::ffff: prefix is stripped");
  assert.equal(detail.events[0].userAgent, "wp6a-test");
  assert.equal(detail.events[0].meta, JSON.stringify({ a: 1 }));
  assert.deepEqual(detail.agreements, []);
  assert.equal(await getInvoiceDetail(other, inv.id), null);
  assert.equal(await getInvoiceDetail(userId, 987654321), null);
  assert.equal(await findInvoiceOwnerId(inv.id), userId);
  assert.equal(await findInvoiceOwnerId(987654321), undefined);
});

// ─── Line-item edit ──────────────────────────────────────────────────────────

test("updateInvoiceLineItems replaces the lines, recomputes the total and applies only the fields present", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId, { discountType: "flat", discountValue: 10, taxRate: 10, poNumber: "A", terms: "T1", taxLabel: "VAT" });
  // keep discount/tax/po/terms when the body does not mention them: (3*20 - 10) * 1.1 = 55
  const kept = await updateInvoiceLineItems(userId, inv.id, { lineItems: [{ description: "X", quantity: 3, unitPrice: 20 }] }, [{ description: "X", quantity: 3, unitPrice: 20 }]);
  assert.equal(kept.status, "ok");
  if (kept.status !== "ok") return;
  assert.equal(kept.invoice.amount, 55);
  assert.equal(kept.invoice.poNumber, "A");
  assert.equal(kept.invoice.terms, "T1");
  assert.deepEqual(kept.lineItems.map((l) => l.description), ["X"]);

  // explicit overrides
  const body = { discountType: "bogus", taxRate: 250, poNumber: "", terms: "", taxLabel: "" };
  const changed = await updateInvoiceLineItems(userId, inv.id, body, [{ description: "Y", quantity: 1, unitPrice: 40 }]);
  assert.equal(changed.status, "ok");
  if (changed.status !== "ok") return;
  assert.equal(changed.invoice.discountType, null);
  assert.equal(changed.invoice.taxRate, 100);
  assert.equal(changed.invoice.amount, 80);
  assert.equal(changed.invoice.poNumber, null);
  assert.equal(changed.invoice.terms, null);
  assert.equal(changed.invoice.taxLabel, "Tax");
  assert.equal((await invoiceRow(inv.id)).amount, 80);
});

test("updateInvoiceLineItems refuses foreign and missing invoices, and anything past sent/viewed or with money on it", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);
  const lines = [{ description: "Z", quantity: 1, unitPrice: 1 }];
  assert.deepEqual(await updateInvoiceLineItems(other, inv.id, { lineItems: lines }, lines), { status: "not_found" });
  assert.deepEqual(await updateInvoiceLineItems(userId, 987654321, { lineItems: lines }, lines), { status: "not_found" });
  await setInvoice(inv.id, { status: "viewed" });
  assert.equal((await updateInvoiceLineItems(userId, inv.id, { lineItems: lines }, lines)).status, "ok");
  for (const status of ["payment_submitted", "partially_paid", "paid", "disputed", "cancelled"]) {
    await setInvoice(inv.id, { status });
    assert.deepEqual(await updateInvoiceLineItems(userId, inv.id, { lineItems: lines }, lines), { status: "locked" }, status);
  }
  await setInvoice(inv.id, { status: "sent", paidAmount: 5 });
  assert.deepEqual(await updateInvoiceLineItems(userId, inv.id, { lineItems: lines }, lines), { status: "locked" });
  assert.deepEqual((await getInvoiceLineItems(inv.id)).map((l) => l.description), ["Z"], "refused edits change nothing");
});

test("F16: an edit cannot slip in after a payment claim that was committed while it waited", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const lines = [{ description: "Sneaky", quantity: 1, unitPrice: 1 }];
  const result = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'payment_submitted' WHERE id = $1", [inv.id]],
    ["INSERT INTO finance_payment_agreements (invoice_id, payer_user_id, method_type, amount, agreement_token) VALUES ($1, $2, 'bkash', 100, $3)", [inv.id, payer, generateAgreementToken()]],
  ], () => updateInvoiceLineItems(userId, inv.id, { lineItems: lines }, lines));
  assert.deepEqual(result, { status: "locked" });
  assert.equal((await invoiceRow(inv.id)).amount, 100, "the amount the payer claimed against is untouched");
  assert.deepEqual((await getInvoiceLineItems(inv.id)).map((l) => l.description), ["Design"]);
});

test("F16: a failed line insert during an edit rolls back the delete and the amount", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  const lines = [{ description: "BOOM", quantity: 5, unitPrice: 5 }];
  await withFailingTrigger("finance_invoice_line_items", "NEW.description = 'BOOM'", async () => {
    await assert.rejects(updateInvoiceLineItems(userId, inv.id, { lineItems: lines }, lines), INJECTED);
  });
  assert.equal((await invoiceRow(inv.id)).amount, 100);
  assert.deepEqual((await getInvoiceLineItems(inv.id)).map((l) => l.description), ["Design"]);
});

// ─── Send, cancel ────────────────────────────────────────────────────────────

test("sendInvoice with no usable channel stamps lastSentAt, keeps the flags, logs send_failed and returns the link", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  assert.equal(inv.lastSentAt, null);
  const res = await sendInvoice(userId, inv.id, [], req);
  assert.deepEqual(res, { status: "ok", sentEmail: false, sentTelegram: false, url: financeInvoiceUrl(inv.invoiceToken) });
  const after = await invoiceRow(inv.id);
  assert.ok(after.lastSentAt);
  assert.equal(after.status, "sent");
  assert.equal(after.sentViaEmail, 0);
  await sleep(200);
  assert.deepEqual(await eventTypes(inv.id), ["send_failed"]);
});

test("sendInvoice is scoped to the owner; a viewed invoice goes back to sent, other statuses are kept", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);
  assert.deepEqual(await sendInvoice(other, inv.id, [], req), { status: "not_found" });
  assert.deepEqual(await sendInvoice(userId, 987654321, [], req), { status: "not_found" });
  await setInvoice(inv.id, { status: "viewed" });
  await sendInvoice(userId, inv.id, [], req);
  assert.equal((await invoiceRow(inv.id)).status, "sent");
  for (const status of ["payment_submitted", "partially_paid", "paid", "disputed", "cancelled"]) {
    await setInvoice(inv.id, { status });
    await sendInvoice(userId, inv.id, [], req);
    assert.equal((await invoiceRow(inv.id)).status, status, `${status} must be kept`);
  }
});

test("sendInvoice never lowers the sent-via flags", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { sentViaEmail: 1, sentViaTelegram: 1 });
  await sendInvoice(userId, inv.id, [], req);
  const row = await invoiceRow(inv.id);
  assert.deepEqual([row.sentViaEmail, row.sentViaTelegram], [1, 1]);
});

test("F17: sending cannot overwrite a payment claim submitted while the send was in flight", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { status: "viewed" });
  const res = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'payment_submitted' WHERE id = $1", [inv.id]],
  ], () => sendInvoice(userId, inv.id, [], req));
  assert.equal(res.status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted", "the old code wrote back the stale 'sent'");
});

test("cancelInvoice cancels the caller's unsettled invoice and nobody else's; a settled invoice is refused (F22)", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);
  assert.deepEqual(await cancelInvoice(other, inv.id), { status: "not_found" });
  assert.deepEqual(await cancelInvoice(userId, 987654321), { status: "not_found" });
  assert.equal((await invoiceRow(inv.id)).status, "sent");
  assert.deepEqual(await cancelInvoice(userId, inv.id), { status: "ok" });
  const row = await invoiceRow(inv.id);
  assert.equal(row.status, "cancelled");
  assert.ok(row.cancelledAt);
  const partial = await newInvoice(userId);
  await setInvoice(partial.id, { status: "partially_paid", paidAmount: 40 });
  assert.deepEqual(await cancelInvoice(userId, partial.id), { status: "ok" }, "a partly paid invoice can still be cancelled, as before");
  for (const status of ["paid", "creditor_verified"]) {
    const settled = await newInvoice(userId);
    await setInvoice(settled.id, { status, paidAmount: 100 });
    assert.deepEqual(await cancelInvoice(userId, settled.id), { status: "already_paid" });
    const after = await invoiceRow(settled.id);
    assert.equal(after.status, status, "a settled invoice keeps its status");
    assert.equal(after.cancelledAt, null);
  }
});

// ─── Public view ─────────────────────────────────────────────────────────────

test("getPublicInvoiceView returns the debtor-facing payload, flips sent to viewed once, and logs one event", async () => {
  const userId = await newUser({ terms: "Net 14 default" });
  const inv = await newInvoice(userId, { discountType: "percent", discountValue: 10, taxRate: 5, dueDate: "2026-12-31T00:00:00Z", notes: "hi" },
    [{ description: "A", quantity: 1, unitPrice: 100 }, { description: "B", quantity: 2, unitPrice: 50 }]);
  const view = await getPublicInvoiceView(inv.invoiceToken, req);
  assert.ok(view);
  assert.equal(view.id, inv.id);
  assert.equal(view.invoiceNumber, inv.invoiceNumber);
  assert.equal(view.creditorName, `user${-userId}`);
  assert.equal(view.debtorName, "Dee");
  // subtotal 200, discount 10% = 20, tax 5% of 180 = 9, total 189
  assert.equal(view.subtotal, 200);
  assert.equal(view.discountAmount, 20);
  assert.equal(view.taxAmount, 9);
  assert.equal(view.amount, 189);
  assert.equal(view.remainingAmount, 189);
  assert.equal(view.paidAmount, 0);
  assert.equal(view.terms, "Net 14 default", "falls back to the creditor's default terms");
  assert.equal(view.status, "sent", "the payload reports the status as read, as before");
  assert.equal(view.dueDate, "2026-12-31T00:00:00.000Z");
  assert.equal(typeof view.issueDate, "string");
  assert.equal((view.lineItems as any[]).length, 2);
  assert.deepEqual(view.paymentMethods, []);
  assert.equal(typeof view.payLinkQrDataUrl, "string");
  assert.equal((view.branding as any).themeColor, "#00a89f");
  await sleep(200);
  assert.equal((await invoiceRow(inv.id)).status, "viewed");
  assert.deepEqual(await eventTypes(inv.id), ["viewed"]);
  await getPublicInvoiceView(inv.invoiceToken, req); // second view: no new flip, no new event
  await sleep(200);
  assert.deepEqual(await eventTypes(inv.id), ["viewed"]);
});

test("getPublicInvoiceView returns null for an unknown token or a cancelled invoice, and does not flip other statuses", async () => {
  const userId = await newUser();
  assert.equal(await getPublicInvoiceView("nope", req), null);
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { status: "payment_submitted" });
  const view = await getPublicInvoiceView(inv.invoiceToken, req);
  assert.equal(view?.status, "payment_submitted");
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted");
  await cancelInvoice(userId, inv.id);
  assert.equal(await getPublicInvoiceView(inv.invoiceToken, req), null);
});

test("F17: viewing cannot overwrite a payment claim submitted a moment earlier", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  const view = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'payment_submitted' WHERE id = $1", [inv.id]],
  ], () => getPublicInvoiceView(inv.invoiceToken, req));
  assert.equal(view?.status, "sent", "the page was rendered from the earlier read");
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted", "the old code wrote back 'viewed'");
  await sleep(200);
  assert.deepEqual(await eventTypes(inv.id), [], "the loser of the flip logs no 'viewed' event");
});

// ─── PDFs ────────────────────────────────────────────────────────────────────

function pdfSink() {
  const out = new PassThrough() as PassThrough & { setHeader(name: string, value: string): void; headers: Record<string, string> };
  out.headers = {};
  out.setHeader = (name, value) => { out.headers[name.toLowerCase()] = value; };
  const chunks: Buffer[] = [];
  out.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => out.on("end", () => resolve(Buffer.concat(chunks))));
  return { out, done };
}

test("the creditor and public PDFs stream a real PDF, and refuse foreign, unknown and cancelled invoices", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);

  const mine = pdfSink();
  assert.equal(await streamCreditorInvoicePdf(mine.out as any, userId, inv.id), true);
  const bytes = await mine.done;
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.equal(mine.out.headers["content-type"], "application/pdf");
  assert.match(mine.out.headers["content-disposition"], new RegExp(`ayzen-invoice-${inv.invoiceNumber}\\.pdf`));

  const foreign = pdfSink();
  assert.equal(await streamCreditorInvoicePdf(foreign.out as any, other, inv.id), false);
  assert.equal(foreign.out.headers["content-type"], undefined, "nothing is written for a refused request");
  assert.equal(await streamCreditorInvoicePdf(pdfSink().out as any, userId, 987654321), false);

  const pub = pdfSink();
  assert.equal(await streamPublicInvoicePdf(pub.out as any, inv.invoiceToken), true);
  assert.equal((await pub.done).subarray(0, 5).toString(), "%PDF-");
  assert.equal(await streamPublicInvoicePdf(pdfSink().out as any, "nope"), false);
  await cancelInvoice(userId, inv.id);
  assert.equal(await streamPublicInvoicePdf(pdfSink().out as any, inv.invoiceToken), false);
});

// ─── Payment claims ──────────────────────────────────────────────────────────

const agreementsOf = (invoiceId: number) => db.select().from(financePaymentAgreementsTable).where(eq(financePaymentAgreementsTable.invoiceId, invoiceId));

test("submitInvoicePayment records the claim, moves the invoice to payment_submitted and returns the agreement link", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const res = await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", referenceId: "TX123" }, req);
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  const [agreement] = await agreementsOf(inv.id);
  assert.equal(agreement.amount, 100, "no amount means the whole remaining balance");
  assert.equal(agreement.payerUserId, payer);
  assert.equal(agreement.methodType, "bkash");
  assert.equal(agreement.referenceId, "TX123");
  assert.equal(agreement.status, "submitted");
  assert.ok(agreement.submittedAt);
  assert.equal(res.agreementToken, agreement.agreementToken);
  assert.equal(res.agreementUrl, financePaymentAgreementUrl(agreement.agreementToken));
  assert.equal((await invoiceRow(inv.id)).status, "payment_submitted");
  await sleep(250);
  assert.deepEqual(await eventTypes(inv.id), ["payment_submitted"]);
});

test("submitInvoicePayment accepts a partial amount and measures it against what is still unpaid", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { paidAmount: 60, status: "partially_paid" });
  assert.deepEqual(await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", amount: 41 }, req), { status: "exceeds_remaining", currency: "BDT", remaining: 40 });
  assert.equal((await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", amount: 40.005 }, req)).status, "ok", "the 0.01 tolerance is kept");
  // the pending 40.005 already covers what is left, so another claim is refused (see the pending-claims tests in wp6b)
  assert.deepEqual(await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "nagad", amount: 10 }, req), { status: "pending_claims", currency: "BDT", pending: 40.005, available: 0 });
  assert.deepEqual((await agreementsOf(inv.id)).map((a) => a.amount), [40.005]);
});

test("submitInvoicePayment refuses unknown, cancelled, paid and disputed invoices without writing anything", async () => {
  const userId = await newUser();
  const payer = await newUser();
  assert.deepEqual(await submitInvoicePayment(payer, "nope", { methodType: "bkash" }, req), { status: "invalid_link" });
  const inv = await newInvoice(userId);
  const expectations: Array<[string, string]> = [["cancelled", "invalid_link"], ["paid", "already_paid"], ["creditor_verified", "already_paid"], ["disputed", "disputed"]];
  for (const [status, expected] of expectations) {
    await setInvoice(inv.id, { status });
    const res = await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash" }, req);
    assert.equal(res.status, expected, status);
    assert.equal((await invoiceRow(inv.id)).status, status, "status untouched");
  }
  assert.deepEqual(await agreementsOf(inv.id), []);
});

test("F18: a zero, negative or non-numeric claim is refused and writes nothing", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  for (const amount of [0, -50, Number.NaN, "abc" as any, Number.POSITIVE_INFINITY]) {
    const res = await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", amount }, req);
    // Infinity is not finite, so it is "invalid_amount" too
    assert.equal(res.status, "invalid_amount", String(amount));
  }
  assert.deepEqual(await agreementsOf(inv.id), []);
  assert.equal((await invoiceRow(inv.id)).status, "sent");
  assert.equal((await submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", amount: "25" as any }, req)).status, "ok", "a numeric string is still accepted, as before");
});

test("F18: the claim and the status flip commit together (a failed status update leaves no orphan agreement)", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId, { debtorName: "FAIL-ME" });
  await withFailingTrigger("finance_invoices", "NEW.status = 'payment_submitted' AND NEW.debtor_name = 'FAIL-ME'", async () => {
    await assert.rejects(submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash" }, req), INJECTED);
  });
  assert.deepEqual(await agreementsOf(inv.id), [], "the agreement insert must have been rolled back");
  assert.equal((await invoiceRow(inv.id)).status, "sent");
});

test("F18: a claim cannot resurrect an invoice that was settled while the claim was waiting", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const res = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'paid', paid_amount = 100 WHERE id = $1", [inv.id]],
  ], () => submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash" }, req));
  assert.deepEqual(res, { status: "already_paid" });
  assert.equal((await invoiceRow(inv.id)).status, "paid", "the old code flipped it back to payment_submitted");
  assert.deepEqual(await agreementsOf(inv.id), []);
});

test("F18: the remaining balance is read under the lock, so a claim cannot exceed a payment verified in the meantime", async () => {
  const userId = await newUser();
  const payer = await newUser();
  const inv = await newInvoice(userId);
  const res = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'partially_paid', paid_amount = 70 WHERE id = $1", [inv.id]],
  ], () => submitInvoicePayment(payer, inv.invoiceToken, { methodType: "bkash", amount: 100 }, req));
  assert.deepEqual(res, { status: "exceeds_remaining", currency: "BDT", remaining: 30 });
  assert.deepEqual(await agreementsOf(inv.id), []);
});

// ─── Reopen ──────────────────────────────────────────────────────────────────

test("reopenInvoice moves a disputed invoice to viewed, or partially_paid when money was already verified", async () => {
  const userId = await newUser();
  const other = await newUser();
  const inv = await newInvoice(userId);
  assert.deepEqual(await reopenInvoice(userId, inv.id, req), { status: "not_disputed" });
  assert.deepEqual(await reopenInvoice(other, inv.id, req), { status: "not_found" });
  assert.deepEqual(await reopenInvoice(userId, 987654321, req), { status: "not_found" });

  await setInvoice(inv.id, { status: "disputed" });
  const a = await reopenInvoice(userId, inv.id, req);
  assert.equal(a.status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "viewed");

  await setInvoice(inv.id, { status: "disputed", paidAmount: 30 });
  const b = await reopenInvoice(userId, inv.id, req);
  assert.equal(b.status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "partially_paid");
  await sleep(200);
  assert.deepEqual(await eventTypes(inv.id), ["reopened_after_dispute", "reopened_after_dispute"]);
  assert.deepEqual(await reopenInvoice(userId, inv.id, req), { status: "not_disputed" }, "a reopened invoice cannot be reopened again");
});

test("F17: reopen cannot overwrite an invoice that was settled while the reopen was waiting", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { status: "disputed" });
  const res = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET status = 'paid', paid_amount = 100 WHERE id = $1", [inv.id]],
  ], () => reopenInvoice(userId, inv.id, req));
  assert.deepEqual(res, { status: "not_disputed" });
  const row = await invoiceRow(inv.id);
  assert.equal(row.status, "paid", "the old code wrote back 'viewed' over a paid invoice");
  await sleep(200);
  assert.deepEqual(await eventTypes(inv.id), []);
});

test("F17: reopen picks its landing status from the paid amount the database holds now", async () => {
  const userId = await newUser();
  const inv = await newInvoice(userId);
  await setInvoice(inv.id, { status: "disputed" });
  const res = await raceWithCommit(inv.id, [
    ["UPDATE finance_invoices SET paid_amount = 40 WHERE id = $1", [inv.id]],
  ], () => reopenInvoice(userId, inv.id, req));
  assert.equal(res.status, "ok");
  assert.equal((await invoiceRow(inv.id)).status, "partially_paid", "the old code used the stale paidAmount of 0 and chose 'viewed'");
});
