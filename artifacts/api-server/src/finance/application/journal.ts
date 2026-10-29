import { and, desc, eq, inArray } from "drizzle-orm";
import { db, financeAccountsTable, financeJournalEntriesTable, financeJournalLinesTable } from "@workspace/db";
import { postJournal } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";

// Manual journal use cases (list, read, post, delete). Moved from routes/finance.ts (FIN-WP-5a).
// The route keeps HTTP validation (memo and at least 2 lines), the PDP ownership middleware and response
// formatting (fmtJournalEntry). Messages and status mapping below are the exact ones the routes returned.
// Posting still goes through ledger/journal#postJournal, unchanged. The only logic change is F13
// (manual journal delete is one transaction, see finance-safety-findings.md).

type JournalEntryRow = typeof financeJournalEntriesTable.$inferSelect;
type JournalLineRow = typeof financeJournalLinesTable.$inferSelect;
export type JournalWithLines = { entry: JournalEntryRow; lines: JournalLineRow[] };

export interface ManualJournalInput {
  memo: string;
  date?: string;
  lines: { accountId: number; debit: number; credit: number }[];
  bookId?: number;
}

/** Entries of the caller's resolved book, newest first, each with its lines; optionally only those touching an account. */
export async function listJournal(userId: number, filter: { accountId?: number; bookId?: number } = {}): Promise<JournalWithLines[]> {
  const resolvedBookId = await resolveBookId(userId, filter.bookId);

  const entries = await db.select().from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.userId, userId), eq(financeJournalEntriesTable.bookId, resolvedBookId)))
    .orderBy(desc(financeJournalEntriesTable.date));
  const entryIds = entries.map(e => e.id);
  const lines = entryIds.length > 0
    ? await db.select().from(financeJournalLinesTable).where(inArray(financeJournalLinesTable.journalEntryId, entryIds))
    : [];
  const linesByEntry = new Map<number, JournalLineRow[]>();
  for (const l of lines) {
    if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
    linesByEntry.get(l.journalEntryId)!.push(l);
  }

  let result = entries.map(entry => ({ entry, lines: linesByEntry.get(entry.id) ?? [] }));
  if (filter.accountId !== undefined) {
    const accId = filter.accountId;
    result = result.filter(je => je.lines.some(l => l.accountId === accId));
  }
  return result;
}

/** Undefined when the entry is not this user's. */
export async function getJournalEntry(userId: number, id: number): Promise<JournalWithLines | undefined> {
  const [je] = await db.select().from(financeJournalEntriesTable)
    .where(and(eq(financeJournalEntriesTable.id, id), eq(financeJournalEntriesTable.userId, userId)));
  if (!je) return undefined;
  const lines = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, id));
  return { entry: je, lines };
}

export type CreateManualJournalResult =
  | { ok: true; entry: JournalEntryRow; lines: JournalLineRow[] }
  | { ok: false; error: string };

/** Caller must have validated that memo is non-blank and lines has at least 2 items. Every error maps to HTTP 400. */
export async function createManualJournal(userId: number, input: ManualJournalInput): Promise<CreateManualJournalResult> {
  const { memo, date, lines, bookId } = input;
  const resolvedBookId = await resolveBookId(userId, bookId);

  const accounts = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const cleanLines = lines
    .filter(l => accountsById.has(l.accountId) && ((l.debit || 0) > 0 || (l.credit || 0) > 0))
    .map(l => ({ accountCode: accountsById.get(l.accountId)!.code, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }));
  if (cleanLines.length < 2) return { ok: false, error: "At least 2 valid lines are required" };
  const totalDebit = cleanLines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = cleanLines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) return { ok: false, error: "Debit and credit must balance" };

  const je = await postJournal(userId, {
    memo: memo.trim(), date: date ? new Date(date) : new Date(), lines: cleanLines, isManual: true, bookId: resolvedBookId,
  });
  if (!je) return { ok: false, error: "Failed to post entry" };
  const savedLines = await db.select().from(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, je.id));
  return { ok: true, entry: je, lines: savedLines };
}

export type DeleteManualJournalResult = "deleted" | "not_found" | "not_manual";

/**
 * F13: the header is locked and re-checked inside one transaction, and lines and header go together
 * (before, two separate statements: a failure between them left a header with no lines).
 * "not_found" covers another user's entry (HTTP 404); "not_manual" is HTTP 400.
 */
export async function deleteManualJournal(userId: number, id: number): Promise<DeleteManualJournalResult> {
  return db.transaction(async (tx) => {
    const [je] = await tx.select().from(financeJournalEntriesTable)
      .where(and(eq(financeJournalEntriesTable.id, id), eq(financeJournalEntriesTable.userId, userId)))
      .for("update");
    if (!je) return "not_found" as const;
    if (!je.isManual) return "not_manual" as const;
    await tx.delete(financeJournalLinesTable).where(eq(financeJournalLinesTable.journalEntryId, id));
    await tx.delete(financeJournalEntriesTable)
      .where(and(eq(financeJournalEntriesTable.id, id), eq(financeJournalEntriesTable.userId, userId)));
    return "deleted" as const;
  });
}
