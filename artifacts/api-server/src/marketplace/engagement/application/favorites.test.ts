import test from "node:test";
import assert from "node:assert/strict";
import { createFavoritesService } from "./favorites";
import { createFavoritesRepo, FAVORITES_SQL, type Queryable } from "../infrastructure/favorites-repo";

function build(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createFavoritesService(createFavoritesRepo(db)) };
}

test("add: an unknown listing is a 404 result without an insert", async () => {
  const f = build(() => []);
  assert.deepEqual(await f.svc.add(1, 2), { ok: false, status: 404, error: "Listing not found" });
  assert.deepEqual(f.calls, [{ text: FAVORITES_SQL.listingExists, params: [2] }]);
});
test("add: a new favorite returns the inserted row; an existing one returns the 'Already favorited' message", async () => {
  const fresh = build((t) => (t === FAVORITES_SQL.listingExists ? [{ id: 2 }] : [{ id: 5, user_id: 1, listing_id: 2 }]));
  assert.deepEqual(await fresh.svc.add(1, 2), { ok: true, body: { id: 5, user_id: 1, listing_id: 2 } });
  assert.deepEqual(fresh.calls[1], { text: FAVORITES_SQL.insert, params: [1, 2] });
  const dup = build((t) => (t === FAVORITES_SQL.listingExists ? [{ id: 2 }] : []));
  assert.deepEqual(await dup.svc.add(1, 2), { ok: true, body: { message: "Already favorited" } });
});
test("remove never checks anything; list is by user", async () => {
  const f = build(() => [{ favorite_id: 1 }]);
  await f.svc.remove(1, 2);
  assert.deepEqual(await f.svc.list(1), [{ favorite_id: 1 }]);
  assert.deepEqual(f.calls.map((c) => [c.text, c.params]), [[FAVORITES_SQL.remove, [1, 2]], [FAVORITES_SQL.list, [1]]]);
});
