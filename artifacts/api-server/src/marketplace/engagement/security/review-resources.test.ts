import test from "node:test";
import assert from "node:assert/strict";
import { createReviewResources, REVIEW_OWNER_SENTINEL_NONE } from "./review-resources";

const req = (id: string) => ({ params: { id } }) as any;
const lookups = () => {
  const asked: string[] = [];
  return { asked, repo: {
    async findOrderBuyer(id: number) { asked.push(`order:${id}`); return id === 1 ? [{ buyer_id: 21 }] : []; },
    async findReviewBuyer(id: number) { asked.push(`buyer:${id}`); return id === 1 ? [{ buyer_id: 22 }] : []; },
    async findReviewSeller(id: number) { asked.push(`seller:${id}`); return id === 1 ? [{ seller_id: 23 }] : []; },
  } };
};

test("each builder maps an existing row to the owner column it is about, with its own resource type", async () => {
  const { repo } = lookups(); const r = createReviewResources(repo);
  assert.deepEqual(await r.marketplaceReviewOrderResource(req("1")), { type: "marketplace_order", id: 1, ownerId: 21 });
  assert.deepEqual(await r.marketplaceReviewBuyerResource(req("1")), { type: "marketplace_review", id: 1, ownerId: 22 });
  assert.deepEqual(await r.marketplaceReviewSellerResource(req("1")), { type: "marketplace_review", id: 1, ownerId: 23 });
});
test("a missing row gives the sentinel owner; a non-numeric id gives the sentinel without a query and keeps the raw id", async () => {
  const { repo, asked } = lookups(); const r = createReviewResources(repo);
  assert.equal((await r.marketplaceReviewBuyerResource(req("2"))).ownerId, REVIEW_OWNER_SENTINEL_NONE);
  assert.deepEqual(await r.marketplaceReviewSellerResource(req("abc")), { type: "marketplace_review", id: "abc", ownerId: -1 });
  assert.deepEqual(asked, ["buyer:2"]);
});
