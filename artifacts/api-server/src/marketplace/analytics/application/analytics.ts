/**
 * marketplace/analytics/application/analytics.ts
 * MKT-05b: use cases behind the six analytics routes. Behavior is unchanged: `days` keeps being turned into a string with
 * String(Number(days)) before it reaches the database (a non-numeric value still gives "NaN" and a database error, answered
 * 500 by the route adapter); a missing listing is a 404 result; everything else that fails is thrown. Charging credits for the
 * metered reports stays in the route adapter, after the query and before the response, in the same order as before.
 */
import type { AnalyticsRepo } from "../infrastructure/analytics-repo";

export type NotFound = { ok: false; status: 404; error: string };
export type ViewResult = { ok: true; viewCount: unknown } | NotFound;

export function createAnalyticsService(repo: AnalyticsRepo) {
  return {
    async overview(userId: number): Promise<any> { return (await repo.overview(userId))[0]; },
    revenue: (userId: number, days: unknown): Promise<any[]> => repo.revenue(userId, String(Number(days))),
    topListings: (userId: number): Promise<any[]> => repo.topListings(userId),
    async views(id: number): Promise<ViewResult> {
      const rows = await repo.listingViews(id);
      return rows.length === 0 ? { ok: false, status: 404, error: "Listing not found" } : { ok: true, viewCount: rows[0].view_count };
    },
    async recordView(id: number): Promise<ViewResult> {
      const rows = await repo.recordView(id);
      return rows.length === 0 ? { ok: false, status: 404, error: "Listing not found" } : { ok: true, viewCount: rows[0].view_count };
    },
    platform: (days: unknown): Promise<any[]> => repo.platform(String(Number(days))),
  };
}
