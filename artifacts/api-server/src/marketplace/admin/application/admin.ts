/**
 * marketplace/admin/application/admin.ts
 * MKT-05f: use cases behind GET and PATCH /marketplace/settings and GET /admin/marketplace/activity. The route adapter keeps its
 * try/catch: GET settings answers the default body on ANY error (it swallows database failures, as before), PATCH and the
 * activity list answer 500 with the message. The activity list runs the list statement first and the count statement second.
 */
import { buildActivityCount, buildActivityList, type ActivityQuery } from "../domain/activity";
import { settingsParams, type SettingsInput } from "../domain/settings";
import type { ActivityRepo } from "../infrastructure/activity-repo";
import type { SettingsRepo } from "../infrastructure/settings-repo";

export function createAdminService(settings: SettingsRepo, activity: ActivityRepo) {
  return {
    /** The stored settings row, or undefined when there is none (the route then answers the defaults). */
    async getSettings(): Promise<any> { return (await settings.get())[0]; },
    async updateSettings(input: SettingsInput): Promise<void> { await settings.upsert(settingsParams(input)); },
    async activityLog(input: ActivityQuery): Promise<{ entries: any[]; total: number }> {
      const list = buildActivityList(input);
      const entries = await activity.list(list.sql, list.params);
      const count = buildActivityCount(input);
      const countRows = await activity.count(count.sql, count.params);
      return { entries, total: Number(countRows[0].count) };
    },
  };
}
