/**
 * finance/fees/late-fees.ts (moved from lib/finance-late-fee-cron.ts, FIN-WP-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Late fee / overdue-interest auto-calc. A sweep scans finance_ledger_entries for anything past
 * dueDate + lateFeeGraceDays with lateFeeType set and not yet settled, computes the fee accrued since
 * lateFeeLastCalcAt (or since the grace period ended, if never calculated), adds it to both `amount` (what is
 * owed grows) and lateFeeAccrued (running total charged), flips status to 'overdue' if it was not already
 * paid/partial, and posts the accrual to the books (Dr AR/Loans/Interest expense, Cr Interest income/AP/Loans payable).
 *
 * The arithmetic is in domain/late-fees.ts. The scheduler is in jobs/late-fee.ts.
 *
 * Behavior changes from the legacy file (F23, see finance-safety-findings.md):
 *   - the accrual claim is conditional on the entry still being unsettled and on lateFeeLastCalcAt still being
 *     the value the sweep read, so two overlapping sweeps (two instances, a restart) charge a period once;
 *   - the entry update and its journal are ONE transaction; a journal that cannot be posted rolls the accrual back
 *     (the next sweep retries the whole period) instead of leaving an entry that grew with no journal;
 *   - the 'pending' to 'overdue' flip no longer overwrites a status written since the read;
 *   - the fee is rounded to whole cents (owner decision; before, a percentage fee booked values like 33.3333).
 */
import { db, financeLedgerEntriesTable, financeRepaymentsTable, type FinanceLedgerEntry } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { logBus } from "../../lib/log-bus";
import { postLateFeeAccrualJournalInTx } from "../ledger/journal";
import {
  LATE_FEE_SETTLED_STATUSES,
  lateFeeAccrual,
  lateFeeAccrualStart,
  lateFeeGraceEnd,
  lateFeeUsesPrincipal,
  originalPrincipal,
  roundLateFee,
} from "../domain/late-fees";

export type LateFeeNotify = (
  userId: number, type: string, title: string, message: string, data?: Record<string, unknown>,
) => Promise<unknown>;

export interface LateFeeSweepOptions {
  /** Clock; defaults to the current time. */
  now?: Date;
  /** Restrict the sweep to these users (tests and manual runs). The scheduled sweep omits it. */
  userIds?: number[];
  /** In-app notification; defaults to lib/create-notification (loaded on demand). */
  notify?: LateFeeNotify;
}

// Original principal, excluding fees already tacked on. See originalPrincipal() for why the repaid principal is added back.
async function principal(entry: FinanceLedgerEntry): Promise<number> {
  const [{ repaid } = { repaid: 0 }] = await db.select({
    repaid: sql<number>`COALESCE(SUM(${financeRepaymentsTable.amount}), 0)`,
  }).from(financeRepaymentsTable)
    .where(and(eq(financeRepaymentsTable.entryId, entry.id), eq(financeRepaymentsTable.isInterest, 0)));
  return originalPrincipal(entry.amount, entry.lateFeeAccrued, Number(repaid));
}

async function computeAccrual(entry: FinanceLedgerEntry, since: Date, now: Date): Promise<number> {
  const terms = { type: entry.lateFeeType, rate: entry.lateFeeRate, accrued: entry.lateFeeAccrued };
  const base = lateFeeUsesPrincipal(entry.lateFeeType) && (entry.lateFeeRate ?? 0) > 0 ? await principal(entry) : 0;
  return lateFeeAccrual(terms, base, since, now);
}

class LateFeeJournalError extends Error {}

/**
 * Charge `fee` to the entry and book it, in one transaction. Returns the new outstanding amount, or null when the
 * claim lost (the entry was settled, or another sweep or write moved lateFeeLastCalcAt since it was read), in
 * which case nothing was written. Throws, with nothing written, when the journal cannot be posted.
 */
