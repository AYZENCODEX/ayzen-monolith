/** MKT-05c composition root: the alerts service on the real repository. Routes import this file, tests import alerts.ts. */
import { alertsRepo } from "../infrastructure/alerts-repo.wired";
import { createAlertsService } from "./alerts";

export const alerts = createAlertsService(alertsRepo);
