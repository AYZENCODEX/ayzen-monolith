// MKT-01b-2a: wallet deposit/withdraw, USDT buy, NFT buy, characterized against the UNMODIFIED routes. See p2p-orders.db.test.ts
// for how to read a failure. Money columns are REAL (float32): fractional values are compared with a tolerance.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { feeByFraction } from "../kernel/domain/money";
import nftRouter from "../../routes/marketplace-nft";
import usdtRouter from "../../routes/marketplace-usdt";
import walletRouter from "../../routes/marketplace-wallet";
import { call, createUser, creditsOf, near, pool, resetTables, seedNftListing, seedUsdtSellListing, seedWallet, startApp, walletOf } from "./harness";

let app: { base: string; close: () => Promise<void> };
before(async () => { app = await startApp([walletRouter, usdtRouter, nftRouter]); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(resetTables);

// ---- wallet ----
test("wallet summary: azn, nft, vault and game wallets are created on demand (usdt is not one of them)", async () => {
  const u = await createUser("u", 5);
  const r = await call(app.base, { userId: u }, "GET", "/marketplace/wallet");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["azn", "game", "nft", "vault"]);
  for (const k of Object.keys(r.json)) assert.deepEqual(Object.keys(r.json[k]).sort(), ["address", "available", "balance", "locked_balance", "updated_at"]);
  assert.ok(String(r.json.azn.address).startsWith("0xMKT") && String(r.json.azn.address).endsWith("AZN"));
});

test("deposit: moves AZN from credits into the market wallet and conserves the total", async () => {
  const u = await createUser("u", 100);
  const r = await call(app.base, { userId: u }, "POST", "/marketplace/wallet/azn/deposit", { amount: 30 });
  assert.deepEqual([r.status, r.json], [200, { ok: true, balance: 30, deposited: 30 }]);
  assert.equal(await creditsOf(u), 70);
  assert.deepEqual(await walletOf(u, "azn"), { balance: 30, locked: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_wallets WHERE user_id=$1", [u])).rows[0].n, 4);
});

test("deposit and withdraw: invalid type, non-positive amount, insufficient funds, missing credits row, locked funds", async () => {
  const u = await createUser("u", 10);
  const me = { userId: u };
  assert.deepEqual((await call(app.base, me, "POST", "/marketplace/wallet/usdt/deposit", { amount: 1 })).json, { error: "Invalid market type" });
  assert.deepEqual((await call(app.base, me, "POST", "/marketplace/wallet/azn/deposit", { amount: 0 })).json, { error: "amount must be positive" });
  assert.deepEqual((await call(app.base, me, "POST", "/marketplace/wallet/azn/deposit", { amount: 11 })).json, { error: "Insufficient AZN balance in main wallet" });
  assert.equal(await creditsOf(u), 10);
  await pool.query("DELETE FROM credits WHERE user_id=$1", [u]);
  assert.equal((await call(app.base, me, "POST", "/marketplace/wallet/azn/deposit", { amount: 1 })).status, 400);
  await seedWallet(u, "azn", 30, 30);
  const locked = await call(app.base, me, "POST", "/marketplace/wallet/azn/withdraw", { amount: 1 });
  assert.deepEqual([locked.status, locked.json], [400, { error: "Available: 0 AZN" }]);
  const none = await call(app.base, me, "POST", "/marketplace/wallet/nft/withdraw", { amount: 1 });
  assert.deepEqual([none.status, none.json], [400, { error: "Available: 0 AZN" }]);
});

test("withdraw: pays back into credits only from the available part (balance - locked)", async () => {
  const u = await createUser("u", 0);
  await seedWallet(u, "azn", 30, 5);
  const over = await call(app.base, { userId: u }, "POST", "/marketplace/wallet/azn/withdraw", { amount: 26 });
  assert.deepEqual([over.status, over.json], [400, { error: "Available: 25 AZN" }]);
  const ok = await call(app.base, { userId: u }, "POST", "/marketplace/wallet/azn/withdraw", { amount: 20 });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true, withdrawn: 20 }]);
  assert.deepEqual(await walletOf(u, "azn"), { balance: 10, locked: 5 });
  assert.equal(await creditsOf(u), 20);
});

test("GOOD (guarded): parallel deposits cannot spend the same credits twice", async () => {
  const u = await createUser("u", 20);
  const replies = await Promise.all(Array.from({ length: 5 }, () => call(app.base, { userId: u }, "POST", "/marketplace/wallet/azn/deposit", { amount: 10 })));
  assert.equal(replies.filter((r) => r.status === 200).length, 2);
  assert.equal(await creditsOf(u), 0);
  assert.equal((await walletOf(u, "azn"))!.balance, 20);
});

