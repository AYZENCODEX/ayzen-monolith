import test from "node:test";
import assert from "node:assert/strict";
import { createAlertsService } from "./alerts";
import { ALERTS_SQL, createAlertsRepo, type Queryable } from "../infrastructure/alerts-repo";

function fake(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createAlertsService(createAlertsRepo(db)) };
}

test("create: invalid input is a 400 result and no query runs; valid input inserts with the original parameters", async () => {
  const bad = fake(() => []);
  assert.deepEqual(await bad.svc.create(1, {}), { ok: false, status: 400, error: "At least a keyword or listing_type is required" });
  assert.equal(bad.calls.length, 0);
  const good = fake(() => [{ id: 4 }]);
  assert.deepEqual(await good.svc.create(1, { keyword: "k", max_price_azn: "5" }), { ok: true, row: { id: 4 } });
  assert.deepEqual(good.calls, [{ text: ALERTS_SQL.insert, params: [1, "k", null, 5, null] }]);
});
test("update: no fields is a 400 result without a query; no row is a 404 result; a row is returned", async () => {
  const none = fake(() => []);
  assert.deepEqual(await none.svc.update(1, 2, {}), { ok: false, status: 400, error: "No fields to update" });
  assert.equal(none.calls.length, 0);
  assert.deepEqual(await none.svc.update(1, 2, { is_active: true }), { ok: false, status: 404, error: "Alert not found or not yours" });
  assert.deepEqual(none.calls[0].params, [true, 2, 1]);
  assert.deepEqual(await fake(() => [{ id: 2 }]).svc.update(1, 2, { is_active: false }), { ok: true, row: { id: 2 } });
});
test("remove: no row is a 404 result; the statement gets (id, userId)", async () => {
  const f = fake(() => []);
  assert.deepEqual(await f.svc.remove(1, 2), { ok: false, status: 404, error: "Alert not found or not yours" });
  assert.deepEqual(f.calls, [{ text: ALERTS_SQL.remove, params: [2, 1] }]);
  assert.deepEqual(await fake(() => [{ id: 2 }]).svc.remove(1, 2), { ok: true });
});
test("saved searches: validation result, JSON-encoded filters, list by user", async () => {
  assert.equal((await fake(() => []).svc.createSavedSearch(1, { name: "n" })).ok, false);
  const f = fake(() => [{ id: 1 }]);
  assert.deepEqual(await f.svc.createSavedSearch(1, { name: "n", filters: { q: 1 } }), { ok: true, row: { id: 1 } });
  await f.svc.listSavedSearches(1); await f.svc.list(1);
  assert.deepEqual(f.calls.map((c) => c.params), [[1, "n", '{"q":1}'], [1], [1]]);
});
test("database errors are not swallowed", async () => {
  const db: Queryable = { async query() { throw new Error("boom"); } };
  await assert.rejects(createAlertsService(createAlertsRepo(db)).list(1), /boom/);
});
