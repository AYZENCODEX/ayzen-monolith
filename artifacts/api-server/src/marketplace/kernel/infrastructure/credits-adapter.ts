/**
 * marketplace/kernel/infrastructure/credits-adapter.ts
 * MKT-03: CreditsPort over the `credits` table. Each statement is copied from the route files (same text, whitespace
 * aside); scripts/antas/marketplace/characterization checks that every `credits` write in the routes has a twin here.
 */
import type { CreditsPort, SqlExecutor } from "../ports/credits-port";

export const CREDITS_SQL = {
  debitAznUnguarded: "UPDATE credits SET azn_balance = azn_balance - $1, updated_at=NOW() WHERE user_id=$2",
  debitAznGuarded: "UPDATE credits SET azn_balance=azn_balance-$1 WHERE user_id=$2 AND azn_balance >= $1",
  creditAzn: "UPDATE credits SET azn_balance = azn_balance + $1, updated_at=NOW() WHERE user_id=$2",
  creditAznUpsert: "INSERT INTO credits (user_id, azn_balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2",
  creditAznUpsertNewUser:
    "INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent) VALUES ($1,0,$2,0,0) ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2, updated_at=NOW()",
} as const;

export const creditsAdapter: CreditsPort = {
  async debitAznUnguarded(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(CREDITS_SQL.debitAznUnguarded, [amount, userId]);
  },
  async debitAznGuarded(db: SqlExecutor, userId: number, amount: number): Promise<boolean> {
    const r = await db.query(CREDITS_SQL.debitAznGuarded, [amount, userId]);
    return (r.rowCount ?? 0) > 0;
  },
  async creditAzn(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(CREDITS_SQL.creditAzn, [amount, userId]);
  },
  async creditAznUpsert(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(CREDITS_SQL.creditAznUpsert, [userId, amount]);
  },
  async creditAznUpsertNewUser(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(CREDITS_SQL.creditAznUpsertNewUser, [userId, amount]);
  },
};