test("GOOD (guarded): parallel withdrawals cannot pay out the same balance twice", async () => {
  const u = await createUser("u", 0);
  await seedWallet(u, "azn", 20, 0);
  const replies = await Promise.all(Array.from({ length: 5 }, () => call(app.base, { userId: u }, "POST", "/marketplace/wallet/azn/withdraw", { amount: 10 })));
  assert.equal(replies.filter((r) => r.status === 200).length, 2);
  assert.equal(await creditsOf(u), 20);
  assert.equal((await walletOf(u, "azn"))!.balance, 0);
});

// ---- USDT market ----
async function usdtSetup(buyerBalance = 50) {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer");
  await seedWallet(sellerId, "usdt", 0, 10);
  await seedWallet(buyerId, "usdt", buyerBalance, 0);
  const listingId = await seedUsdtSellListing(sellerId, 10, 2, 0);
  return { sellerId, buyerId, listingId, buyer: { userId: buyerId } };
}

test("usdt buy: partial fill, then the rest; wallets, listing and transactions follow the handler's arithmetic", async () => {
  const s = await usdtSetup();
  const r1 = await call(app.base, s.buyer, "POST", "/marketplace/usdt/buy", { listing_id: s.listingId, amount: 4 });
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.json.ok, r1.json.amount_bought, r1.json.cost], [true, 4, 8]);
  assert.equal(r1.json.fee, feeByFraction(8, 2.5)); assert.equal(r1.json.net, 8 - feeByFraction(8, 2.5));
  assert.deepEqual(await walletOf(s.buyerId, "usdt"), { balance: 46, locked: 0 }); // -cost +amount
  assert.deepEqual(await walletOf(s.sellerId, "usdt"), { balance: 4, locked: 6 }); // locked -amount, balance +amount
  const l1 = (await pool.query("SELECT amount, total_price, status FROM usdt_listings WHERE id=$1", [s.listingId])).rows[0];
  assert.deepEqual([Number(l1.amount), Number(l1.total_price), l1.status], [6, 12, "active"]);
  const r2 = await call(app.base, s.buyer, "POST", "/marketplace/usdt/buy", { listing_id: s.listingId, amount: 6 });
  assert.equal(r2.status, 200);
  assert.deepEqual(await walletOf(s.buyerId, "usdt"), { balance: 40, locked: 0 });
  assert.deepEqual(await walletOf(s.sellerId, "usdt"), { balance: 10, locked: 0 });
  const l2 = (await pool.query("SELECT status, buyer_id FROM usdt_listings WHERE id=$1", [s.listingId])).rows[0];
  assert.deepEqual([l2.status, l2.buyer_id], ["sold", s.buyerId]);
  const tx = (await pool.query("SELECT amount, fee, net_amount, market_type FROM marketplace_transactions ORDER BY id")).rows;
  assert.equal(tx.length, 2);
  assert.ok(tx.every((t) => t.market_type === "usdt"));
  assert.ok(near(Number(tx[0].amount), 8) && near(Number(tx[0].fee), 0.2) && near(Number(tx[0].net_amount), 7.8));
});

test("usdt buy: validation and guard rejections write nothing", async () => {
  const s = await usdtSetup(5);
  const me = s.buyer;
  const err = async (body: any, who = me) => (await call(app.base, who, "POST", "/marketplace/usdt/buy", body)).json.error;
  assert.equal(await err({}), "listing_id and amount required");
  assert.equal(await err({ listing_id: 999, amount: 1 }), "Listing not found or sold");
  assert.equal(await err({ listing_id: s.listingId, amount: 1 }, { userId: s.sellerId }), "Cannot buy your own listing");
  assert.equal(await err({ listing_id: s.listingId, amount: 11 }), "Amount exceeds listing");
  assert.equal(await err({ listing_id: s.listingId, amount: 4 }), "Insufficient balance"); // cost 8 > 5
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions")).rows[0].n, 0);
  assert.deepEqual(await walletOf(s.buyerId, "usdt"), { balance: 5, locked: 0 });
});

test("MKT-ISSUE-6 race (usdt): parallel buys of one sell listing", async (t) => {
  const sellerId = await createUser("seller");
  await seedWallet(sellerId, "usdt", 0, 10);
  const listingId = await seedUsdtSellListing(sellerId, 10, 1);
  const N = 5; const buyers: number[] = [];
  for (let i = 0; i < N; i++) { const id = await createUser(`b${i}`); await seedWallet(id, "usdt", 10, 0); buyers.push(id); }
  const replies = await Promise.all(buyers.map((id) => call(app.base, { userId: id }, "POST", "/marketplace/usdt/buy", { listing_id: listingId, amount: 10 })));
  const accepted = replies.filter((r) => r.status === 200).length;
  const seller = (await walletOf(sellerId, "usdt"))!;
  t.diagnostic(`MKT-ISSUE-6 race (usdt): ${accepted} of ${N} parallel buys of ONE 10-unit listing succeeded; seller balance=${seller.balance} locked_balance=${seller.locked}; defect ${accepted > 1 ? "REPRODUCED" : "not reproduced in this run"}`);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions WHERE market_type='usdt'")).rows[0].n, accepted);
  assert.equal(seller.balance, 10 * accepted);
  assert.equal(seller.locked, 10 - 10 * accepted);
});

