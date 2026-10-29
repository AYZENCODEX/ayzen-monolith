import test from "node:test";
import assert from "node:assert/strict";
import { createListingsService } from "./listings";
import { createListingsRepo, LISTINGS_SQL, type Queryable } from "../infrastructure/listings-repo";

function build(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createListingsService(createListingsRepo(db)) };
}

test("list: the list statement runs first, the count statement second; total is a number", async () => {
  const f = build((t) => (t.startsWith("SELECT COUNT") ? [{ count: "7" }] : [{ id: 1 }]));
  assert.deepEqual(await f.svc.list({ type: "wallet", limit: "10", offset: 5 }), { listings: [{ id: 1 }], total: 7 });
  assert.deepEqual(f.calls.map((c) => c.params), [["wallet", 10, 5], ["wallet"]]);
  const g = build((t) => (t.startsWith("SELECT COUNT") ? [{ count: "0" }] : []));
  await g.svc.list({});
  assert.deepEqual(g.calls.map((c) => c.params), [[50, 0], []]);
});
test("detail: no listing is a 404 result and the pricing query never runs; otherwise listing plus platform pricing", async () => {
  const none = build(() => []);
  assert.deepEqual(await none.svc.detail(9), { ok: false, status: 404, error: "Listing not found" });
  assert.equal(none.calls.length, 1);
  const f = build((t) => (t === LISTINGS_SQL.detail ? [{ id: 9, title: "t" }] : [{ platform: "ios", price_azn: 3 }]));
  assert.deepEqual(await f.svc.detail(9), { ok: true, listing: { id: 9, title: "t" }, platformPricing: [{ platform: "ios", price_azn: 3 }] });
  assert.deepEqual(f.calls.map((c) => [c.text, c.params]), [[LISTINGS_SQL.detail, [9]], [LISTINGS_SQL.pricing, [9]]]);
});
test("mine, adminList (no parameter array), history and search", async () => {
  const f = build(() => [{ id: 1 }, { id: 2 }]);
  await f.svc.mine(4); await f.svc.adminList(); await f.svc.history(8);
  assert.deepEqual(f.calls.map((c) => c.params), [[4], undefined, [8]]);
  assert.deepEqual(await f.svc.search({ q: "x" }), { listings: [{ id: 1 }, { id: 2 }], count: 2 });
});
test("database errors are not swallowed", async () => {
  const db: Queryable = { async query() { throw new Error("boom"); } };
  await assert.rejects(createListingsService(createListingsRepo(db)).mine(1), /boom/);
});
