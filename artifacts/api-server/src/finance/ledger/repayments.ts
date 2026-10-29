// Repayment recording (atomic, idempotent), principal repayment and installment payment. Moved unchanged from
// lib/finance-accounting.ts (FIN-WP-3).
import {
  db,
  financeAmortizationTable,
  financeLedgerEntriesTable,
  financeRepaymentsTable,
  type FinanceRepayment,
  type FinanceLedgerEntry,
} from "@workspace/db";
import { eq, and, ne, sql } from "drizzle-orm";
import { postRepaymentJournal, type FinanceDbTransaction } from "./journal";

type DbTransaction = FinanceDbTransaction;


/**
 * SET clause for a principal repayment. Amount and status are computed in the SAME statement from
 * the row's pre-update amount, so they cannot disagree and concurrent repayments serialize on the
 * row lock instead of overwriting each other with a stale value (F4).
 */
function principalRepaymentSet(amount: number) {
  return {
    amount: sql`GREATEST(0, ${financeLedgerEntriesTable.amount} - ${amount})`,
    status: sql`CASE WHEN GREATEST(0, ${financeLedgerEntriesTable.amount} - ${amount}) <= 0.01 THEN 'paid' ELSE 'partial' END`,
    updatedAt: new Date(),
  };
}

/**
 * Apply a principal repayment in one atomic statement. Returns the remaining amount, or `null`
 * when the entry does not exist (previously 0, which looked the same as "fully repaid").
 * Does not de-duplicate requests; use recordRepayment with an idempotency key for that.
 */
export async function applyPrincipalRepayment(entryId: number, amount: number): Promise<number | null> {
  const [updated] = await db.update(financeLedgerEntriesTable)
    .set(principalRepaymentSet(amount))
    .where(eq(financeLedgerEntriesTable.id, entryId))
    .returning({ amount: financeLedgerEntriesTable.amount });
  return updated ? updated.amount : null;
}

export type RecordRepaymentInput = {
  entryId: number;
  amount: number;
  isInterest: boolean;
  notes?: string | null;
  paidAt?: Date;
  /** Optional client request key. Same key + same entry replays the first result instead of repeating it. */
  idempotencyKey?: string | null;
};

export type RecordRepaymentResult =
  | { status: "created"; repayment: FinanceRepayment; remainingAmount: number | null }
  | { status: "replayed"; repayment: FinanceRepayment }
  | { status: "conflict" }
  | { status: "entry_not_found" };

class RepaymentEntryNotFoundError extends Error {}

const sameRepaymentAmount = (stored: number, requested: number): boolean =>
  Math.abs(stored - requested) <= Math.max(0.01, Math.abs(requested) * 1e-6); // column is REAL (float4)

/**
 * Record a repayment and apply it to the entry in ONE transaction: the repayment row and the
 * balance/interest change commit or roll back together (previously separate statements, so a
 * failure between them left a repayment row with no decrement). With an idempotency key, a repeat
 * request (client retry, double click) returns the original repayment without applying it again;
 * the same key with a different amount or type is a conflict. Journal posting and notifications
 * stay best-effort in the caller.
 */
export async function recordRepayment(input: RecordRepaymentInput): Promise<RecordRepaymentResult> {
  const key = input.idempotencyKey?.trim() || null;
  const values = {
    entryId: input.entryId,
    amount: input.amount,
    isInterest: input.isInterest ? 1 : 0,
    notes: input.notes ?? null,
    paidAt: input.paidAt ?? new Date(),
    idempotencyKey: key,
  };
  try {
    return await db.transaction(async (tx): Promise<RecordRepaymentResult> => {
      const inserted = key
        ? await tx.insert(financeRepaymentsTable).values(values).onConflictDoNothing().returning()
        : await tx.insert(financeRepaymentsTable).values(values).returning();
      const repayment = inserted[0];
      if (!repayment) {
        const [existing] = await tx.select().from(financeRepaymentsTable)
          .where(and(eq(financeRepaymentsTable.entryId, input.entryId), eq(financeRepaymentsTable.idempotencyKey, key!)))
          .limit(1);
        if (existing && existing.isInterest === values.isInterest && sameRepaymentAmount(existing.amount, input.amount)) {
          return { status: "replayed", repayment: existing };
        }
        return { status: "conflict" };
      }

      if (input.isInterest) {
        const [updated] = await tx.update(financeLedgerEntriesTable)
          .set({ interestPaid: sql`${financeLedgerEntriesTable.interestPaid} + ${input.amount}`, updatedAt: new Date() })
          .where(eq(financeLedgerEntriesTable.id, input.entryId))
          .returning({ id: financeLedgerEntriesTable.id });
        if (!updated) throw new RepaymentEntryNotFoundError();
        return { status: "created", repayment, remainingAmount: null };
      }

      const [updated] = await tx.update(financeLedgerEntriesTable)
        .set(principalRepaymentSet(input.amount))
        .where(eq(financeLedgerEntriesTable.id, input.entryId))
        .returning({ amount: financeLedgerEntriesTable.amount });
      if (!updated) throw new RepaymentEntryNotFoundError();
      return { status: "created", repayment, remainingAmount: updated.amount };
    });
  } catch (error) {
    if (error instanceof RepaymentEntryNotFoundError) return { status: "entry_not_found" };
    throw error;
  }
}

