/** MKT-05b composition root: the analytics repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createAnalyticsRepo, type AnalyticsRepo, type Queryable } from "./analytics-repo";

export const analyticsRepo: AnalyticsRepo = createAnalyticsRepo(pool as unknown as Queryable);
