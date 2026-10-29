import test from "node:test";
import assert from "node:assert/strict";
import { parseNewRating, sellerReviewsParams, updateReviewParams, upsertReviewParams } from "./reviews";

// ---- reference: the logic exactly as routes/marketplace-reviews.ts had it before MKT-05d ----
const refInvalid = (rating: any) => { const r5 = Number(rating); return !r5 || r5 < 1 || r5 > 5; };
const refUpdate = (userId: number, id: number, body: any) => { const { rating, comment } = body; return [rating ? Number(rating) : null, comment ?? null, id, userId]; };
const values: any[] = [undefined, null, "", "abc", 0, "0", 1, "1", 3.5, 5, "5", 5.0001, 6, -1, true, false, {}, [], [4], NaN, Infinity];

test("parseNewRating accepts and rejects exactly what the original check did", () => {
  for (const v of values) {
    const got = parseNewRating(v);
    assert.equal(got === null, refInvalid(v), String(v));
    if (got !== null) assert.equal(got, Number(v));
  }
});
test("updateReviewParams equals the original parameter array for every rating x comment combination", () => {
  for (const rating of values) for (const comment of values) assert.deepEqual(updateReviewParams(9, 4, { rating, comment }), refUpdate(9, 4, { rating, comment }));
});
test("upsertReviewParams and sellerReviewsParams", () => {
  assert.deepEqual(upsertReviewParams(3, { listing_id: 10, seller_id: 11 }, 7, 4, ""), [3, 10, 7, 11, 4, null]);
  assert.deepEqual(upsertReviewParams(3, { listing_id: 10, seller_id: 11 }, 7, 4, "nice"), [3, 10, 7, 11, 4, "nice"]);
  assert.deepEqual(sellerReviewsParams(5, undefined, "x").map((x) => (Number.isNaN(x) ? "NaN" : x)), [5, "NaN", "NaN"]);
  assert.deepEqual(sellerReviewsParams(5, "20", 40), [5, 20, 40]);
});
