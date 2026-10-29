import { db, financeAmortizationTable, type FinanceLedgerEntry } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildAmortizationRows } from "../domain/schedules";

// DB-backed loan amortization schedule. Persistence moved from lib/finance-accounting.ts (FIN-WP-4);
// the arithmetic is in domain/schedules.ts.

export interface AmortizationRowShape {
  id: number;
  ledgerEntryId: number;
  installmentNo: number;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  remainingBalance: number;
  status: string;
  paidAt: string | null;
}

export function fmtAmortRow(r: typeof financeAmortizationTable.$inferSelect): AmortizationRowShape {
  return {
    id: r.id,
    ledgerEntryId: r.ledgerEntryId,
    installmentNo: r.installmentNo,
    dueDate: r.dueDate.toISOString(),
    principalDue: r.principalDue,
    interestDue: r.interestDue,
    totalDue: r.totalDue,
    remainingBalance: r.remainingBalance,
    status: r.status,
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
  };
}

/**
 * Equal-principal amortization schedule. Wipes any existing schedule for the entry (including paid
 * rows). The wipe and the insert are ONE transaction (F9): a failed insert no longer leaves the
 * entry with no schedule.
 */
export async function generateAmortizationSchedule(entry: FinanceLedgerEntry, termMonths: number): Promise<AmortizationRowShape[]> {
  const principal = entry.amount || 0;
  const annualRate = entry.interestRate || 0;
  // Anchor the schedule to when the loan originated, not its (single) final
  // due date — occurredDate is when the principal changed hands, so
  // installment #1 should land one period after that. Using dueDate first
  // would start counting installments from the loan's final due date
  // forward, pushing every generated installment date months/years past
  // where it belongs whenever an entry has both fields set (the normal
  // case for borrowed/lending entries).
  const startDate = entry.occurredDate ?? entry.dueDate ?? new Date();

  const rows = buildAmortizationRows({ userId: entry.userId, ledgerEntryId: entry.id, principal, annualRate, termMonths, startDate });
  const inserted = await db.transaction(async (tx) => {
    await tx.delete(financeAmortizationTable).where(eq(financeAmortizationTable.ledgerEntryId, entry.id));
    return tx.insert(financeAmortizationTable).values(rows).returning();
  });
  return inserted.map(fmtAmortRow);
}

export async function listAmortizationForEntry(entryId: number): Promise<AmortizationRowShape[]> {
  const rows = await db.select().from(financeAmortizationTable)
    .where(eq(financeAmortizationTable.ledgerEntryId, entryId))
    .orderBy(financeAmortizationTable.installmentNo);
  return rows.map(fmtAmortRow);
}
