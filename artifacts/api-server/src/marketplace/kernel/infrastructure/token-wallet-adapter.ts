/**
 * marketplace/kernel/infrastructure/token-wallet-adapter.ts
 * MKT-03: TokenWalletPort over `builtin_wallet_tokens` (USDT rows only). Statements are copied from marketplace-spot.ts
 * (same text, whitespace aside) and checked by the static characterization tests.
 */
import type { SqlExecutor } from "../ports/credits-port";
import type { TokenWalletPort, UsdtRow } from "../ports/token-wallet-port";

export const TOKEN_SQL = {
  ensureUsdtRow: "INSERT INTO builtin_wallet_tokens (user_id, symbol, amount, locked_amount) VALUES ($1, 'USDT', 0, 0) ON CONFLICT (user_id, symbol) DO NOTHING",
  lockUsdtRow: "SELECT amount, locked_amount FROM builtin_wallet_tokens WHERE user_id=$1 AND symbol='USDT' FOR UPDATE",
  addLockedUsdt: "UPDATE builtin_wallet_tokens SET locked_amount=locked_amount+$1, updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'",
  releaseLockedUsdt: "UPDATE builtin_wallet_tokens SET locked_amount=GREATEST(0, locked_amount-$1), updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'",
  creditUsdt: "INSERT INTO builtin_wallet_tokens (user_id, symbol, amount, locked_amount) VALUES ($1,'USDT',$2,0) ON CONFLICT (user_id, symbol) DO UPDATE SET amount=builtin_wallet_tokens.amount+$2, updated_at=NOW()",
  debitUsdt: "UPDATE builtin_wallet_tokens SET amount=amount-$1, updated_at=NOW() WHERE user_id=$2 AND symbol='USDT'",
} as const;

export const tokenWalletAdapter: TokenWalletPort = {
  async ensureUsdtRow(db: SqlExecutor, userId: number): Promise<void> {
    await db.query(TOKEN_SQL.ensureUsdtRow, [userId]);
  },
  async lockUsdtRow(db: SqlExecutor, userId: number): Promise<UsdtRow | undefined> {
    const r = await db.query(TOKEN_SQL.lockUsdtRow, [userId]);
    return r.rows[0] as UsdtRow | undefined;
  },
  async addLockedUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(TOKEN_SQL.addLockedUsdt, [amount, userId]);
  },
  async releaseLockedUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(TOKEN_SQL.releaseLockedUsdt, [amount, userId]);
  },
  async creditUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(TOKEN_SQL.creditUsdt, [userId, amount]);
  },
  async debitUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void> {
    await db.query(TOKEN_SQL.debitUsdt, [amount, userId]);
  },
};
