/** MKT-05e composition root: the reports service on the real repository and pool connections. */
import { connectReports, reportsRepo } from "../infrastructure/reports-repo.wired";
import { createReportsService } from "./reports";

export const reports = createReportsService(reportsRepo, connectReports);
