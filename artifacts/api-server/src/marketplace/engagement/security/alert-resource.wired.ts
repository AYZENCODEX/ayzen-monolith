/** MKT-05c composition root: the alert resource builder on the real repository. */
import { alertsRepo } from "../infrastructure/alerts-repo.wired";
import { createAlertResourceBuilder } from "./alert-resource";

export const marketplaceAlertResource = createAlertResourceBuilder(alertsRepo);
