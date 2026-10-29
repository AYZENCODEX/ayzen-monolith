/**
 * marketplace/kernel/ports/token-wallet-port.ts
 * MKT-03 (decision D2): the USDT leg of spot trading lives in `builtin_wallet_tokens`, a table owned by the wallet feature.
 * Spot code reaches it only through this port (adapter: infrastructure/token-wallet-adapter.ts). Statements are the ones
 * marketplace-spot.ts runs today.
 */
import type { SqlExecutor } from "./credits-port";

export interface UsdtRow { amount: number | string; locked_amount: number | string }

export interface TokenWalletPort {
  ensureUsdtRow(db: SqlExecutor, userId: number): Promise<void>;
  /** SELECT ... FOR UPDATE: the caller must be inside a transaction on this client. */
  lockUsdtRow(db: SqlExecutor, userId: number): Promise<UsdtRow | undefined>;
  addLockedUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  releaseLockedUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  creditUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void>;
  debitUsdt(db: SqlExecutor, userId: number, amount: number): Promise<void>;
}
