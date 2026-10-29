import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  financeAccountsTable,
  financeBooksTable,
  financeInvoiceEventsTable,
  financeInvoicesTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  type ChainDeposit,
} from "@workspace/db";
import { runFinanceLateFeeSweep } from "./fees/late-fees";
import { runFinanceReminderSweep } from "./jobs/reminder";
import { runFinanceInvoiceReminderSweep, type OverdueEmail } from "./jobs/invoice-reminder";
import { postDepositToFinance, postWithdrawalToFinance, repairWalletEntriesWithoutJournal } from "./integrations/wallet-bridge";

// WP-7 characterization tests for the fee, reminder and wallet-bridge code moved out of lib/finance-*-cron.ts and
// lib/finance-wallet-bridge.ts, plus the guarantees F23 to F26 (see finance-safety-findings.md). Isolated Finance test
// schema only (pnpm test:finance-db).
//
// Method (same as wp6a/wp6b): race tests do not rely on timing luck. A second connection takes a row lock and makes
// its own change, the sweep is started, the test waits until the sweep is really blocked on that lock
// (pg_stat_activity), and only then commits. Failure injection uses throwaway triggers in the isolated schema.
// Every sweep is scoped with `userIds` so a sweep never touches rows of the other test files, which run in parallel
// in the same schema. Notifications and mail are injected; nothing leaves the process.

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const testUserIds = new Set<number>();
const testWalletIds = new Set<number>();
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
        await db.delete(financeInvoicesTable).where(inArray(financeInvoicesTable.id, invoiceIds));
      }
      await pool.query("DELETE FROM finance_repayments WHERE entry_id IN (SELECT id FROM finance_ledger_entries WHERE user_id = ANY($1::int[]))", [ids]);
      await pool.query("DELETE FROM finance_journal_lines WHERE journal_entry_id IN (SELECT id FROM finance_journal_entries WHERE user_id = ANY($1::int[]))", [ids]);
      await pool.query("DELETE FROM finance_journal_entries WHERE user_id = ANY($1::int[])", [ids]);
      await db.delete(financeLedgerEntriesTable).where(inArray(financeLedgerEntriesTable.userId, ids));
      await db.delete(financeAccountsTable).where(inArray(financeAccountsTable.userId, ids));
      await db.delete(financeBooksTable).where(inArray(financeBooksTable.userId, ids));
      await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    }
    if (testWalletIds.size) await pool.query("DELETE FROM wallets WHERE id = ANY($1::int[])", [[...testWalletIds]]);
  } finally {
    await pool.end();
  }
});

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entryRow = async (id: number) => (await db.select().from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.id, id)))[0];
const invoiceRow = async (id: number) => (await db.select().from(financeInvoicesTable).where(eq(financeInvoicesTable.id, id)))[0];
const eventTypes = async (invoiceId: number) =>
  (await db.select().from(financeInvoiceEventsTable).where(eq(financeInvoiceEventsTable.invoiceId, invoiceId))).map((e) => e.eventType).sort();

async function newUser(): Promise<number> {
  const id = nextTestUserId();
  await pool.query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)", [id, `user${-id}`, `user${-id}@test.local`]);
  return id;
}

async function newEntry(userId: number, over: Partial<typeof financeLedgerEntriesTable.$inferInsert> = {}) {
  const [entry] = await db.insert(financeLedgerEntriesTable).values({
    userId, kind: "receivable", title: "Loan to Sam", amount: 1000, currency: "BDT", status: "pending", ...over,
  }).returning();
  return entry;
}

