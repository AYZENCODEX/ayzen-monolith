/**
 * marketplace/kernel/infrastructure/tx.ts
 * MKT-03: one implementation of the transaction wrapper the money handlers write by hand today (16 of them):
 *   const client = await pool.connect(); try { BEGIN ... COMMIT } catch (e) { ROLLBACK; throw e } finally { client.release() }
 * Semantics are kept exactly: a failing ROLLBACK is not swallowed (it propagates, as in the handlers) and the client is
 * always released. Business rejections that the handlers answer with "ROLLBACK, respond 400, return" become
 * `throw new TxAbort(result)`: the transaction is rolled back and the result comes back as `{ committed: false }`.
 * No handler uses this yet; each migration phase switches its handlers and its characterization tests guard the move.
 */
export interface TxClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}
export interface TxPool { connect(): Promise<TxClient> }

export class TxAbort extends Error {
  readonly result: unknown;
  constructor(result: unknown) {
    super("transaction aborted");
    this.name = "TxAbort";
    this.result = result;
  }
}

export type TxOutcome<T> = { committed: true; value: T } | { committed: false; abort: unknown };

export async function withTransaction<T>(pool: TxPool, fn: (client: TxClient) => Promise<T>): Promise<TxOutcome<T>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return { committed: true, value };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e instanceof TxAbort) return { committed: false, abort: e.result };
    throw e;
  } finally {
    client.release();
  }
}
