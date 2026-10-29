// Books (separate ledgers per user). Moved unchanged from lib/finance-accounting.ts (FIN-WP-3).
import {
  db,
  financeBooksTable,
  type FinanceBook,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

// ─── Books (Phase 3 — Multi-book) ───────────────────────────────────────────

/** List every book for a user, default book first. Never empty once resolveDefaultBookId has run for them. */
export async function listBooks(userId: number): Promise<FinanceBook[]> {
  const rows = await db.select().from(financeBooksTable).where(eq(financeBooksTable.userId, userId));
  return rows.sort((a, b) => (b.isDefault - a.isDefault) || a.id - b.id);
}

/**
 * Resolve the concrete bookId a request should operate on: the caller's
 * explicit choice if given (and it's actually theirs), otherwise the user's
 * default book — lazily creating a "Personal" default book on first-ever
 * use so every user always has exactly one to fall back to, without needing
 * a signup-time hook. Mirrors ensureSystemAccounts' "ensure on first use"
 * pattern below.
 */
export async function resolveBookId(userId: number, requestedBookId?: number | null): Promise<number> {
  if (requestedBookId != null) {
    const [owned] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
      .where(and(eq(financeBooksTable.id, requestedBookId), eq(financeBooksTable.userId, userId))).limit(1);
    if (owned) return owned.id;
    // Requested book doesn't exist or isn't theirs — fall through to default
    // rather than erroring, so a stale bookId in a bookmarked URL degrades
    // gracefully instead of breaking the page.
  }
  const [existingDefault] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
    .where(and(eq(financeBooksTable.userId, userId), eq(financeBooksTable.isDefault, 1))).limit(1);
  if (existingDefault) return existingDefault.id;

  const [anyBook] = await db.select({ id: financeBooksTable.id }).from(financeBooksTable)
    .where(eq(financeBooksTable.userId, userId)).limit(1);
  if (anyBook) {
    await db.update(financeBooksTable).set({ isDefault: 1 }).where(eq(financeBooksTable.id, anyBook.id));
    return anyBook.id;
  }

  const [created] = await db.insert(financeBooksTable).values({
    userId, name: "Personal", bookType: "personal", isDefault: 1,
  }).returning();
  return created.id;
}
