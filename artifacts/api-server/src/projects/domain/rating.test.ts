import assert from "node:assert/strict";
import test from "node:test";
import { formatOwnRating, parseRatingValue, RATING_ERROR, summarizeRatings } from "./rating";

// PRJ-03: pins the rating rules moved out of routes/projects.ts.

test("parseRatingValue accepts integers 1..5 using Number() coercion", () => {
  for (const ok of [1, 2, 3, 4, 5, "5", "1", true, 4.0]) assert.ok(parseRatingValue(ok) !== null, String(ok));
  assert.equal(parseRatingValue("5"), 5);
  assert.equal(parseRatingValue(true), 1);
  for (const bad of [0, 6, -1, 3.5, "abc", null, undefined, "", NaN, [], {}]) assert.equal(parseRatingValue(bad), null, String(bad));
  assert.equal(RATING_ERROR, "rating must be an integer from 1 to 5");
});

test("summarizeRatings computes count, rounded average, distribution and Unknown username", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const mk = (id: number, rating: number) => ({ id, userId: id, rating, comment: null, createdAt: d, updatedAt: d });
  const s = summarizeRatings([{ r: mk(1, 5), username: "a" }, { r: mk(2, 4), username: null }, { r: mk(3, 4), username: "c" }]);
  assert.equal(s.count, 3);
  assert.equal(s.average, 4.33);
  assert.deepEqual(s.distribution, { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 });
  assert.equal(s.ratings[1].username, "Unknown");
  assert.equal(s.ratings[0].createdAt, d.toISOString());
  const empty = summarizeRatings([]);
  assert.deepEqual(empty, { ratings: [], count: 0, average: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
});

test("formatOwnRating keeps columns and ISO-formats both timestamps", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(formatOwnRating({ id: 1, rating: 3, createdAt: d, updatedAt: d }), { id: 1, rating: 3, createdAt: d.toISOString(), updatedAt: d.toISOString() });
});