async function accrueLateFee(entry: FinanceLedgerEntry, fee: number, now: Date, newStatus: string): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx.update(financeLedgerEntriesTable).set({
      amount: sql`${financeLedgerEntriesTable.amount} + ${fee}`,
      lateFeeAccrued: sql`${financeLedgerEntriesTable.lateFeeAccrued} + ${fee}`,
      lateFeeLastCalcAt: now,
      status: newStatus, updatedAt: now,
    }).where(and(
      eq(financeLedgerEntriesTable.id, entry.id),
      notInArray(financeLedgerEntriesTable.status, [...LATE_FEE_SETTLED_STATUSES]),
      entry.lateFeeLastCalcAt === null
        ? isNull(financeLedgerEntriesTable.lateFeeLastCalcAt)
        : eq(financeLedgerEntriesTable.lateFeeLastCalcAt, entry.lateFeeLastCalcAt),
    )).returning({ amount: financeLedgerEntriesTable.amount });
    if (!updated) return null;
    if (!(await postLateFeeAccrualJournalInTx(tx, entry, fee))) {
      throw new LateFeeJournalError(`late fee journal could not be posted for entry #${entry.id}`);
    }
    return updated.amount;
  });
}

async function defaultNotify(...args: Parameters<LateFeeNotify>): Promise<unknown> {
  const { createNotification } = await import("../../lib/create-notification");
  return createNotification(...args);
}

export async function runFinanceLateFeeSweep(options: LateFeeSweepOptions = {}): Promise<{ checked: number; accrued: number }> {
  const now = options.now ?? new Date();
  const notify = options.notify ?? defaultNotify;

  const candidates = await db.select().from(financeLedgerEntriesTable).where(and(
    isNotNull(financeLedgerEntriesTable.lateFeeType),
    isNotNull(financeLedgerEntriesTable.dueDate),
    notInArray(financeLedgerEntriesTable.status, [...LATE_FEE_SETTLED_STATUSES]),
    options.userIds ? inArray(financeLedgerEntriesTable.userId, options.userIds) : undefined,
  ));

  let accruedCount = 0;

  for (const entry of candidates) {
    try {
      const graceEnd = lateFeeGraceEnd(entry.dueDate!, entry.lateFeeGraceDays);
      if (now < graceEnd) continue;

      const since = lateFeeAccrualStart(entry.lateFeeLastCalcAt, graceEnd);
      const fee = roundLateFee(await computeAccrual(entry, since, now));
      if (fee <= 0.01) {
        // Still mark it overdue even if there's nothing new to accrue this sweep (only if it is still pending).
        if (entry.status === "pending") {
          await db.update(financeLedgerEntriesTable).set({ status: "overdue", updatedAt: now })
            .where(and(eq(financeLedgerEntriesTable.id, entry.id), eq(financeLedgerEntriesTable.status, "pending")));
        }
        continue;
      }

      const newStatus = entry.status === "pending" || entry.status === "overdue" ? "overdue" : entry.status;

      const newAmount = await accrueLateFee(entry, fee, now, newStatus);
      if (newAmount === null) continue; // settled or accrued by someone else since the read: nothing to do

      accruedCount++;
      // The fee is committed; a failing notification must not turn it into a reported failure.
      try {
        await notify(
          entry.userId, "finance_late_fee",
          `⏳ Late fee added — ${entry.title}`,
          `${entry.currency} ${fee.toLocaleString(undefined, { maximumFractionDigits: 2 })} late fee added. New total: ${entry.currency} ${newAmount.toLocaleString()}.`,
          { entryId: entry.id, fee },
        );
      } catch { /* best effort, as before */ }
    } catch (err: any) {
      logger.error({ err: err?.message, entryId: entry.id }, "Failed to accrue late fee");
      logBus.error(`Late fee accrual failed for entry #${entry.id}: ${err?.message ?? err}`);
    }
  }

  return { checked: candidates.length, accrued: accruedCount };
}
