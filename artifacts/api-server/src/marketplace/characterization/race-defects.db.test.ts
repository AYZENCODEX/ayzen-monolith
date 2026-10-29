// MKT-01b-1: concurrency and public-write defects, characterized against the UNMODIFIED routes. Race outcomes are timing
// dependent, so these tests assert only what holds either way (the ledger agrees with itself) and REPORT whether the defect
// showed up through t.diagnostic (visible in the TAP output). Send that output back: it decides BC-4 / BC-5.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import marketplaceRouter from "../../routes/marketplace";
import aznRouter from "../../routes/marketplace-azn";
import nftRouter from "../../routes/marketplace-nft";
import analyticsRouter from "../../routes/marketplace-analytics";
import { call, createUser, creditsOf, pool, resetTables, seedAznSellListing, seedNftListing, seedP2pListing, seedWallet, startApp, walletOf } from "./harness";

let app: { base: string; close: () => Promise<void> };
before(async () => { app = await startApp([marketplaceRouter, aznRouter, nftRouter, analyticsRouter]); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(resetTables);

test("MKT-ISSUE-7 race: parallel buys by one buyer who can afford one", async (t) => {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer", 40);
  const listingId = await seedP2pListing(sellerId, 40);
  const N = 6;
  const replies = await Promise.all(Array.from({ length: N }, () => call(app.base, { userId: buyerId }, "POST", `/marketplace/listings/${listingId}/buy`, {})));
  const accepted = replies.filter((r) => r.status === 201).length;
  const orders = (await pool.query("SELECT count(*)::int AS n FROM marketplace_orders")).rows[0].n;
  const balance = await creditsOf(buyerId);
  t.diagnostic(`MKT-ISSUE-7 race: ${accepted} of ${N} parallel buys accepted for a buyer who can afford 1; final azn_balance=${balance}; defect ${accepted > 1 || (balance ?? 0) < 0 ? "REPRODUCED" : "not reproduced in this run"}`);
  assert.equal(orders, accepted, "every accepted buy has an order row");
  assert.equal(balance, 40 - 40 * accepted, "the balance equals what the accepted orders escrowed");
});

test("MKT-ISSUE-6 race: parallel buys of one AZN sell listing", async (t) => {
  const sellerId = await createUser("seller");
  await seedWallet(sellerId, "azn", 0, 10);
  const listingId = await seedAznSellListing(sellerId, 10, 1);
  const N = 5;
  const buyers: number[] = [];
  for (let i = 0; i < N; i++) { const id = await createUser(`buyer${i}`); await seedWallet(id, "azn", 10, 0); buyers.push(id); }
  const replies = await Promise.all(buyers.map((id) => call(app.base, { userId: id }, "POST", "/marketplace/azn/buy", { listing_id: listingId, amount: 10 })));
  const accepted = replies.filter((r) => r.status === 200).length;
  const tx = (await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions WHERE market_type='azn'")).rows[0].n;
  const seller = (await walletOf(sellerId, "azn"))!;
  t.diagnostic(`MKT-ISSUE-6 race: ${accepted} of ${N} parallel buys of ONE 10-unit listing succeeded; seller balance=${seller.balance} locked_balance=${seller.locked}; defect ${accepted > 1 ? "REPRODUCED" : "not reproduced in this run"}`);
  assert.equal(tx, accepted, "every accepted buy wrote one transaction row");
  assert.equal(seller.balance, 10 * accepted);
  assert.equal(seller.locked, 10 - 10 * accepted);
});

test("MKT-ISSUE-5 race: parallel NFT likes by different users", async (t) => {
  const sellerId = await createUser("seller");
  const nftId = await seedNftListing(sellerId, 5);
  const N = 6;
  const users: number[] = [];
  for (let i = 0; i < N; i++) users.push(await createUser(`liker${i}`));
  const replies = await Promise.all(users.map((id) => call(app.base, { userId: id }, "POST", `/marketplace/nft/listings/${nftId}/like`, {})));
  assert.ok(replies.every((r) => r.status === 200));
  const row = (await pool.query("SELECT likes, liked_by FROM nft_market_listings WHERE id=$1", [nftId])).rows[0];
  const likedBy = JSON.parse(row.liked_by) as number[];
  t.diagnostic(`MKT-ISSUE-5 race: ${N} concurrent likes produced likes=${row.likes}; defect ${row.likes < N ? "REPRODUCED (likes lost)" : "not reproduced in this run"}`);
  assert.equal(row.likes, likedBy.length, "the counter agrees with the stored list");
});

test("MKT-ISSUE-1 (deterministic): anonymous requests raise a listing's view_count", async () => {
  const sellerId = await createUser("seller");
  const listingId = await seedP2pListing(sellerId, 5);
  const replies = await Promise.all(Array.from({ length: 25 }, () => call(app.base, null, "POST", `/marketplace/listings/${listingId}/view`)));
  assert.ok(replies.every((r) => r.status === 200), "no authentication, no rate limit");
  assert.equal((await pool.query("SELECT view_count FROM marketplace_listings WHERE id=$1", [listingId])).rows[0].view_count, 25);
});
