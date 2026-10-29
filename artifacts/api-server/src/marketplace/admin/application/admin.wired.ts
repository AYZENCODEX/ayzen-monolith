/** MKT-05f composition root: the admin service on the real repositories. Routes import this file, tests import admin.ts. */
import { activityRepo, settingsRepo } from "../infrastructure/admin-repos.wired";
import { createAdminService } from "./admin";

export const adminService = createAdminService(settingsRepo, activityRepo);
