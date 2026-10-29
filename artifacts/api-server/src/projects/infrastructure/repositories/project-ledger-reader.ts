// projects/infrastructure/repositories/project-ledger-reader.ts
// THE ONLY place Projects reads Finance's `finance_ledger_entries` (PRJ-04). It returns raw totals per kind,
// summed exactly as stored with no currency conversion; the arithmetic lives in projects/domain/roi.ts.
// Recorded in the boundary manifest as a foreign-table edge. This is deliberately NOT routed through
// finance/application's getProjectInvestments, which converts to base currency and returns different figures.
import { db, financeLedgerEntriesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

export function sumLedgerByKind(userId: number, projectId: number) {
  return db.select({
    kind: financeLedgerEntriesTable.kind,
    total: sql<number>`COALESCE(SUM(${financeLedgerEntriesTable.amount}), 0)`,
  }).from(financeLedgerEntriesTable)
    .where(and(
      eq(financeLedgerEntriesTable.userId, userId),
      eq(financeLedgerEntriesTable.projectId, projectId),
      sql`${financeLedgerEntriesTable.kind} IN ('investment', 'expense', 'income')`,
    ))
    .groupBy(financeLedgerEntriesTable.kind);
}
