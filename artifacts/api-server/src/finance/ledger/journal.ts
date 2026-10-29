// Double-entry posting maps, journal posting and journal/entry cascade deletes. Moved unchanged from
// lib/finance-accounting.ts (FIN-WP-3).
import {
  db,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeAmortizationTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  type FinanceLedgerEntry,
} from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { resolveBookId } from "./books";
import { ensureSystemAccounts } from "./system-accounts";

// kind -> the two system accounts a new Finance entry auto-posts against.
const KIND_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1100", credit: "4000" }, // AR up, Income earned
  payable:    { debit: "5000", credit: "2000" }, // Expense incurred, AP up
  borrowed:   { debit: "1000", credit: "2100" }, // Cash in, Loans Payable up
  lending:    { debit: "1200", credit: "1000" }, // Loans Receivable up, Cash out
  investment: { debit: "1300", credit: "1000" }, // Investments up, Cash out
  expense:    { debit: "5000", credit: "1000" }, // Expense incurred, Cash out
  income:     { debit: "1000", credit: "4000" }, // Cash in, Income earned
};

// kind -> accounts hit when principal is repaid against an existing entry.
// 'investment' added: getting invested money back (a partial/full divestment)
// is Cash in / Investments down — the mirror of its KIND_POSTING opening
// entry, same relationship borrowed/lending already have with their own
// repayment postings. 'expense'/'income' are deliberately absent — they're
// immediate cash transactions with no "outstanding balance" concept, and are
// rejected before reaching here (see the requireRepayableKind check in
// routes/finance.ts's POST /finance/entries/:id/repayments).
const KIND_REPAYMENT_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1000", credit: "1100" }, // Cash collected, AR down
  payable:    { debit: "2000", credit: "1000" }, // AP paid down, Cash out
  borrowed:   { debit: "2100", credit: "1000" }, // Loans Payable paid down, Cash out
  lending:    { debit: "1000", credit: "1200" }, // Cash collected, Loans Receivable down
  investment: { debit: "1000", credit: "1300" }, // Cash collected, Investments down
};

// kind -> accounts hit when interest is repaid/received against an entry.
// 'investment' added: interest/dividend received on an investment is Cash
// in / Interest Income — same accounts 'lending' already uses, since both
// represent interest earned on money that's out working for you.
const KIND_INTEREST_POSTING: Record<string, { debit: string; credit: string }> = {
  borrowed: { debit: "5100", credit: "1000" }, // Interest Expense, Cash out
  lending:  { debit: "1000", credit: "4100" }, // Cash in, Interest Income
  payable:  { debit: "5100", credit: "1000" },
  receivable: { debit: "1000", credit: "4100" },
  investment: { debit: "1000", credit: "4100" }, // Cash in, Interest Income
};

// Kinds that represent an "outstanding balance" someone can pay down over
// time — the only ones POST /finance/entries/:id/repayments should accept.
// 'expense'/'income' are immediate cash transactions (fully settled the
// moment they're recorded — see KIND_POSTING above, both credit/debit Cash
// directly), so there's nothing to "repay" against them; letting a repayment
// through would silently corrupt entry.amount and the double-entry books
// since neither KIND_REPAYMENT_POSTING nor KIND_INTEREST_POSTING map them.
export const REPAYABLE_KINDS = new Set(["receivable", "payable", "borrowed", "lending", "investment"]);

/** The transaction handle passed to `db.transaction` callbacks. */
export type FinanceDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbTransaction = FinanceDbTransaction;

export interface PostJournalOptions {
  memo: string;
  date?: Date;
  lines: { accountCode: string; debit: number; credit: number }[];
  sourceLedgerEntryId?: number | null;
  isManual?: boolean;
  bookId?: number | null;
}

/**
 * Validation and account resolution shared by postJournal and postJournalInTx. Returns null (nothing
 * written) if fewer than two non-zero lines, not balanced, or any line names an account code that does
 * not exist in the book. Book and system-account seeding are idempotent and run outside any caller
 * transaction, exactly as before.
 */
