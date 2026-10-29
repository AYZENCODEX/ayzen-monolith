import { db } from "@workspace/db";

/** A drizzle transaction handle (the `tx` passed to `db.transaction(async (tx) => ...)`). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Anything a repository function may run a query on: the shared pool or an open transaction. */
export type DbExecutor = typeof db | DbTx;

/** The shared pool, for code that must choose between it and an override handle (VLT-GAP-12). */
export const defaultDb: typeof db = db;

/** `db.transaction` — the only way Vault application code opens a transaction (VLT-GAP-12). */
export const runInTransaction = ((...args: Parameters<typeof db.transaction>) => db.transaction(...args)) as typeof db.transaction;
