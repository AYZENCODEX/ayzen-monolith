/**
 * finance/integrations/wallet-bridge.ts (moved from lib/finance-wallet-bridge.ts, FIN-WP-7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wallet↔Finance bridge. Confirmed vault deposits (services/deposit-watcher.ts) and outbound withdrawals
 * (routes/wallets.ts handleWithdraw) each auto-post a Finance ledger entry here, which in turn auto-posts a balanced
 * journal entry via ledger/journal (kind 'income' -> Cash/Income, kind 'expense' -> Expense/Cash). Net effect:
 * on-chain wallet activity shows up in Finance's ledger, analytics, and Trial Balance / Balance Sheet / Income
 * Statement with zero manual entry.
 *
 * Idempotency: source_chain_deposit_id / source_wallet_tx_hash are unique columns (migration 025) — a retried credit
 * or a duplicate broadcast event can never post twice. Both functions are best-effort: a Finance-side failure is
 * logged and swallowed, never allowed to break the deposit credit or the withdrawal response the user is waiting on.
 *
 * Behavior change from the legacy file (F26, see finance-safety-findings.md): the ledger entry and its journal are
 * ONE transaction. Before, the entry was inserted first and the journal posted after; a journal failure left an
 * entry with no journal, and the retry hit the unique index, returned as "already posted" and never journaled it.
 * Now a journal that cannot be posted rolls the entry back too, so a retry starts clean.
 */
import { db, walletsTable, financeLedgerEntriesTable, financeJournalEntriesTable, type ChainDeposit } from "@workspace/db";
import { and, eq, inArray, isNotNull, notExists, or } from "drizzle-orm";
import { postEntryJournalInTx } from "../ledger/journal";
import { resolveBookId } from "../ledger/books";
import { logger } from "../../lib/logger";

async function walletSyncEnabled(walletId: number): Promise<boolean> {
  const [w] = await db.select({ autoFinanceSync: walletsTable.autoFinanceSync })
    .from(walletsTable).where(eq(walletsTable.id, walletId));
  return w?.autoFinanceSync ?? true;
}

class WalletJournalError extends Error {}

/** Insert the ledger entry and post its journal in one transaction; either both exist afterwards or neither. */
async function insertEntryWithJournal(values: typeof financeLedgerEntriesTable.$inferInsert): Promise<void> {
  await db.transaction(async (tx) => {
    const [entry] = await tx.insert(financeLedgerEntriesTable).values(values).returning();
    if (!(await postEntryJournalInTx(tx, entry))) {
      throw new WalletJournalError("journal could not be posted for the wallet entry");
    }
  });
}

/** Called once a chain_deposits row crosses its confirmation threshold and is credited. */
export async function postDepositToFinance(deposit: ChainDeposit): Promise<void> {
  try {
    if (!(await walletSyncEnabled(deposit.walletId))) return;

    // BUG FIX: every entry-creation path must resolve a concrete bookId
    // before insert (financeLedgerEntriesTable.bookId's doc comment) —
    // GET /finance/entries and virtually every other read always filters
    // on a resolved, non-null bookId. This insert previously left bookId
    // unset (null), so wallet deposits posted a journal entry but the
    // ledger row itself was permanently invisible in the Finance UI —
    // same bug already fixed for the CSV-import and recurring-cron paths.
    const bookId = await resolveBookId(deposit.userId);

    await insertEntryWithJournal({
      userId: deposit.userId,
      bookId,
      kind: "income",
      title: `${deposit.tokenSymbol} deposit — ${deposit.chain}`,
      amount: deposit.amount,
      currency: deposit.tokenSymbol,
      category: "Wallet Deposit",
      occurredDate: deposit.confirmedAt ?? new Date(),
      status: "paid",
      notes: `Auto-posted from vault deposit. Tx ${deposit.txHash} on ${deposit.chain}, from ${deposit.fromAddress}.`,
      sourceChainDepositId: deposit.id,
    });
  } catch (err: any) {
    if (err?.code === "23505") return; // unique violation — already posted, safe no-op
    logger.warn({ err, depositId: deposit.id }, "finance-wallet-bridge: failed to post deposit");
  }
}

/** Called right after a wallet withdrawal is successfully broadcast. */
export async function postWithdrawalToFinance(opts: {
  userId: number;
  walletId: number;
  chain: string;
  symbol: string;
  amount: number;
  to: string;
  txHash: string;
}): Promise<void> {
  try {
    if (!(await walletSyncEnabled(opts.walletId))) return;

    // BUG FIX: same missing-bookId gap as postDepositToFinance above — this
    // insert never resolved a bookId, so wallet withdrawals were also
    // invisible in Finance's ledger UI despite journaling correctly.
    const bookId = await resolveBookId(opts.userId);

    await insertEntryWithJournal({
      userId: opts.userId,
      bookId,
      kind: "expense",
      title: `${opts.symbol} withdrawal — ${opts.chain}`,
      amount: opts.amount,
      currency: opts.symbol,
      category: "Wallet Withdrawal",
      occurredDate: new Date(),
      status: "paid",
      notes: `Auto-posted from wallet withdrawal. Tx ${opts.txHash} on ${opts.chain}, to ${opts.to}.`,
      sourceWalletTxHash: opts.txHash,
    });
  } catch (err: any) {
    if (err?.code === "23505") return;
    logger.warn({ err, txHash: opts.txHash }, "finance-wallet-bridge: failed to post withdrawal");
  }
}

/**
 * One-off repair (owner decision, FIN-WP-7): post the journal for wallet entries the legacy bridge stored without one
 * (entry inserted, journal failed, retry blocked by the unique index). Idempotent and safe to re-run: each entry is
 * locked, re-checked for a journal inside its own transaction and journaled with exactly the lines a fresh deposit or
 * withdrawal would have posted (dated by the entry's occurredDate). Entries that still cannot be journaled are
 * counted as failed and left untouched. Run with `pnpm --filter @workspace/api-server repair:finance-wallet-journals`.
 */
export async function repairWalletEntriesWithoutJournal(options: { userIds?: number[] } = {}): Promise<{ checked: number; repaired: number; failed: number }> {
  const orphans = await db.select().from(financeLedgerEntriesTable).where(and(
    or(isNotNull(financeLedgerEntriesTable.sourceChainDepositId), isNotNull(financeLedgerEntriesTable.sourceWalletTxHash)),
    notExists(db.select({ one: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
      .where(eq(financeJournalEntriesTable.sourceLedgerEntryId, financeLedgerEntriesTable.id))),
    options.userIds ? inArray(financeLedgerEntriesTable.userId, options.userIds) : undefined,
  ));
  let repaired = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      const done = await db.transaction(async (tx) => {
        const [entry] = await tx.select().from(financeLedgerEntriesTable)
          .where(eq(financeLedgerEntriesTable.id, orphan.id)).for("update");
        if (!entry) return false;
        const [existing] = await tx.select({ id: financeJournalEntriesTable.id }).from(financeJournalEntriesTable)
          .where(eq(financeJournalEntriesTable.sourceLedgerEntryId, entry.id)).limit(1);
        if (existing) return false; // journaled meanwhile
        if (!(await postEntryJournalInTx(tx, entry))) throw new WalletJournalError(`journal could not be posted for entry #${entry.id}`);
        return true;
      });
      if (done) repaired++;
    } catch (err: any) {
      failed++;
      logger.warn({ err: err?.message, entryId: orphan.id }, "finance-wallet-bridge: repair could not journal a wallet entry");
    }
  }
  return { checked: orphans.length, repaired, failed };
}
