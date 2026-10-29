// System chart of accounts and its per-book seeding. Moved unchanged from lib/finance-accounting.ts (FIN-WP-3).
import {
  db,
  financeAccountsTable,
  type FinanceAccount,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { resolveBookId } from "./books";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export const SYSTEM_ACCOUNTS: { code: string; name: string; type: AccountType; normalBalance: "debit" | "credit" }[] = [
  { code: "1000", name: "Cash & Bank",                    type: "asset",     normalBalance: "debit" },
  { code: "1100", name: "Accounts Receivable",            type: "asset",     normalBalance: "debit" },
  { code: "1200", name: "Loans Receivable (Lending)",     type: "asset",     normalBalance: "debit" },
  { code: "1300", name: "Investments",                    type: "asset",     normalBalance: "debit" },
  { code: "1350", name: "Accumulated Depreciation",        type: "asset",     normalBalance: "credit" }, // contra-asset
  { code: "2000", name: "Accounts Payable",               type: "liability", normalBalance: "credit" },
  { code: "2100", name: "Loans Payable (Borrowed Funds)", type: "liability", normalBalance: "credit" },
  { code: "3000", name: "Owner's Equity",                 type: "equity",    normalBalance: "credit" },
  { code: "4000", name: "Income",                         type: "income",    normalBalance: "credit" },
  { code: "4100", name: "Interest Income",                type: "income",    normalBalance: "credit" },
  { code: "5000", name: "Expenses",                       type: "expense",   normalBalance: "debit" },
  { code: "5100", name: "Interest Expense",               type: "expense",   normalBalance: "debit" },
  { code: "5200", name: "Depreciation Expense",           type: "expense",   normalBalance: "debit" },
];

/** Ensure the calling user's book has every system account seeded; returns code -> account. bookId omitted resolves to the user's default book. */
export async function ensureSystemAccounts(userId: number, bookId?: number | null): Promise<Map<string, FinanceAccount>> {
  const resolvedBookId = await resolveBookId(userId, bookId);
  const existing = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)));
  const byCode = new Map(existing.map(a => [a.code, a]));
  const missing = SYSTEM_ACCOUNTS.filter(sa => !byCode.has(sa.code));
  if (missing.length > 0) {
    const inserted = await db.insert(financeAccountsTable).values(
      missing.map(sa => ({ userId, bookId: resolvedBookId, code: sa.code, name: sa.name, type: sa.type, normalBalance: sa.normalBalance, isSystem: 1 })),
    ).returning();
    for (const row of inserted) byCode.set(row.code, row);
  }
  return byCode;
}
