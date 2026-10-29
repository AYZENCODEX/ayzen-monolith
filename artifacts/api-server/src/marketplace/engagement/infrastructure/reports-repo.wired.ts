/** MKT-05e composition root: the reports repository and the connection source for the moderation transaction. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import type { TxClient } from "../../kernel/infrastructure/tx";
import { createReportsRepo, type Queryable, type ReportsRepo } from "./reports-repo";

export const reportsRepo: ReportsRepo = createReportsRepo(pool as unknown as Queryable);
export const connectReports = (): Promise<TxClient> => pool.connect() as unknown as Promise<TxClient>;