async function prepareJournal(userId: number, opts: PostJournalOptions) {
  const lines = opts.lines.filter(l => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  if (lines.length < 2) return null;
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) return null;

  const resolvedBookId = await resolveBookId(userId, opts.bookId);
  const accounts = await ensureSystemAccounts(userId, resolvedBookId);
  // Reject before writing: a line whose account is missing used to be dropped silently,
  // which stored a journal whose lines no longer balanced.
  if (lines.some(l => !accounts.has(l.accountCode))) return null;
  return { lines, resolvedBookId, accounts };
}

async function insertJournal(
  tx: DbTransaction,
  userId: number,
  opts: PostJournalOptions,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareJournal>>>,
): Promise<typeof financeJournalEntriesTable.$inferSelect> {
  const { lines, resolvedBookId, accounts } = prepared;
  const [je] = await tx.insert(financeJournalEntriesTable).values({
    userId,
    bookId: resolvedBookId,
    date: opts.date ?? new Date(),
    memo: opts.memo,
    sourceLedgerEntryId: opts.sourceLedgerEntryId ?? null,
    isManual: opts.isManual ? 1 : 0,
  }).returning();

  const lineRows = lines.map(l => ({
    journalEntryId: je.id,
    accountId: accounts.get(l.accountCode)!.id, // presence checked in prepareJournal
    debit: l.debit || 0,
    credit: l.credit || 0,
    notes: null as string | null,
  }));
  await tx.insert(financeJournalLinesTable).values(lineRows);
  return je;
}

/** Post a balanced journal entry. Lines with a zero/blank amount are dropped. Returns null if not balanced or if any line names an account code that does not exist in the book (nothing is written in either case). bookId omitted resolves to the user's default book. */
export async function postJournal(
  userId: number,
  opts: PostJournalOptions,
): Promise<typeof financeJournalEntriesTable.$inferSelect | null> {
  const prepared = await prepareJournal(userId, opts);
  if (!prepared) return null;
  return db.transaction((tx) => insertJournal(tx, userId, opts, prepared));
}

/**
 * Same validation and inserts as postJournal, but inside the CALLER's transaction so the journal commits
 * or rolls back together with the caller's other writes. Returns null (nothing written) in exactly the
 * cases postJournal does; the caller decides whether that is an error.
 */
export async function postJournalInTx(
  tx: DbTransaction,
  userId: number,
  opts: PostJournalOptions,
): Promise<typeof financeJournalEntriesTable.$inferSelect | null> {
  const prepared = await prepareJournal(userId, opts);
  if (!prepared) return null;
  return insertJournal(tx, userId, opts, prepared);
}