/** The journal lines posted for a ledger entry as "code:debit:credit" strings, sorted. */
async function journalOf(entryId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT a.code, l.debit, l.credit FROM finance_journal_lines l
       JOIN finance_journal_entries j ON j.id = l.journal_entry_id
       JOIN finance_accounts a ON a.id = l.account_id
      WHERE j.source_ledger_entry_id = $1`, [entryId]);
  return rows.map((r) => `${r.code}:${Number(r.debit)}:${Number(r.credit)}`).sort();
}
const journalCount = async (entryId: number) =>
  Number((await pool.query("SELECT count(*)::int AS n FROM finance_journal_entries WHERE source_ledger_entry_id = $1", [entryId])).rows[0].n);

/** Holds a row lock on a second connection and applies `statements` inside that transaction. */
async function holdLock(lockSql: string, lockParams: any[], statements: Array<[string, any[]]>) {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query(lockSql, lockParams);
  for (const [text, params] of statements) await client.query(text, params);
  return { async commit() { await client.query("COMMIT"); client.release(); } };
}
const holdEntry = (entryId: number, statements: Array<[string, any[]]>) =>
  holdLock("SELECT id FROM finance_ledger_entries WHERE id = $1 FOR UPDATE", [entryId], statements);
const holdInvoice = (invoiceId: number, statements: Array<[string, any[]]>) =>
  holdLock("SELECT id FROM finance_invoices WHERE id = $1 FOR UPDATE", [invoiceId], statements);

async function waitUntilBlocked(table: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE $1",
      [`%${table}%`],
    );
    if (rows[0].n > 0) return;
    await sleep(30);
  }
  throw new Error("the sweep never blocked on the row lock; the interleaving was not exercised");
}
async function raceWithCommit<T>(held: { commit(): Promise<void> }, table: string, run: () => Promise<T>): Promise<T> {
  const pending = run();
  pending.catch(() => {});
  await waitUntilBlocked(table);
  await held.commit();
  return pending;
}

async function withFailingTrigger<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
  const name = `wp7_boom_${randomInt(1, 1_000_000)}`;
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  try {
    return await fn();
  } finally {
    await pool.query(`DROP TRIGGER ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION ${name}()`);
  }
}

type Notice = { userId: number; type: string; title: string; message: string; data?: Record<string, unknown> };
function recorder(failFor?: (n: Notice) => boolean) {
  const sent: Notice[] = [];
  const notify = async (userId: number, type: string, title: string, message: string, data?: Record<string, unknown>) => {
    const n = { userId, type, title, message, data };
    if (failFor?.(n)) throw new Error("notify down");
    sent.push(n);
  };
  return { sent, notify };
}

// ───────────────────────────── late fees (F23) ─────────────────────────────

test("flat late fee: charged once, booked as Dr AR / Cr Interest income, entry flips to overdue, owner notified", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "flat", lateFeeRate: 25 });
  const n = recorder();

  assert.deepEqual(await runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify }), { checked: 1, accrued: 1 });
  const after1 = await entryRow(e.id);
  assert.equal(after1.amount, 1025);
  assert.equal(after1.lateFeeAccrued, 25);
  assert.equal(after1.status, "overdue");
  assert.ok(after1.lateFeeLastCalcAt);
  assert.deepEqual(await journalOf(e.id), ["1100:25:0", "4100:0:25"]);
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].type, "finance_late_fee");
  assert.equal(n.sent[0].data?.entryId, e.id);

  assert.deepEqual(await runFinanceLateFeeSweep({ now: new Date(now.getTime() + DAY), userIds: [u], notify: n.notify }), { checked: 1, accrued: 0 });
  assert.equal((await entryRow(e.id)).amount, 1025, "a flat fee is never charged twice");
  assert.equal(await journalCount(e.id), 1);
});

test("an entry still inside its grace period, a settled entry and another user's entry are left alone", async () => {
  const u = await newUser();
  const other = await newUser();
  const now = new Date();
  const graced = await newEntry(u, { dueDate: new Date(now.getTime() - 2 * DAY), lateFeeType: "flat", lateFeeRate: 10, lateFeeGraceDays: 5 });
  const paid = await newEntry(u, { dueDate: new Date(now.getTime() - 20 * DAY), lateFeeType: "flat", lateFeeRate: 10, status: "paid" });
  const closed = await newEntry(u, { dueDate: new Date(now.getTime() - 20 * DAY), lateFeeType: "flat", lateFeeRate: 10, status: "closed" });
  const foreign = await newEntry(other, { dueDate: new Date(now.getTime() - 20 * DAY), lateFeeType: "flat", lateFeeRate: 10 });
  const result = await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify });
  assert.deepEqual(result, { checked: 1, accrued: 0 }, "paid and closed are not even candidates");
  for (const entry of [graced, paid, closed, foreign]) {
    const row = await entryRow(entry.id);
    assert.equal(row.amount, 1000);
    assert.equal(row.lateFeeAccrued, 0);
    assert.equal(row.status, entry.status);
  }
});

test("daily percent is charged on the ORIGINAL principal, repaid principal added back, interest repayments ignored", async () => {
  const u = await newUser();
  const now = new Date();
  // 400 of principal and 30 of interest repaid: outstanding amount is 600, the original principal was 1000.
  const e = await newEntry(u, { amount: 600, status: "partial", dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "daily_percent", lateFeeRate: 1 });
  await db.insert(financeRepaymentsTable).values([{ entryId: e.id, amount: 400, isInterest: 0 }, { entryId: e.id, amount: 30, isInterest: 1 }]);
  await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify });
  const row = await entryRow(e.id);
  assert.ok(Math.abs(row.lateFeeAccrued - 100) < 1e-6, `fee ${row.lateFeeAccrued} should be 1% of 1000 for 10 days`);
  assert.ok(Math.abs(row.amount - 700) < 1e-6);
  assert.equal(row.status, "partial", "a partly repaid entry keeps its status");
  assert.deepEqual(await journalOf(e.id), [`1100:${row.lateFeeAccrued}:0`, `4100:0:${row.lateFeeAccrued}`]);
});

test("monthly percent is prorated daily and the next sweep only charges the days since the last one", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 30 * DAY), lateFeeType: "monthly_percent", lateFeeRate: 3, kind: "payable" });
  await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify });
  const first = await entryRow(e.id);
  assert.ok(Math.abs(first.lateFeeAccrued - 30) < 1e-6, "3% of 1000 for one 30-day period");
  assert.deepEqual(await journalOf(e.id), ["2000:0:30", "5100:30:0"], "a payable books Interest expense / AP");

  await runFinanceLateFeeSweep({ now: new Date(now.getTime() + 15 * DAY), userIds: [u], notify: recorder().notify });
  const second = await entryRow(e.id);
  // base is the original principal (amount - lateFeeAccrued = 1000), for the 15 days since the first sweep
  assert.ok(Math.abs(second.lateFeeAccrued - 45) < 1e-6, `accrued ${second.lateFeeAccrued}`);
  assert.equal(await journalCount(e.id), 2);
});

test("a percentage fee is rounded to whole cents, in the entry and in the journal", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { amount: 333.33, dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "daily_percent", lateFeeRate: 1 });
  await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify });
  const row = await entryRow(e.id);
  assert.equal(row.lateFeeAccrued, 33.33);
  assert.deepEqual(await journalOf(e.id), ["1100:33.33:0", "4100:0:33.33"]);
});

test("a fee that rounds to a cent or less is not charged and the period keeps accumulating", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { amount: 100, dueDate: new Date(now.getTime() - DAY), lateFeeType: "daily_percent", lateFeeRate: 0.005 }); // 0.005 per day
  assert.equal((await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify })).accrued, 0);
  assert.equal((await entryRow(e.id)).lateFeeLastCalcAt, null, "the timestamp did not advance, nothing is lost");
  assert.equal((await runFinanceLateFeeSweep({ now: new Date(now.getTime() + 9 * DAY), userIds: [u], notify: recorder().notify })).accrued, 1, "10 days = 0.05, now it counts");
  assert.equal((await entryRow(e.id)).lateFeeAccrued, 0.05);
});

test("a kind with no late-fee posting still accrues, with no journal", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { kind: "expense", dueDate: new Date(now.getTime() - 3 * DAY), lateFeeType: "flat", lateFeeRate: 10 });
  assert.equal((await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify })).accrued, 1);
  assert.equal((await entryRow(e.id)).lateFeeAccrued, 10);
  assert.equal(await journalCount(e.id), 0);
});

test("a fee under one cent only flips pending to overdue", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { amount: 1, dueDate: new Date(now.getTime() - DAY), lateFeeType: "daily_percent", lateFeeRate: 0.0001 });
  assert.deepEqual(await runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify }), { checked: 1, accrued: 0 });
  const row = await entryRow(e.id);
  assert.equal(row.status, "overdue");
  assert.equal(row.amount, 1);
  assert.equal(row.lateFeeLastCalcAt, null);
});

test("the pending to overdue flip does not overwrite a status written after the read (F23)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { amount: 1, dueDate: new Date(now.getTime() - DAY), lateFeeType: "daily_percent", lateFeeRate: 0.0001 });
  const held = await holdEntry(e.id, [["UPDATE finance_ledger_entries SET status = 'paid' WHERE id = $1", [e.id]]]);
  await raceWithCommit(held, "finance_ledger_entries", () => runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify }));
  assert.equal((await entryRow(e.id)).status, "paid", "the settled status wins");
});

test("an entry settled between the sweep's read and its write is not charged (F23)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "flat", lateFeeRate: 25 });
  const held = await holdEntry(e.id, [["UPDATE finance_ledger_entries SET status = 'paid', amount = 0 WHERE id = $1", [e.id]]]);
  const n = recorder();
  const result = await raceWithCommit(held, "finance_ledger_entries", () => runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify }));
  assert.equal(result.accrued, 0);
  const row = await entryRow(e.id);
  assert.equal(row.amount, 0, "the settled entry did not grow");
  assert.equal(row.lateFeeAccrued, 0);
  assert.equal(await journalCount(e.id), 0);
  assert.equal(n.sent.length, 0);
});

test("a period another sweep already charged is not charged again (F23)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "flat", lateFeeRate: 25 });
  const other = new Date(now.getTime() - 1000);
  const held = await holdEntry(e.id, [[
    "UPDATE finance_ledger_entries SET amount = amount + 25, late_fee_accrued = 25, late_fee_last_calc_at = $2, status = 'overdue' WHERE id = $1", [e.id, other],
  ]]);
  const n = recorder();
  const result = await raceWithCommit(held, "finance_ledger_entries", () => runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify }));
  assert.equal(result.accrued, 0, "the claim lost");
  const row = await entryRow(e.id);
  assert.equal(row.amount, 1025, "charged once, by the other sweep");
  assert.equal(row.lateFeeAccrued, 25);
  assert.equal(await journalCount(e.id), 0, "this sweep booked nothing");
  assert.equal(n.sent.length, 0);
});

test("two sweeps started together charge a period once", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "daily_percent", lateFeeRate: 1 });
  const results = await Promise.all([
    runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify }),
    runFinanceLateFeeSweep({ now, userIds: [u], notify: recorder().notify }),
  ]);
  assert.equal(results[0].accrued + results[1].accrued, 1);
  const row = await entryRow(e.id);
  assert.ok(Math.abs(row.lateFeeAccrued - 100) < 1e-6);
  assert.equal(await journalCount(e.id), 1);
});

test("a journal that cannot be posted rolls the accrual back, and the next sweep charges the whole period (F23)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { title: "WP7BOOM loan", dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "flat", lateFeeRate: 25 });
  const n = recorder();
  await withFailingTrigger("finance_journal_entries", "NEW.memo LIKE 'Late fee — WP7BOOM%'", async () => {
    const result = await runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify });
    assert.deepEqual(result, { checked: 1, accrued: 0 });
  });
  const row = await entryRow(e.id);
  assert.equal(row.amount, 1000, "the entry did not grow");
  assert.equal(row.lateFeeAccrued, 0);
  assert.equal(row.lateFeeLastCalcAt, null, "so the retry covers the same period");
  assert.equal(row.status, "pending");
  assert.equal(await journalCount(e.id), 0);
  assert.equal(n.sent.length, 0);

  assert.equal((await runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify })).accrued, 1);
  assert.equal((await entryRow(e.id)).amount, 1025);
  assert.equal(await journalCount(e.id), 1);
});

test("a failing notification does not undo or hide a committed fee", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 10 * DAY), lateFeeType: "flat", lateFeeRate: 25 });
  const n = recorder(() => true);
  assert.deepEqual(await runFinanceLateFeeSweep({ now, userIds: [u], notify: n.notify }), { checked: 1, accrued: 1 });
  assert.equal((await entryRow(e.id)).amount, 1025);
});

// ───────────────────────────── due-date reminders (F24) ─────────────────────────────

test("an entry due within three days is reminded once", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { kind: "payable", title: "Rent", dueDate: new Date(now.getTime() + 2 * DAY - 1000) });
  const soon = await newEntry(u, { title: "Far", dueDate: new Date(now.getTime() + 5 * DAY) });
  const paid = await newEntry(u, { title: "Done", dueDate: new Date(now.getTime() + DAY), status: "paid" });
  const already = await newEntry(u, { title: "Told", dueDate: new Date(now.getTime() + DAY), remindedAt: new Date(now.getTime() - DAY) });
  const n = recorder();

  assert.deepEqual(await runFinanceReminderSweep({ now, userIds: [u], notify: n.notify }), { entriesChecked: 1, remindersSent: 1 });
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].type, "finance_reminder");
  assert.match(n.sent[0].title, /Rent — 2d/);
  assert.match(n.sent[0].message, /dite hobe/, "a payable is phrased as owed");
  assert.ok((await entryRow(e.id)).remindedAt);
  for (const untouched of [soon, paid]) assert.equal((await entryRow(untouched.id)).remindedAt, null);
  assert.equal((await entryRow(already.id)).remindedAt!.getTime(), already.remindedAt!.getTime());

  assert.deepEqual(await runFinanceReminderSweep({ now, userIds: [u], notify: n.notify }), { entriesChecked: 0, remindersSent: 0 });
  assert.equal(n.sent.length, 1, "once per due date");
});

test("a reminder is sent for an already overdue entry and phrased as due today", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() - 2 * DAY) });
  const n = recorder();
  await runFinanceReminderSweep({ now, userIds: [u], notify: n.notify });
  assert.match(n.sent[0].title, /today/);
  assert.match(n.sent[0].message, /pabe today/);
  assert.ok((await entryRow(e.id)).remindedAt);
});

test("an entry another sweep already reminded is not reminded again (F24)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() + DAY) });
  const held = await holdEntry(e.id, [["UPDATE finance_ledger_entries SET reminded_at = now() WHERE id = $1", [e.id]]]);
  const n = recorder();
  const result = await raceWithCommit(held, "finance_ledger_entries", () => runFinanceReminderSweep({ now, userIds: [u], notify: n.notify }));
  assert.equal(result.remindersSent, 0);
  assert.equal(n.sent.length, 0);
});

test("an entry whose due date moved after the read is not claimed (F24)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() + DAY) });
  const later = new Date(now.getTime() + 30 * DAY);
  const held = await holdEntry(e.id, [["UPDATE finance_ledger_entries SET due_date = $2, reminded_at = NULL WHERE id = $1", [e.id, later]]]);
  const n = recorder();
  const result = await raceWithCommit(held, "finance_ledger_entries", () => runFinanceReminderSweep({ now, userIds: [u], notify: n.notify }));
  assert.equal(result.remindersSent, 0);
  assert.equal(n.sent.length, 0);
  assert.equal((await entryRow(e.id)).remindedAt, null, "re-armed for the new due date");
});

test("a settled entry is not reminded (F24)", async () => {
  const u = await newUser();
  const now = new Date();
  const e = await newEntry(u, { dueDate: new Date(now.getTime() + DAY) });
  const held = await holdEntry(e.id, [["UPDATE finance_ledger_entries SET status = 'paid' WHERE id = $1", [e.id]]]);
  const n = recorder();
  await raceWithCommit(held, "finance_ledger_entries", () => runFinanceReminderSweep({ now, userIds: [u], notify: n.notify }));
  assert.equal(n.sent.length, 0);
  assert.equal((await entryRow(e.id)).remindedAt, null);
});

test("a notification that throws releases the claim, does not stop the other entries, and is retried (F24)", async () => {
  const u = await newUser();
  const now = new Date();
  const bad = await newEntry(u, { title: "Bad", dueDate: new Date(now.getTime() + DAY) });
  const good = await newEntry(u, { title: "Good", dueDate: new Date(now.getTime() + DAY) });
  const down = recorder((x) => x.data?.entryId === bad.id);
  const first = await runFinanceReminderSweep({ now, userIds: [u], notify: down.notify });
  assert.deepEqual(first, { entriesChecked: 2, remindersSent: 1 });
  assert.equal((await entryRow(bad.id)).remindedAt, null, "claim released");
  assert.ok((await entryRow(good.id)).remindedAt);

  const up = recorder();
  assert.deepEqual(await runFinanceReminderSweep({ now, userIds: [u], notify: up.notify }), { entriesChecked: 1, remindersSent: 1 });
  assert.equal(up.sent[0].data?.entryId, bad.id);
});

test("the reminder sweep only touches the scoped users", async () => {
  const u = await newUser();
  const other = await newUser();
  const now = new Date();
  const mine = await newEntry(u, { dueDate: new Date(now.getTime() + DAY) });
  const theirs = await newEntry(other, { dueDate: new Date(now.getTime() + DAY) });
  await runFinanceReminderSweep({ now, userIds: [u], notify: recorder().notify });
  assert.ok((await entryRow(mine.id)).remindedAt);
  assert.equal((await entryRow(theirs.id)).remindedAt, null);
});

// ───────────────────────────── overdue invoice reminders (F25) ─────────────────────────────

let tokenSeq = 0;
async function newInvoice(userId: number, over: Partial<typeof financeInvoicesTable.$inferInsert> = {}) {
  const [invoice] = await db.insert(financeInvoicesTable).values({
    userId, debtorName: "Dee", debtorEmail: "dee@test.local", amount: 100, currency: "BDT", status: "sent",
    invoiceToken: `wp7-${Date.now()}-${++tokenSeq}-${randomInt(1, 1_000_000)}`,
    dueDate: new Date(Date.now() - 5 * DAY), ...over,
  }).returning();
  return invoice;
}
function senders(opts: { emailOk?: boolean; emailThrows?: boolean; telegramThrows?: boolean } = {}) {
  const emails: Array<{ to: string; data: OverdueEmail }> = [];
  const telegrams: Array<{ chatId: string; text: string; url: string }> = [];
  return {
    emails, telegrams,
    sendEmail: async (to: string, data: OverdueEmail) => {
      if (opts.emailThrows) throw new Error("smtp down");
      emails.push({ to, data });
      return { success: opts.emailOk ?? true };
    },
    sendTelegram: async (chatId: string, text: string, _label: string, url: string) => {
      if (opts.telegramThrows) throw new Error("telegram down");
      telegrams.push({ chatId, text, url });
    },
  };
}

test("an overdue invoice is nudged by email and Telegram, then again only after the interval", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u, { debtorTelegramChatId: "12345", paidAmount: 40 });
  const s = senders();

  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }), { checked: 1, sent: 1 });
  assert.equal(s.emails.length, 1);
  assert.equal(s.emails[0].to, "dee@test.local");
  assert.equal(s.emails[0].data.creditorName, `user${-u}`);
  assert.equal(s.emails[0].data.remainingAmount, "BDT 60");
  assert.equal(s.emails[0].data.daysOverdue, 5);
  assert.match(s.emails[0].data.url, /\/finance\/invoice\//);
  assert.equal(s.telegrams.length, 1);
  assert.equal(s.telegrams[0].chatId, "12345");
  let row = await invoiceRow(inv.id);
  assert.equal(row.reminderCount, 1);
  assert.equal(row.lastReminderAt!.getTime(), now.getTime());
  await sleep(100);
  assert.ok((await eventTypes(inv.id)).includes("overdue_reminder_sent"));

  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now: new Date(now.getTime() + DAY), userIds: [u], ...s }), { checked: 0, sent: 0 });
  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now: new Date(now.getTime() + 4 * DAY), userIds: [u], ...s }), { checked: 1, sent: 1 });
  row = await invoiceRow(inv.id);
  assert.equal(row.reminderCount, 2);
});

test("settled, cancelled, disputed, awaiting-review and not-yet-due invoices are not nudged", async () => {
  const u = await newUser();
  const now = new Date();
  const ids: number[] = [];
  for (const status of ["paid", "settled", "cancelled", "void", "disputed", "creditor_verified", "payment_submitted", "agreement_confirmed"]) ids.push((await newInvoice(u, { status })).id);
  ids.push((await newInvoice(u, { dueDate: new Date(now.getTime() + DAY) })).id);
  const s = senders();
  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }), { checked: 0, sent: 0 });
  assert.equal(s.emails.length + s.telegrams.length, 0);
  for (const id of ids) assert.equal((await invoiceRow(id)).reminderCount, 0);
});

test("a partly paid invoice is still nudged, and it is nudged again once a claim is disputed back to it", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u, { status: "partially_paid", paidAmount: 30 });
  const s = senders();
  assert.equal((await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s })).sent, 1);
  assert.equal(s.emails[0].data.remainingAmount, "BDT 70");
  await db.update(financeInvoicesTable).set({ status: "payment_submitted", lastReminderAt: null }).where(eq(financeInvoicesTable.id, inv.id));
  assert.equal((await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s })).checked, 0, "waiting for review: no nudge");
  await db.update(financeInvoicesTable).set({ status: "partially_paid" }).where(eq(financeInvoicesTable.id, inv.id));
  assert.equal((await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s })).sent, 1, "back to partially paid after the review: nudged again");
});

test("an invoice nobody could be reached for keeps its claim free and is retried once contact details exist (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u, { debtorEmail: null, debtorTelegramChatId: null });
  const s = senders();
  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }), { checked: 1, sent: 0 });
  let row = await invoiceRow(inv.id);
  assert.equal(row.reminderCount, 0);
  assert.equal(row.lastReminderAt, null);

  await db.update(financeInvoicesTable).set({ debtorEmail: "late@test.local" }).where(eq(financeInvoicesTable.id, inv.id));
  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }), { checked: 1, sent: 1 });
  row = await invoiceRow(inv.id);
  assert.equal(row.reminderCount, 1);
});

test("a failed email restores the claim (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u);
  assert.deepEqual(await runFinanceInvoiceReminderSweep({ now, userIds: [u], ...senders({ emailOk: false }) }), { checked: 1, sent: 0 });
  const row = await invoiceRow(inv.id);
  assert.equal(row.reminderCount, 0);
  assert.equal(row.lastReminderAt, null);
  assert.deepEqual(await eventTypes(inv.id), []);
});

test("a sender that throws restores the claim and does not stop the other invoices (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const bad = await newInvoice(u, { debtorEmail: "bad@test.local" });
  const good = await newInvoice(u, { debtorEmail: "good@test.local" });
  let calls = 0;
  const s = senders();
  const flaky = async (to: string, data: OverdueEmail) => {
    calls++;
    if (to === "bad@test.local") throw new Error("smtp down");
    return s.sendEmail(to, data);
  };
  const result = await runFinanceInvoiceReminderSweep({ now, userIds: [u], sendEmail: flaky, sendTelegram: s.sendTelegram });
  assert.deepEqual(result, { checked: 2, sent: 1 });
  assert.equal(calls, 2);
  assert.equal((await invoiceRow(bad.id)).reminderCount, 0);
  assert.equal((await invoiceRow(bad.id)).lastReminderAt, null);
  assert.equal((await invoiceRow(good.id)).reminderCount, 1);
});

test("an invoice another sweep already nudged is not nudged again (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u);
  const held = await holdInvoice(inv.id, [["UPDATE finance_invoices SET last_reminder_at = $2, reminder_count = reminder_count + 1 WHERE id = $1", [inv.id, now]]]);
  const s = senders();
  const result = await raceWithCommit(held, "finance_invoices", () => runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }));
  assert.equal(result.sent, 0);
  assert.equal(s.emails.length, 0, "nothing was sent twice");
  assert.equal((await invoiceRow(inv.id)).reminderCount, 1, "the other sweep's claim is untouched");
});

test("an invoice settled after the read is not nudged (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u);
  const held = await holdInvoice(inv.id, [["UPDATE finance_invoices SET status = 'paid' WHERE id = $1", [inv.id]]]);
  const s = senders();
  await raceWithCommit(held, "finance_invoices", () => runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }));
  assert.equal(s.emails.length, 0);
  assert.equal((await invoiceRow(inv.id)).reminderCount, 0);
});

test("two invoice sweeps started together nudge the debtor once (F25)", async () => {
  const u = await newUser();
  const now = new Date();
  const inv = await newInvoice(u);
  const s = senders();
  await Promise.all([
    runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }),
    runFinanceInvoiceReminderSweep({ now, userIds: [u], ...s }),
  ]);
  assert.equal(s.emails.length, 1);
  assert.equal((await invoiceRow(inv.id)).reminderCount, 1);
});

// ───────────────────────────── wallet bridge (F26) ─────────────────────────────

async function newWallet(autoFinanceSync?: boolean): Promise<number> {
  const { rows } = await pool.query(
    autoFinanceSync === undefined
      ? "INSERT INTO wallets DEFAULT VALUES RETURNING id"
      : "INSERT INTO wallets (auto_finance_sync) VALUES ($1) RETURNING id",
    autoFinanceSync === undefined ? [] : [autoFinanceSync],
  );
  testWalletIds.add(rows[0].id);
  return rows[0].id as number;
}
let depositSeq = 0;
function deposit(userId: number, walletId: number, over: Partial<ChainDeposit> = {}): ChainDeposit {
  return {
    id: -randomInt(1, 2_000_000_000), userId, walletId, chain: "ETH", tokenSymbol: "USDT", tokenContract: null, amount: 250,
    fromAddress: "0xfrom", toAddress: "0xto", txHash: `0xdep${Date.now()}${++depositSeq}`, logIndex: -1, blockNumber: 1,
    confirmations: 12, status: "confirmed", credited: true, createdAt: new Date(), confirmedAt: new Date(), ...over,
  } as ChainDeposit;
}
const entriesBy = (column: "source_chain_deposit_id" | "source_wallet_tx_hash", value: number | string) =>
  pool.query(`SELECT * FROM finance_ledger_entries WHERE ${column} = $1`, [value]).then((r) => r.rows);

test("a confirmed deposit becomes a visible income entry with a balanced journal, once", async () => {
  const u = await newUser();
  const w = await newWallet();
  const dep = deposit(u, w);
  await postDepositToFinance(dep);
  const rows = await entriesBy("source_chain_deposit_id", dep.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "income");
  assert.equal(rows[0].status, "paid");
  assert.equal(rows[0].category, "Wallet Deposit");
  assert.equal(rows[0].currency, "USDT");
  assert.equal(Number(rows[0].amount), 250);
  assert.ok(rows[0].book_id, "a concrete book, so the entry is visible in the Finance UI");
  assert.deepEqual(await journalOf(rows[0].id), ["1000:250:0", "4000:0:250"]);

  await postDepositToFinance(dep); // a retried credit
  assert.equal((await entriesBy("source_chain_deposit_id", dep.id)).length, 1);
  assert.equal(await journalCount(rows[0].id), 1);
});

test("a wallet with finance sync switched off posts nothing; a wallet row that cannot be found defaults to on", async () => {
  const u = await newUser();
  const off = await newWallet(false);
  const depOff = deposit(u, off);
  await postDepositToFinance(depOff);
  assert.equal((await entriesBy("source_chain_deposit_id", depOff.id)).length, 0);

  const depMissing = deposit(u, -randomInt(1, 2_000_000_000));
  await postDepositToFinance(depMissing);
  assert.equal((await entriesBy("source_chain_deposit_id", depMissing.id)).length, 1);
});

test("a withdrawal becomes an expense entry with a balanced journal, once", async () => {
  const u = await newUser();
  const w = await newWallet(true);
  const txHash = `0xwd${Date.now()}${++depositSeq}`;
  const opts = { userId: u, walletId: w, chain: "BSC", symbol: "BNB", amount: 1.5, to: "0xdest", txHash };
  await postWithdrawalToFinance(opts);
  const rows = await entriesBy("source_wallet_tx_hash", txHash);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "expense");
  assert.equal(rows[0].category, "Wallet Withdrawal");
  assert.ok(rows[0].book_id);
  assert.deepEqual(await journalOf(rows[0].id), ["1000:0:1.5", "5000:1.5:0"]);

  await postWithdrawalToFinance(opts);
  assert.equal((await entriesBy("source_wallet_tx_hash", txHash)).length, 1);
});

test("a journal that cannot be posted leaves no half-recorded deposit, and the retry records it whole (F26)", async () => {
  const u = await newUser();
  const w = await newWallet();
  const dep = deposit(u, w, { tokenSymbol: "WP7BOOM" });
  await withFailingTrigger("finance_journal_entries", "NEW.memo LIKE 'WP7BOOM deposit%'", async () => {
    await postDepositToFinance(dep); // best effort: swallowed, as before
  });
  assert.equal((await entriesBy("source_chain_deposit_id", dep.id)).length, 0, "the entry rolled back with its journal");

  await postDepositToFinance(dep);
  const rows = await entriesBy("source_chain_deposit_id", dep.id);
  assert.equal(rows.length, 1, "not blocked by the unique index");
  assert.deepEqual(await journalOf(rows[0].id), ["1000:250:0", "4000:0:250"]);
});

test("a journal that cannot be posted leaves no half-recorded withdrawal either (F26)", async () => {
  const u = await newUser();
  const w = await newWallet();
  const txHash = `0xwdboom${Date.now()}${++depositSeq}`;
  const opts = { userId: u, walletId: w, chain: "ETH", symbol: "WP7BOOM", amount: 3, to: "0xdest", txHash };
  await withFailingTrigger("finance_journal_entries", "NEW.memo LIKE 'WP7BOOM withdrawal%'", async () => {
    await postWithdrawalToFinance(opts);
  });
  assert.equal((await entriesBy("source_wallet_tx_hash", txHash)).length, 0);
  await postWithdrawalToFinance(opts);
  const rows = await entriesBy("source_wallet_tx_hash", txHash);
  assert.equal(rows.length, 1);
  assert.equal(await journalCount(rows[0].id), 1);
});

test("repair journals wallet entries the old bridge left without a journal, once, and touches nothing else (F26)", async () => {
  const u = await newUser();
  const other = await newUser();
  const now = new Date();
  // What the legacy bridge could leave behind: entries with a source id and no journal.
  const orphanDeposit = await newEntry(u, { kind: "income", title: "USDT deposit — ETH", amount: 80, status: "paid", sourceChainDepositId: -randomInt(1, 2_000_000_000), occurredDate: now });
  const orphanWithdrawal = await newEntry(u, { kind: "expense", title: "BNB withdrawal — BSC", amount: 2.5, status: "paid", sourceWalletTxHash: `0xorph${Date.now()}${++depositSeq}`, occurredDate: now });
  const journaled = await newEntry(u, { kind: "income", title: "USDT deposit — ETH", amount: 10, status: "paid", sourceChainDepositId: -randomInt(1, 2_000_000_000) });
  const manual = await newEntry(u, { kind: "income", title: "Salary", amount: 500, status: "paid" }); // no wallet source: not ours
  const foreign = await newEntry(other, { kind: "income", title: "USDT deposit — ETH", amount: 5, status: "paid", sourceChainDepositId: -randomInt(1, 2_000_000_000) });
  await db.transaction(async (tx) => { const { postEntryJournalInTx } = await import("./ledger/journal"); assert.ok(await postEntryJournalInTx(tx, journaled)); });

  assert.deepEqual(await repairWalletEntriesWithoutJournal({ userIds: [u] }), { checked: 2, repaired: 2, failed: 0 });
  assert.deepEqual(await journalOf(orphanDeposit.id), ["1000:80:0", "4000:0:80"]);
  assert.deepEqual(await journalOf(orphanWithdrawal.id), ["1000:0:2.5", "5000:2.5:0"]);
  assert.equal(await journalCount(journaled.id), 1, "an already journaled entry is not doubled");
  assert.equal(await journalCount(manual.id), 0, "a non-wallet entry is not touched");
  assert.equal(await journalCount(foreign.id), 0, "out of scope");

  assert.deepEqual(await repairWalletEntriesWithoutJournal({ userIds: [u] }), { checked: 0, repaired: 0, failed: 0 }, "re-run is a no-op");
});

test("repair reports an entry it cannot journal and leaves it alone (F26)", async () => {
  const u = await newUser();
  const e = await newEntry(u, { kind: "income", title: "WP7BOOM deposit — ETH", amount: 9, status: "paid", sourceChainDepositId: -randomInt(1, 2_000_000_000) });
  await withFailingTrigger("finance_journal_entries", "NEW.memo LIKE 'WP7BOOM deposit%'", async () => {
    assert.deepEqual(await repairWalletEntriesWithoutJournal({ userIds: [u] }), { checked: 1, repaired: 0, failed: 1 });
  });
  assert.equal(await journalCount(e.id), 0);
  assert.deepEqual(await repairWalletEntriesWithoutJournal({ userIds: [u] }), { checked: 1, repaired: 1, failed: 0 });
});
