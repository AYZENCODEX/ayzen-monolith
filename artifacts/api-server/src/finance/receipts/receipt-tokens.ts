import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, financeLedgerEntriesTable } from "@workspace/db";

/** Random, unguessable, url-safe token — possession is the only "auth" for GET /finance/receipt/:token(/pdf). */
export function generateReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}

export function financeReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/finance/receipt/${receiptToken}`;
}

/** Idempotently ensure a ledger entry has a public receipt/invoice token, minting one if missing. Returns null if the entry doesn't exist or minting failed after retries. */
export async function ensureReceiptToken(entryId: number, userId: number): Promise<string | null> {
  const [entry] = await db.select({ receiptToken: financeLedgerEntriesTable.receiptToken })
    .from(financeLedgerEntriesTable)
    .where(and(eq(financeLedgerEntriesTable.id, entryId), eq(financeLedgerEntriesTable.userId, userId)));
  if (!entry) return null;
  if (entry.receiptToken) return entry.receiptToken;

  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generateReceiptToken();
    try {
      const [row] = await db.update(financeLedgerEntriesTable)
        .set({ receiptToken: candidate, updatedAt: new Date() })
        .where(eq(financeLedgerEntriesTable.id, entryId))
        .returning({ receiptToken: financeLedgerEntriesTable.receiptToken });
      if (row?.receiptToken) return row.receiptToken;
    } catch { /* unique collision — loop and retry */ }
  }
  return null;
}