// ---- NFT market ----
async function nftSetup(opts: { sellerWallet?: boolean; buyerBalance?: number } = {}) {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer");
  if (opts.sellerWallet !== false) await seedWallet(sellerId, "nft", 0, 0);
  await seedWallet(buyerId, "nft", opts.buyerBalance ?? 20, 0);
  const listingId = await seedNftListing(sellerId, 10);
  return { sellerId, buyerId, listingId, buyer: { userId: buyerId } };
}

test("nft buy: price leaves the buyer, price - 3% reaches the seller, listing is sold once, views+1, transaction recorded", async () => {
  const s = await nftSetup();
  const r = await call(app.base, s.buyer, "POST", "/marketplace/nft/buy", { listing_id: s.listingId });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.ok, r.json.nft_name, r.json.price], [true, "Test NFT", 10]);
  assert.equal(r.json.fee, feeByFraction(10, 3)); assert.equal(r.json.net, 10 - feeByFraction(10, 3));
  assert.deepEqual(await walletOf(s.buyerId, "nft"), { balance: 10, locked: 0 });
  assert.ok(near((await walletOf(s.sellerId, "nft"))!.balance, 9.7));
  const l = (await pool.query("SELECT status, buyer_id, views FROM nft_market_listings WHERE id=$1", [s.listingId])).rows[0];
  assert.deepEqual([l.status, l.buyer_id, l.views], ["sold", s.buyerId, 1]);
  const tx = (await pool.query("SELECT market_type, amount, fee, net_amount FROM marketplace_transactions")).rows;
  assert.equal(tx.length, 1); assert.equal(tx[0].market_type, "nft");
  assert.ok(near(Number(tx[0].fee), 0.3) && near(Number(tx[0].net_amount), 9.7));
  const again = await call(app.base, { userId: s.buyerId }, "POST", "/marketplace/nft/buy", { listing_id: s.listingId });
  assert.deepEqual([again.status, again.json.error], [404, "NFT not found or already sold"]);
});

test("nft buy: missing id, own NFT and insufficient wallet balance are rejected without any write", async () => {
  const s = await nftSetup({ buyerBalance: 5 });
  assert.equal((await call(app.base, s.buyer, "POST", "/marketplace/nft/buy", {})).json.error, "listing_id required");
  assert.equal((await call(app.base, { userId: s.sellerId }, "POST", "/marketplace/nft/buy", { listing_id: s.listingId })).json.error, "Cannot buy your own NFT");
  assert.equal((await call(app.base, s.buyer, "POST", "/marketplace/nft/buy", { listing_id: s.listingId })).json.error, "Insufficient balance in NFT wallet");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions")).rows[0].n, 0);
  assert.deepEqual(await walletOf(s.buyerId, "nft"), { balance: 5, locked: 0 });
});

test("GOOD (status guard): parallel buyers of one NFT, exactly one wins and only the winner pays", async () => {
  const sellerId = await createUser("seller");
  await seedWallet(sellerId, "nft", 0, 0);
  const listingId = await seedNftListing(sellerId, 10);
  const buyers: number[] = [];
  for (let i = 0; i < 4; i++) { const id = await createUser(`b${i}`); await seedWallet(id, "nft", 10, 0); buyers.push(id); }
  const replies = await Promise.all(buyers.map((id) => call(app.base, { userId: id }, "POST", "/marketplace/nft/buy", { listing_id: listingId })));
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions WHERE market_type='nft'")).rows[0].n, 1);
  let total = 0; for (const id of buyers) total += (await walletOf(id, "nft"))!.balance;
  assert.equal(total, 30, "three losers keep their 10, the winner paid it");
});

test("DEFECT PINNED (MKT-ISSUE-9): selling an NFT to a seller who has no nft wallet row debits the buyer and credits nobody", async () => {
  const s = await nftSetup({ sellerWallet: false });
  const r = await call(app.base, s.buyer, "POST", "/marketplace/nft/buy", { listing_id: s.listingId });
  assert.equal(r.status, 200, "the sale is reported as successful");
  assert.deepEqual(await walletOf(s.buyerId, "nft"), { balance: 10, locked: 0 }, "the buyer paid");
  assert.equal(await walletOf(s.sellerId, "nft"), null, "the seller has no wallet row, so the UPDATE credited nothing and nothing checked rowCount");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_transactions WHERE market_type='nft'")).rows[0].n, 1);
});
