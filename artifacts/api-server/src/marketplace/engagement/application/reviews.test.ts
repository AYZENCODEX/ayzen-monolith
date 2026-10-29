import test from "node:test";
import assert from "node:assert/strict";
import { createReviewsService } from "./reviews";
import { createReviewsRepo, REVIEWS_SQL, type Queryable } from "../infrastructure/reviews-repo";

function fake(answer: (text: string) => any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const db: Queryable = { async query(text: string, params?: any[]) { calls.push({ text, params }); return { rows: answer(text) }; } };
  return { calls, svc: createReviewsService(createReviewsRepo(db)) };
}

test("create: a bad rating is a 400 result before any query", async () => {
  const f = fake(() => []);
  assert.deepEqual(await f.svc.create(1, 2, { rating: 9 }), { ok: false, status: 400, error: "rating must be 1-5" });
  assert.equal(f.calls.length, 0);
});
test("create: looks up the completed order first, 404 result when there is none, then upserts with the order's listing and seller", async () => {
  const none = fake(() => []);
  assert.deepEqual(await none.svc.create(1, 2, { rating: 4 }), { ok: false, status: 404, error: "Completed order not found or not yours" });
  assert.deepEqual(none.calls, [{ text: REVIEWS_SQL.completedOrder, params: [2, 1] }]);
  const f = fake((t) => (t === REVIEWS_SQL.completedOrder ? [{ listing_id: 10, seller_id: 11 }] : [{ id: 99 }]));
  assert.deepEqual(await f.svc.create(1, 2, { rating: "4", comment: "ok" }), { ok: true, row: { id: 99 } });
  assert.deepEqual(f.calls.map((c) => [c.text, c.params]), [[REVIEWS_SQL.completedOrder, [2, 1]], [REVIEWS_SQL.upsert, [2, 10, 1, 11, 4, "ok"]]]);
});
test("update and remove: no row is a 404 result with the original message", async () => {
  assert.deepEqual(await fake(() => []).svc.update(1, 2, { rating: 3 }), { ok: false, status: 404, error: "Review not found or not yours" });
  assert.deepEqual(await fake(() => []).svc.remove(1, 2), { ok: false, status: 404, error: "Review not found or not yours" });
  assert.deepEqual(await fake(() => [{ id: 2 }]).svc.remove(1, 2), { ok: true });
  const f = fake(() => [{ id: 2 }]);
  await f.svc.update(1, 2, { rating: 3, comment: "c" });
  assert.deepEqual(f.calls[0].params, [3, "c", 2, 1]);
});
test("respond: empty response is a 400 result before any query; no row is a 404 result", async () => {
  const f = fake(() => []);
  assert.deepEqual(await f.svc.respond(1, 2, ""), { ok: false, status: 400, error: "response is required" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.svc.respond(1, 2, "thanks"), { ok: false, status: 404, error: "Review not found or not yours to respond to" });
  assert.deepEqual(f.calls[0].params, ["thanks", 2, 1]);
});
test("seller reviews, rating and my reviews pass the original parameters", async () => {
  const f = fake(() => [{ review_count: 3 }]);
  await f.svc.sellerReviews(5, 20, 40); assert.deepEqual(f.calls[0].params, [5, 20, 40]);
  assert.deepEqual(await f.svc.sellerRating(5), { review_count: 3 });
  await f.svc.myReviews(8); assert.deepEqual(f.calls.map((c) => c.params), [[5, 20, 40], [5], [8]]);
});