/**
 * Same atomic principal repayment as applyPrincipalRepayment, but inside the caller's transaction,
 * so the balance change commits or rolls back with the caller's other writes. Returns the remaining
 * amount, or null when the entry does not exist.
 */
export async function applyPrincipalRepaymentTx(tx: DbTransaction, entryId: number, amount: number): Promise<number | null> {
  const [updated] = await tx.update(financeLedgerEntriesTable)
    .set(principalRepaymentSet(amount))
    .where(eq(financeLedgerEntriesTable.id, entryId))
    .returning({ amount: financeLedgerEntriesTable.amount });
  return updated ? updated.amount : null;
}

type AmortizationInstallment = typeof financeAmortizationTable.$inferSelect;

export type PayInstallmentResult =
  | { status: "paid"; row: AmortizationInstallment }
  | { status: "already_paid"; row: AmortizationInstallment }
  | { status: "not_found" }
  | { status: "entry_not_found" };

/**
 * Mark an amortization installment paid and record its principal/interest repayments against the
 * entry, all in ONE transaction. The installment is claimed with a conditional update
 * (status <> 'paid'), so two concurrent requests for the same installment cannot both record a
 * payment: the loser gets `already_paid` and nothing is written twice. Journal postings stay
 * best-effort and run after the commit.
 */
export async function payAmortizationInstallment(id: number, userId: number): Promise<PayInstallmentResult> {
  const journalWork: Array<{ entry: FinanceLedgerEntry; amount: number; isInterest: boolean }> = [];
  let outcome: PayInstallmentResult;
  try {
    outcome = await db.transaction(async (tx): Promise<PayInstallmentResult> => {
      const [row] = await tx.select().from(financeAmortizationTable)
        .where(and(eq(financeAmortizationTable.id, id), eq(financeAmortizationTable.userId, userId)));
      if (!row) return { status: "not_found" };
      if (row.status === "paid") return { status: "already_paid", row };
      const [entry] = await tx.select().from(financeLedgerEntriesTable)
        .where(and(eq(financeLedgerEntriesTable.id, row.ledgerEntryId), eq(financeLedgerEntriesTable.userId, userId)));
      if (!entry) return { status: "entry_not_found" };

      const [claimed] = await tx.update(financeAmortizationTable)
        .set({ status: "paid", paidAt: new Date() })
        .where(and(
          eq(financeAmortizationTable.id, id),
          eq(financeAmortizationTable.userId, userId),
          ne(financeAmortizationTable.status, "paid"),
        ))
        .returning();
      if (!claimed) {
        const [latest] = await tx.select().from(financeAmortizationTable).where(eq(financeAmortizationTable.id, id));
        return { status: "already_paid", row: latest ?? row };
      }

      const notes = `Amortization #${row.installmentNo}`;
      if (row.principalDue > 0) {
        await tx.insert(financeRepaymentsTable).values({ entryId: entry.id, amount: row.principalDue, isInterest: 0, notes });
        if ((await applyPrincipalRepaymentTx(tx, entry.id, row.principalDue)) === null) throw new RepaymentEntryNotFoundError();
        journalWork.push({ entry, amount: row.principalDue, isInterest: false });
      }
      if (row.interestDue > 0) {
        await tx.insert(financeRepaymentsTable).values({ entryId: entry.id, amount: row.interestDue, isInterest: 1, notes });
        const [updated] = await tx.update(financeLedgerEntriesTable)
          .set({ interestPaid: sql`${financeLedgerEntriesTable.interestPaid} + ${row.interestDue}`, updatedAt: new Date() })
          .where(eq(financeLedgerEntriesTable.id, entry.id))
          .returning({ id: financeLedgerEntriesTable.id });
        if (!updated) throw new RepaymentEntryNotFoundError();
        journalWork.push({ entry, amount: row.interestDue, isInterest: true });
      }
      return { status: "paid", row: claimed };
    });
  } catch (error) {
    if (error instanceof RepaymentEntryNotFoundError) return { status: "entry_not_found" };
    throw error;
  }
  if (outcome.status === "paid") {
    for (const work of journalWork) await postRepaymentJournal(work.entry, work.amount, work.isInterest).catch(() => {});
  }
  return outcome;
}
