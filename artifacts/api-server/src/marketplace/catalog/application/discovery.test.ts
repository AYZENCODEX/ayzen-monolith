import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryService } from "./discovery";
import { createDiscoveryRepo, DISCOVERY_SQL, type Queryable } from "../infrastructure/discovery-repo";

function fakeDb(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, service: createDiscoveryService(createDiscoveryRepo(db)) };
}

test("similar: reads the base listing, then the ten nearest by price with the same type", async () => {
  const f = fakeDb((t) => (t === DISCOVERY_SQL.base ? [{ listing_type: "wallet", price_azn: 12.5 }] : [{ id: 2 }, { id: 3 }]));
  const r = await f.service.similar(7);
  assert.deepEqual(r, { ok: true, rows: [{ id: 2 }, { id: 3 }] });
  assert.deepEqual(f.calls, [{ text: DISCOVERY_SQL.base, params: [7] }, { text: DISCOVERY_SQL.similar, params: [7, "wallet", 12.5] }]);
});
test("similar: an unknown listing is a 404 result and the second query never runs", async () => {
  const f = fakeDb(() => []);
  assert.deepEqual(await f.service.similar(7), { ok: false, status: 404, error: "Listing not found" });
  assert.equal(f.calls.length, 1);
});
test("similar: NaN id is passed through as before (the database decides, the route answers 500)", async () => {
  const f = fakeDb(() => []);
  await f.service.similar(Number("abc"));
  assert.ok(Number.isNaN(f.calls[0].params![0]));
});
test("trending and featured pass the limit as the only parameter; categories passes no parameter array", async () => {
  const f = fakeDb(() => [{ x: 1 }]);
  assert.deepEqual(await f.service.trending(5), [{ x: 1 }]);
  assert.deepEqual(await f.service.featured(3), [{ x: 1 }]);
  assert.deepEqual(await f.service.categories(), [{ x: 1 }]);
  assert.deepEqual(f.calls.map((c) => [c.text, c.params]), [[DISCOVERY_SQL.trending, [5]], [DISCOVERY_SQL.featured, [3]], [DISCOVERY_SQL.categories, undefined]]);
});
test("database errors are not swallowed (the route adapter turns them into 500 with the message)", async () => {
  const db: Queryable = { async query() { throw new Error("boom"); } };
  await assert.rejects(createDiscoveryService(createDiscoveryRepo(db)).trending(1), /boom/);
});
