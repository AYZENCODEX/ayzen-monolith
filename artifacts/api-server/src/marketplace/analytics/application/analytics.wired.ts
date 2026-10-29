/** MKT-05b composition root: the analytics service on the real repository. Routes import this file, tests import analytics.ts. */
import { analyticsRepo } from "../infrastructure/analytics-repo.wired";
import { createAnalyticsService } from "./analytics";

export const analytics = createAnalyticsService(analyticsRepo);
