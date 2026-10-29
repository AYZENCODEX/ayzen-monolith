/**
 * marketplace/kernel/ports/credits-port.ts
 * MKT-03 (decision D2): how Marketplace code changes the AZN balance in the `credits` table. No route or use case writes
 * `credits` directly once its phase has moved. Every method below is one SQL statement that already exists in the route
 * files (see infrastructure/credits-adapter.ts, checked by the static tests); the UNGUARDED debit is kept as it is today
 * and is pinned as MKT-ISSUE-7, it is not a recommendation.
 */
export interface SqlResult { rows: any[]; rowCount: number | null }
export interface SqlExecutor { query(text: string, params?: unknown[]): Promise<SqlResult> }

export interface CreditsPort {
  /** P2P family escrow debit: no balance predicate, exactly as today (MKT-ISSUE-7). */
  debitAznUnguarded(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  /** Wallet deposit debit: only debits when azn_balance >= amount; returns false when nothing was debited. */
  debitAznGuarded(db: SqlExecutor, userId: number, amount: number): Promise<boolean>;
  creditAzn(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  /** Wallet withdraw credit: inserts the credits row when missing. */
  creditAznUpsert(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  /** Order resolution credit: inserts a full credits row (balance 0, totals 0) when missing. */
  creditAznUpsertNewUser(db: SqlExecutor, userId: number, amount: number): Promise<void>;
}
