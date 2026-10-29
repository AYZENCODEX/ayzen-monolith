import test from "node:test";
import assert from "node:assert/strict";
import { createAdminService } from "./admin";
import { createActivityRepo } from "../infrastructure/activity-repo";
import { createSettingsRepo, SETTINGS_SQL, type Queryable } from "../infrastructure/settings-repo";

function build(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createAdminService(createSettingsRepo(db), createActivityRepo(db)) };
}

test("settings: the read runs with NO parameter array; no row gives undefined; the update upserts with the original parameters", async () => {
  const none = build(() => []);
  assert.equal(await none.svc.getSettings(), undefined);
  assert.deepEqual(none.calls, [{ text: SETTINGS_SQL.get, params: undefined }]);
  const row = build(() => [{ id: 1, fee_pct: 4, enabled: true }]);
  assert.deepEqual(await row.svc.getSettings(), { id: 1, fee_pct: 4, enabled: true });
  const up = build(() => []);
  await up.svc.updateSettings({ fee_pct: 3 });
  assert.deepEqual(up.calls, [{ text: SETTINGS_SQL.upsert, params: [3, true] }]);
});
test("activity: the list statement runs first, the count statement second, total is a number", async () => {
  const f = build((t) => (t.startsWith("SELECT COUNT") ? [{ count: "12" }] : [{ id: 1 }, { id: 2 }]));
  const r = await f.svc.activityLog({ event_type: "order_approved", limit: "10", offset: 20 });
  assert.deepEqual(r, { entries: [{ id: 1 }, { id: 2 }], total: 12 });
  assert.deepEqual(f.calls.map((c) => c.params), [["order_approved", 10, 20], ["order_approved"]]);
  assert.ok(f.calls[0].text.startsWith("SELECT * FROM marketplace_activity_log WHERE event_type = $1 ORDER BY"));
  const g = build((t) => (t.startsWith("SELECT COUNT") ? [{ count: "0" }] : []));
  await g.svc.activityLog({});
  assert.deepEqual(g.calls.map((c) => c.params), [[50, 0], []]);
});
test("database errors are not swallowed (the route decides what to answer)", async () => {
  const db: Queryable = { async query() { throw new Error("boom"); } };
  await assert.rejects(createAdminService(createSettingsRepo(db), createActivityRepo(db)).getSettings(), /boom/);
});
