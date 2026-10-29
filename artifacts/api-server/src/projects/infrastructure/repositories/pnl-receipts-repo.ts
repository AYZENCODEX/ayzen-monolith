// projects/infrastructure/repositories/pnl-receipts-repo.ts
// The single repository over `project_pnl_receipts` (PRJ-04), plus the issuer-name lookup the public card needs.
import { db, projectPnlReceiptsTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export async function findReceipt(userId: number, projectId: number) {
  const [existing] = await db.select().from(projectPnlReceiptsTable)
    .where(and(eq(projectPnlReceiptsTable.userId, userId), eq(projectPnlReceiptsTable.projectId, projectId)));
  return existing;
}

/** Throws on a unique-token collision; the use case retries. */
export async function insertReceipt(userId: number, projectId: number, receiptToken: string) {
  const [row] = await db.insert(projectPnlReceiptsTable)
    .values({ userId, projectId, receiptToken })
    .returning({ receiptToken: projectPnlReceiptsTable.receiptToken });
  return row;
}

export async function deleteReceipt(userId: number, projectId: number) {
  return db.delete(projectPnlReceiptsTable)
    .where(and(eq(projectPnlReceiptsTable.userId, userId), eq(projectPnlReceiptsTable.projectId, projectId)))
    .returning({ id: projectPnlReceiptsTable.id });
}

export async function findReceiptByToken(token: string) {
  const [receipt] = await db.select().from(projectPnlReceiptsTable).where(eq(projectPnlReceiptsTable.receiptToken, token)).limit(1);
  return receipt;
}

export async function findUsernameById(userId: number): Promise<string | undefined> {
  const [owner] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return owner?.username;
}
