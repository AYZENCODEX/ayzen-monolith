// Extracted from the Vault application layer by VLT-GAP-12 (extract-method): each function is one database call chain, verbatim.
// Do not add business logic here — repositories only run queries.
import { db } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export async function selectValueHistoryForGetEntityValueHistory(userId: number) {
  const { valueHistoryTable } = (await import("@workspace/db")) as { valueHistoryTable: any }; // typed any exactly as the caller passed it before the move
  return db.select().from(valueHistoryTable)
      .where(and(eq(valueHistoryTable.userId, userId), eq(valueHistoryTable.sourceType, "vault")))
      .orderBy(valueHistoryTable.createdAt);
}
