import test from "node:test";
import assert from "node:assert/strict";
import { buildActivityCount, buildActivityList } from "./activity";
import { defaultSettings, settingsParams } from "./settings";

// ---- reference: the handler logic exactly as routes/marketplace.ts had it before MKT-05f ----
function refList(query: any) {
  const { event_type, limit = 50, offset = 0 } = query;
  let q = `SELECT * FROM marketplace_activity_log`;
  const params: any[] = [];
  if (event_type) { q += ` WHERE event_type = $${params.length + 1}`; params.push(event_type); }
  q += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(Number(limit), Number(offset));
  return { sql: q, params };
}
function refCount(query: any) {
  const { event_type } = query;
  const countQ = `SELECT COUNT(*) FROM marketplace_activity_log${event_type ? " WHERE event_type=$1" : ""}`;
  return { sql: countQ, params: event_type ? [event_type] : [] };
}
const values: any[] = [undefined, null, "", "order_approved", "x", 0, 1, "25", "abc", 7.5, true, false, {}];

test("activity list and count: SQL text and parameters equal the original for every event_type x limit x offset", () => {
  let n = 0;
  for (const event_type of values) for (const limit of values) for (const offset of values) {
    const q = { event_type, limit, offset };
    const got = buildActivityList(q); const ref = refList(q);
    assert.equal(got.sql, ref.sql); assert.deepEqual(got.params.map((x) => (Number.isNaN(x) ? "NaN" : x)), ref.params.map((x) => (Number.isNaN(x) ? "NaN" : x)));
    assert.deepEqual(buildActivityCount(q), refCount(q));
    n++;
  }
  assert.equal(n, values.length ** 3);
});
test("settings parameters: fee falls back to the P2P default 5, enabled to true; zero and false are kept", () => {
  assert.deepEqual(settingsParams({}), [5, true]);
  assert.deepEqual(settingsParams({ fee_pct: null, enabled: null }), [5, true]);
  assert.deepEqual(settingsParams({ fee_pct: 0, enabled: false }), [0, false]);
  assert.deepEqual(settingsParams({ fee_pct: "7", enabled: 0 }), ["7", 0]);
  assert.deepEqual(defaultSettings(), { fee_pct: 5, enabled: true });
});
