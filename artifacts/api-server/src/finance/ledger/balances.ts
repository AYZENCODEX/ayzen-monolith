// Account balances derived from journal lines. Moved unchanged from lib/finance-accounting.ts (FIN-WP-3).
import {
  db,
  financeAccountsTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
} from "@workspace/db";
import { eq, and, lte, gte, sql } from "drizzle-orm";
import { resolveBookId } from "./books";
import type { AccountType } from "./system-accounts";

export interface AccountBalanceRow {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

/** Sum journal lines per account for a user's book, optionally bounded by a date range. Only returns accounts with activity. bookId omitted resolves to the user's default book. */
export async function computeAccountBalances(userId: number, opts: { from?: Date; to?: Date; bookId?: number | null } = {}): Promise<AccountBalanceRow[]> {
  const resolvedBookId = await resolveBookId(userId, opts.bookId);
  const conditions = [eq(financeJournalEntriesTable.userId, userId), eq(financeJournalEntriesTable.bookId, resolvedBookId)];
  if (opts.from) conditions.push(gte(financeJournalEntriesTable.date, opts.from));
  if (opts.to) conditions.push(lte(financeJournalEntriesTable.date, opts.to));

  const sums = await db.select({
    accountId: financeJournalLinesTable.accountId,
    totalDebit: sql<number>`COALESCE(SUM(${financeJournalLinesTable.debit}), 0)`,
    totalCredit: sql<number>`COALESCE(SUM(${financeJournalLinesTable.credit}), 0)`,
  })
    .from(financeJournalLinesTable)
    .innerJoin(financeJournalEntriesTable, eq(financeJournalLinesTable.journalEntryId, financeJournalEntriesTable.id))
    .where(and(...conditions))
    .groupBy(financeJournalLinesTable.accountId);

  if (sums.length === 0) return [];
  const accounts = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const accountsById = new Map(accounts.map(a => [a.id, a]));

  return sums
    .map(s => {
      const acc = accountsById.get(s.accountId);
      if (!acc) return null;
      const totalDebit = Number(s.totalDebit) || 0;
      const totalCredit = Number(s.totalCredit) || 0;
      const balance = acc.normalBalance === "debit" ? totalDebit - totalCredit : totalCredit - totalDebit;
      const row: AccountBalanceRow = { accountId: acc.id, code: acc.code, name: acc.name, type: acc.type as AccountType, totalDebit, totalCredit, balance };
      return row;
    })
    .filter((r): r is AccountBalanceRow => !!r && (r.totalDebit > 0 || r.totalCredit > 0))
    .sort((a, b) => a.code.localeCompare(b.code));
}