function entryJournalOptions(entry: FinanceLedgerEntry): PostJournalOptions | null {
  const mapping = KIND_POSTING[entry.kind];
  if (!mapping || !(entry.amount > 0)) return null;
  return {
    memo: `${entry.title} (${entry.kind})`,
    date: entry.occurredDate ?? new Date(),
    lines: [
      { accountCode: mapping.debit, debit: entry.amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: entry.amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  };
}

/** Auto-post the opening journal entry for a freshly created Finance ledger entry, if its kind is mapped. */
export async function postEntryJournal(entry: FinanceLedgerEntry): Promise<void> {
  const opts = entryJournalOptions(entry);
  if (!opts) return;
  await postJournal(entry.userId, opts);
}

/**
 * Same posting as postEntryJournal inside the CALLER's transaction (FIN-WP-7, wallet bridge). Returns true when
 * the entry has nothing to post (unmapped kind or no amount) or the journal was written, false when the journal
 * could not be posted (nothing written), so the caller can roll its own writes back.
 */
export async function postEntryJournalInTx(tx: DbTransaction, entry: FinanceLedgerEntry): Promise<boolean> {
  const opts = entryJournalOptions(entry);
  if (!opts) return true;
  return (await postJournalInTx(tx, entry.userId, opts)) !== null;
}

/**
 * Post an adjustment journal for a change to an already-posted entry's
 * amount (e.g. the user corrects it via PUT /finance/entries/:id after the
 * opening entry was already posted by postEntryJournal). Uses the same
 * accounts as the opening posting (KIND_POSTING) but only for the delta —
 * NOT a delete-and-repost of the opening entry — because
 * deleteJournalForEntry removes every journal entry sourced from this
 * ledger entry, including repayment/interest postings already recorded
 * against it, which a naive repost would silently destroy.
 */
export async function postEntryAdjustmentJournal(entry: FinanceLedgerEntry, delta: number): Promise<void> {
  const mapping = KIND_POSTING[entry.kind];
  if (!mapping || Math.abs(delta) < 0.01) return;
  const amount = Math.abs(delta);
  // delta > 0 (amount went up): same debit/credit direction as the opening
  // entry. delta < 0 (amount went down): reversed, to bring both accounts
  // back down by the difference.
  const lines = delta > 0
    ? [{ accountCode: mapping.debit, debit: amount, credit: 0 }, { accountCode: mapping.credit, debit: 0, credit: amount }]
    : [{ accountCode: mapping.credit, debit: amount, credit: 0 }, { accountCode: mapping.debit, debit: 0, credit: amount }];
  await postJournal(entry.userId, {
    memo: `Adjustment — ${entry.title} (${delta > 0 ? "+" : ""}${delta.toLocaleString(undefined, { maximumFractionDigits: 2 })})`,
    date: new Date(),
    lines,
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

/** Auto-post a journal entry for a principal or interest repayment against an existing Finance entry. */
export async function postRepaymentJournal(entry: FinanceLedgerEntry, amount: number, isInterest: boolean): Promise<void> {
  const mapping = isInterest ? KIND_INTEREST_POSTING[entry.kind] : KIND_REPAYMENT_POSTING[entry.kind];
  if (!mapping || !(amount > 0)) return;
  await postJournal(entry.userId, {
    memo: `${isInterest ? "Interest" : "Repayment"} — ${entry.title}`,
    date: new Date(),
    lines: [
      { accountCode: mapping.debit, debit: amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
}

/**
 * Contra-posting for a repayment that is being reversed (a verified payment that turned out not to have been
 * received). Runs inside the caller's transaction. It only posts when this entry has a repayment journal that has not
 * been reversed yet: the original journal is posted after the verify commits and can have failed, and reversing
 * something that was never booked would corrupt the books the other way. Returns true when a reversal was posted.
 */
export async function postRepaymentReversalJournalInTx(tx: DbTransaction, entry: FinanceLedgerEntry, amount: number): Promise<boolean> {
  const mapping = KIND_REPAYMENT_POSTING[entry.kind];
  if (!mapping || !(amount > 0)) return false;
  const originalMemo = `Repayment — ${entry.title}`;
  const reversalMemo = `Reversal of repayment — ${entry.title}`;
  const countMemo = async (memo: string): Promise<number> => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(financeJournalEntriesTable)
      .where(and(eq(financeJournalEntriesTable.sourceLedgerEntryId, entry.id), eq(financeJournalEntriesTable.memo, memo)));
    return Number(row?.n ?? 0);
  };
  if ((await countMemo(originalMemo)) <= (await countMemo(reversalMemo))) return false;
  const posted = await postJournalInTx(tx, entry.userId, {
    memo: reversalMemo,
    date: new Date(),
    lines: [
      { accountCode: mapping.credit, debit: amount, credit: 0 },
      { accountCode: mapping.debit, debit: 0, credit: amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  });
  return posted !== null;
}

// kind -> accounts hit when a late fee/overdue-interest amount is *accrued*
// (added to what's owed, not yet collected) — mirrors KIND_POSTING's debit
// side (AR/AP/Loans) but credits Interest Income/Expense instead of the
// entry's normal income/expense account, same accounts KIND_INTEREST_POSTING
// uses for collection.
const KIND_LATE_FEE_ACCRUAL_POSTING: Record<string, { debit: string; credit: string }> = {
  receivable: { debit: "1100", credit: "4100" }, // AR up, Interest Income
  lending:    { debit: "1200", credit: "4100" }, // Loans Receivable up, Interest Income
  payable:    { debit: "5100", credit: "2000" }, // Interest Expense, AP up
  borrowed:   { debit: "5100", credit: "2100" }, // Interest Expense, Loans Payable up
};

function lateFeeJournalOptions(entry: FinanceLedgerEntry, amount: number): PostJournalOptions | null {
  const mapping = KIND_LATE_FEE_ACCRUAL_POSTING[entry.kind];
  if (!mapping || !(amount > 0)) return null;
  return {
    memo: `Late fee — ${entry.title}`,
    date: new Date(),
    lines: [
      { accountCode: mapping.debit, debit: amount, credit: 0 },
      { accountCode: mapping.credit, debit: 0, credit: amount },
    ],
    sourceLedgerEntryId: entry.id,
    isManual: false,
    bookId: entry.bookId,
  };
}

/** Auto-post the journal entry for a newly-accrued late fee/overdue-interest amount (finance/fees/late-fees.ts). */
export async function postLateFeeAccrualJournal(entry: FinanceLedgerEntry, amount: number): Promise<void> {
  const opts = lateFeeJournalOptions(entry, amount);
  if (!opts) return;
  await postJournal(entry.userId, opts);
}

/**
 * Same posting inside the CALLER's transaction (FIN-WP-7), so the accrual and its journal commit together. Returns
 * true when there is nothing to post (kind without a late-fee posting, or no amount) or the journal was written,
 * false when it could not be posted (nothing written).
 */
export async function postLateFeeAccrualJournalInTx(tx: DbTransaction, entry: FinanceLedgerEntry, amount: number): Promise<boolean> {
  const opts = lateFeeJournalOptions(entry, amount);
  if (!opts) return true;
  return (await postJournalInTx(tx, entry.userId, opts)) !== null;
}

/**
 * Delete the journal entries sourced from a ledger entry together with their lines. Lines and
 * headers are deleted by the SAME id set, so a journal inserted concurrently after the id
 * lookup is left whole instead of losing its header and orphaning its lines.
 */
async function deleteEntryJournals(tx: DbTransaction, entryId: number): Promise<void> {
  const rows = await tx.select({ id: financeJournalEntriesTable.id })
    .from(financeJournalEntriesTable)
    .where(eq(financeJournalEntriesTable.sourceLedgerEntryId, entryId));
  const journalIds = rows.map((row) => row.id);
  if (journalIds.length === 0) return;
  await tx.delete(financeJournalLinesTable).where(inArray(financeJournalLinesTable.journalEntryId, journalIds));
  await tx.delete(financeJournalEntriesTable).where(inArray(financeJournalEntriesTable.id, journalIds));
}

/** Delete every journal entry (and its lines) sourced from a given ledger entry — used when the entry itself is deleted. Atomic: all of it or none of it. */
export async function deleteJournalForEntry(entryId: number): Promise<void> {
  await db.transaction((tx) => deleteEntryJournals(tx, entryId));
}

/**
 * Delete a ledger entry and everything hanging off it (repayments, amortization schedule, source
 * journals and their lines) in ONE transaction, so a failure part-way cannot strip an entry of
 * its history while the entry survives. The entry must belong to `userId`; otherwise nothing is
 * deleted and `false` is returned.
 */
export async function deleteLedgerEntryCascade(entryId: number, userId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: financeLedgerEntriesTable.id })
      .from(financeLedgerEntriesTable)
      .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
    if (!owned) return false;
    await tx.delete(financeRepaymentsTable).where(eq(financeRepaymentsTable.entryId, entryId));
    await tx.delete(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, entryId));
    await deleteEntryJournals(tx, entryId);
    await tx.delete(financeLedgerEntriesTable)
      .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
    return true;
  });
}
