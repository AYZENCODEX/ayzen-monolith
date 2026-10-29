import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyticsService } from "./analytics";
import { ANALYTICS_SQL, createAnalyticsRepo, type Queryable } from "../infrastructure/analytics-repo";

function fake(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createAnalyticsService(createAnalyticsRepo(db)) };
}

test("overview returns the first row (or undefined) and passes the user id", async () => {
  const f = fake(() => [{ active_listings: 2 }]);
  assert.deepEqual(await f.svc.overview(9), { active_listings: 2 });
  assert.deepEqual(f.calls, [{ text: ANALYTICS_SQL.overview, params: [9] }]);
  assert.equal(await fake(() => []).svc.overview(9), undefined);
});
test("revenue and platform turn days into String(Number(days)), exactly as the route did", async () => {
  const f = fake(() => []);
  await f.svc.revenue(3, 30); await f.svc.revenue(3, "7"); await f.svc.platform(14); await f.svc.platform("x");
  assert.deepEqual(f.calls.map((c) => c.params), [[3, "30"], [3, "7"], ["14"], ["NaN"]]);
});
test("topListings passes only the user id", async () => {
  const f = fake(() => [{ id: 1 }]);
  assert.deepEqual(await f.svc.topListings(4), [{ id: 1 }]);
  assert.deepEqual(f.calls, [{ text: ANALYTICS_SQL.topListings, params: [4] }]);
});
test("views and recordView: a row gives the count, no row is a 404 result", async () => {
  assert.deepEqual(await fake(() => [{ view_count: 5 }]).svc.views(1), { ok: true, viewCount: 5 });
  assert.deepEqual(await fake(() => []).svc.views(1), { ok: false, status: 404, error: "Listing not found" });
  const f = fake(() => [{ view_count: 6 }]);
  assert.deepEqual(await f.svc.recordView(1), { ok: true, viewCount: 6 });
  assert.equal(f.calls[0].text, ANALYTICS_SQL.recordView);
  assert.deepEqual(await fake(() => []).svc.recordView(1), { ok: false, status: 404, error: "Listing not found" });
});
test("database errors are not swallowed", async () => {
  const db: Queryable = { async query() { throw new Error("boom"); } };
  await assert.rejects(createAnalyticsService(createAnalyticsRepo(db)).platform(30), /boom/);
});
