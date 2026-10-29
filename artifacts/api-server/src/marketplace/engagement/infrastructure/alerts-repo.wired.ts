/** MKT-05c composition root: the alerts repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createAlertsRepo, type AlertsRepo, type Queryable } from "./alerts-repo";

export const alertsRepo: AlertsRepo = createAlertsRepo(pool as unknown as Queryable);
