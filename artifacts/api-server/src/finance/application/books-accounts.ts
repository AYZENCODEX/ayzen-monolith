import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  financeAccountsTable,
  financeBooksTable,
  financeJournalEntriesTable,
  financeJournalLinesTable,
  financeLedgerEntriesTable,
} from "@workspace/db";
import { ensureSystemAccounts } from "../ledger/system-accounts";
import { listBooks, resolveBookId } from "../ledger/books";

// Books (separate ledgers) and the chart of accounts. Moved unchanged from routes/finance.ts
// (FIN-WP-2b). The route keeps HTTP validation, the PDP ownership middleware and response
// formatting (fmtAccount). Messages and status mapping below are the exact ones the routes returned.
//
// deleteBook is transactional (F8 fixed after the WP-2b move; see finance-safety-findings.md).

export interface BookInput {
  name?: string;
  bookType?: string;
  currency?: string;
  notes?: string;
}

export async function listUserBooks(userId: number) {
  await resolveBookId(userId); // ensures at least one (default) book exists
  return listBooks(userId);
}

/** Caller must have validated that input.name is non-blank. */
export async function createBook(userId: number, input: BookInput & { name: string }) {
  const [row] = await db.insert(financeBooksTable).values({
    userId, name: input.name.trim(), bookType: input.bookType || "personal",
    currency: input.currency || "BDT", notes: input.notes ?? null, isDefault: 0,
  }).returning();
  await ensureSystemAccounts(userId, row.id); // new book starts with its own seeded Chart of Accounts
  return row;
}

/** Undefined fields are left unchanged. Returns undefined when the book is not this user's. */
export async function updateBook(userId: number, id: number, input: BookInput) {
  const update: Record<string, any> = { updatedAt: new Date() };
  if (input.name !== undefined) update.name = input.name;
  if (input.bookType !== undefined) update.bookType = input.bookType;
  if (input.currency !== undefined) update.currency = input.currency;
  if (input.notes !== undefined) update.notes = input.notes;
  const [row] = await db.update(financeBooksTable).set(update)
    .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, userId)))
    .returning();
  return row;
}

/** Unsets any other default for the user first, so exactly one stays true. Undefined when not found. */
export async function setDefaultBook(userId: number, id: number) {
  const [book] = await db.select().from(financeBooksTable)
    .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, userId)));
  if (!book) return undefined;
  await db.update(financeBooksTable).set({ isDefault: 0 }).where(eq(financeBooksTable.userId, userId));
  const [row] = await db.update(financeBooksTable).set({ isDefault: 1, updatedAt: new Date() }).where(eq(financeBooksTable.id, id)).returning();
  return row;
}

export type DeleteBookOutcome =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "is_default" }
  | { status: "has_entries" };

/**
 * One transaction (F8). The book row is locked FOR UPDATE and the entry count is re-checked inside
 * it, so a concurrent delete cannot interleave and a failure part-way rolls everything back. The
 * journal lines and headers are deleted by the same id set, and the owner is re-checked on the
 * locked row. Outcomes and messages are unchanged.
 */
export async function deleteBook(userId: number, id: number): Promise<DeleteBookOutcome> {
  return db.transaction(async (tx): Promise<DeleteBookOutcome> => {
    const [book] = await tx.select().from(financeBooksTable)
      .where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, userId)))
      .for("update");
    if (!book) return { status: "not_found" };
    if (book.isDefault) return { status: "is_default" };
    const [{ count }] = await tx.select({ count: sql<number>`COUNT(*)` }).from(financeLedgerEntriesTable).where(eq(financeLedgerEntriesTable.bookId, id));
    if (Number(count) > 0) return { status: "has_entries" };
    const bookJournalEntries = await tx.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
      .where(eq(financeJournalEntriesTable.bookId, id));
    const bookJournalEntryIds = bookJournalEntries.map(j => j.id);
    if (bookJournalEntryIds.length > 0) {
      await tx.delete(financeJournalLinesTable).where(inArray(financeJournalLinesTable.journalEntryId, bookJournalEntryIds));
      await tx.delete(financeJournalEntriesTable).where(inArray(financeJournalEntriesTable.id, bookJournalEntryIds));
    }
    await tx.delete(financeAccountsTable).where(and(eq(financeAccountsTable.bookId, id), eq(financeAccountsTable.userId, userId)));
    await tx.delete(financeBooksTable).where(and(eq(financeBooksTable.id, id), eq(financeBooksTable.userId, userId)));
    return { status: "deleted" };
  });
}

export async function listAccounts(userId: number, bookId?: number) {
  const resolvedBookId = await resolveBookId(userId, bookId);
  await ensureSystemAccounts(userId, resolvedBookId);
  return db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.bookId, resolvedBookId)))
    .orderBy(financeAccountsTable.code);
}

export interface AccountInput {
  code: string;
  name: string;
  type: string;
  normalBalance?: string;
  parentId?: number;
  bookId?: number;
}

export type CreateAccountOutcome =
  | { status: "created"; account: typeof financeAccountsTable.$inferSelect }
  | { status: "duplicate_code" };

/** Caller must have validated code, name and type. Any insert failure is reported as a duplicate code, as before. */
export async function createAccount(userId: number, input: AccountInput): Promise<CreateAccountOutcome> {
  const resolvedBookId = await resolveBookId(userId, input.bookId);
  try {
    const [row] = await db.insert(financeAccountsTable).values({
      userId, bookId: resolvedBookId, code: input.code.trim(), name: input.name.trim(), type: input.type,
      normalBalance: input.normalBalance === "credit" ? "credit" : "debit",
      parentId: input.parentId ?? null, isSystem: 0,
    }).returning();
    return { status: "created", account: row };
  } catch {
    return { status: "duplicate_code" };
  }
}

/** Only name, type, normalBalance and parentId can change. Undefined when not found, not yours, or a system account. */
export async function updateAccount(userId: number, id: number, fields: Record<string, any>) {
  const update: Record<string, any> = { updatedAt: new Date() };
  for (const k of ["name", "type", "normalBalance", "parentId"]) {
    if (fields[k] !== undefined) update[k] = fields[k];
  }
  const [row] = await db.update(financeAccountsTable)
    .set(update)
    .where(and(eq(financeAccountsTable.id, id), eq(financeAccountsTable.userId, userId), eq(financeAccountsTable.isSystem, 0)))
    .returning();
  return row;
}

export type DeleteAccountOutcome =
  | { status: "deleted" }
  | { status: "not_found" }
  | { status: "system_account" }
  | { status: "has_activity" };

export async function deleteAccount(userId: number, id: number): Promise<DeleteAccountOutcome> {
  const [account] = await db.select().from(financeAccountsTable)
    .where(and(eq(financeAccountsTable.id, id), eq(financeAccountsTable.userId, userId)));
  if (!account) return { status: "not_found" };
  if (account.isSystem) return { status: "system_account" };
  const [{ count }] = await db.select({ count: sql<number>`COUNT(*)` }).from(financeJournalLinesTable).where(eq(financeJournalLinesTable.accountId, id));
  if (Number(count) > 0) return { status: "has_activity" };
  await db.delete(financeAccountsTable).where(eq(financeAccountsTable.id, id));
  return { status: "deleted" };
}
