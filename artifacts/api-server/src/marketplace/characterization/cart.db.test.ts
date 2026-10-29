// MKT-01b-2a: cart checkout, characterized against the UNMODIFIED routes/marketplace-cart.ts.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import cartRouter from "../../routes/marketplace-cart";
import { call, createUser, creditsOf, pool, resetTables, seedCartItem, seedP2pListing, startApp } from "./harness";

let app: { base: string; close: () => Promise<void> };
before(async () => { app = await startApp([cartRouter]); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(resetTables);

async function setup(buyerAzn = 100) {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer", buyerAzn);
  const a = await seedP2pListing(sellerId, 10);
  const b = await seedP2pListing(sellerId, 15);
  await seedCartItem(buyerId, a, 10); await seedCartItem(buyerId, b, 15);
  return { sellerId, buyerId, a, b, buyer: { userId: buyerId } };
}
const count = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].n as number;

test("checkout: one pending order per cart item at fee 5, total escrowed from credits, cart emptied, listings stay active", async () => {
  const s = await setup();
  const r = await call(app.base, s.buyer, "POST", "/marketplace/cart/checkout", { message: "bundle please" });
  assert.equal(r.status, 201);
  assert.equal(r.json.total_azn, 25); assert.equal(r.json.message, "2 order(s) placed. Pending admin approval.");
  assert.equal(r.json.orders.length, 2);
  for (const o of r.json.orders) { assert.equal(o.status, "pending"); assert.equal(Number(o.fee_pct), 5); assert.equal(o.buyer_id, s.buyerId); assert.equal(o.message, "bundle please"); }
  assert.deepEqual(r.json.orders.map((o: any) => Number(o.price_azn)).sort((x: number, y: number) => x - y), [10, 15]);
  assert.equal(await creditsOf(s.buyerId), 75);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_cart_items WHERE user_id=$1", [s.buyerId]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_listings WHERE status='active'"), 2);
});

test("checkout: empty cart is 400; saved-for-later items are not bought and stay saved", async () => {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer", 100);
  const empty = await call(app.base, { userId: buyerId }, "POST", "/marketplace/cart/checkout", {});
  assert.deepEqual([empty.status, empty.json.error], [400, "Cart is empty"]);
  const l = await seedP2pListing(sellerId, 10);
  await seedCartItem(buyerId, l, 10, true);
  const still = await call(app.base, { userId: buyerId }, "POST", "/marketplace/cart/checkout", {});
  assert.deepEqual([still.status, still.json.error], [400, "Cart is empty"]);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_cart_items WHERE saved=TRUE"), 1);
});

test("checkout: insufficient balance rolls back everything (no orders, cart intact, credits unchanged)", async () => {
  const s = await setup(10);
  const r = await call(app.base, s.buyer, "POST", "/marketplace/cart/checkout", {});
  assert.deepEqual([r.status, r.json.error], [400, "Insufficient AZN balance. Need 25 AZN, have 10.00 AZN"]);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_orders"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_cart_items WHERE user_id=$1", [s.buyerId]), 2);
  assert.equal(await creditsOf(s.buyerId), 10);
});

test("checkout: a sold listing or your own listing in the cart blocks the whole checkout with 409 and the reasons", async () => {
  const s = await setup();
  await pool.query("UPDATE marketplace_listings SET status='sold' WHERE id=$1", [s.a]);
  const sold = await call(app.base, s.buyer, "POST", "/marketplace/cart/checkout", {});
  assert.equal(sold.status, 409); assert.equal(sold.json.error, "Some cart items are no longer purchasable");
  assert.deepEqual(sold.json.issues.map((i: any) => [i.listing_id, i.reason]), [[s.a, "listing_sold"]]);
  await pool.query("UPDATE marketplace_listings SET status='active' WHERE id=$1", [s.a]);
  await pool.query("UPDATE marketplace_listings SET seller_id=$1 WHERE id=$2", [s.buyerId, s.b]);
  const own = await call(app.base, s.buyer, "POST", "/marketplace/cart/checkout", {});
  assert.equal(own.status, 409);
  assert.deepEqual(own.json.issues.map((i: any) => [i.listing_id, i.reason]), [[s.b, "own_listing"]]);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_orders"), 0);
  assert.equal(await creditsOf(s.buyerId), 100);
});

test("GOOD (locked credits row): parallel checkouts by one buyer who can afford exactly one are charged once", async (t) => {
  const s = await setup(25);
  const replies = await Promise.all(Array.from({ length: 4 }, () => call(app.base, s.buyer, "POST", "/marketplace/cart/checkout", {})));
  const ok = replies.filter((r) => r.status === 201).length;
  t.diagnostic(`cart parallel checkout: ${ok} of 4 succeeded; others answered ${JSON.stringify(replies.filter((r) => r.status !== 201).map((r) => r.json.error))}`);
  assert.equal(ok, 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM marketplace_orders"), 2);
  assert.equal(await creditsOf(s.buyerId), 0);
});
