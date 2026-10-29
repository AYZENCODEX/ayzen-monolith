/** MKT-05f composition root: the admin repositories (settings, activity log) on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createActivityRepo, type ActivityRepo } from "./activity-repo";
import { createSettingsRepo, type Queryable, type SettingsRepo } from "./settings-repo";

export const settingsRepo: SettingsRepo = createSettingsRepo(pool as unknown as Queryable);
export const activityRepo: ActivityRepo = createActivityRepo(pool as unknown as Queryable);
