// MKT-01b-1: P2P order lifecycle, characterized against the UNMODIFIED routes/marketplace.ts on a throwaway schema.
// Expectations come from reading the handlers; a failure means either the code differs from this reading or the harness is
// wrong: report the output, do not "fix" the route to make a test pass.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import marketplaceRouter from "../../routes/marketplace";
import { call, createUser, creditsOf, notifications, pool, resetTables, seedP2pListing, startApp } from "./harness";

let app: { base: string; close: () => Promise<void> };
before(async () => { app = await startApp([marketplaceRouter]); });
after(async () => { await app.close(); await pool.end(); });
beforeEach(resetTables);

async function setup(buyerAzn = 100, price = 40) {
  const sellerId = await createUser("seller");
  const buyerId = await createUser("buyer", buyerAzn);
  const adminId = await createUser("admin");
  const listingId = await seedP2pListing(sellerId, price);
  return { sellerId, buyerId, adminId, listingId, buyer: { userId: buyerId }, admin: { userId: adminId, role: "admin" as const } };
}
async function placeOrder(s: Awaited<ReturnType<typeof setup>>) {
  const r = await call(app.base, s.buyer, "POST", `/marketplace/listings/${s.listingId}/buy`, { message: "hello" });
  assert.equal(r.status, 201);
  return Number(r.json.order.id);
}

test("buy: creates a pending order at fee 5, escrows the price from credits, keeps the listing active", async () => {
  const s = await setup();
  const r = await call(app.base, s.buyer, "POST", `/marketplace/listings/${s.listingId}/buy`, { message: "hello" });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.json).sort(), ["message", "order"]);
  const o = r.json.order;
  assert.equal(o.status, "pending"); assert.equal(Number(o.price_azn), 40); assert.equal(Number(o.fee_pct), 5);
  assert.equal(o.buyer_id, s.buyerId); assert.equal(o.seller_id, s.sellerId); assert.equal(o.message, "hello");
  assert.equal(await creditsOf(s.buyerId), 60);
  const l = await pool.query("SELECT status FROM marketplace_listings WHERE id=$1", [s.listingId]);
  assert.equal(l.rows[0].status, "active");
});

test("buy: your own listing, an insufficient balance and an unknown listing are rejected without any write", async () => {
  const s = await setup(10, 40);
  const own = await call(app.base, { userId: s.sellerId }, "POST", `/marketplace/listings/${s.listingId}/buy`, {});
  assert.deepEqual([own.status, own.json.error], [400, "Cannot buy your own listing"]);
  const poor = await call(app.base, s.buyer, "POST", `/marketplace/listings/${s.listingId}/buy`, {});
  assert.equal(poor.status, 400);
  assert.equal(poor.json.error, "Insufficient AZN balance. Need 40 AZN, have 10.00 AZN");
  const none = await call(app.base, s.buyer, "POST", "/marketplace/listings/999999/buy", {});
  assert.deepEqual([none.status, none.json.error], [404, "Listing not found or no longer active"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketplace_orders")).rows[0].n, 0);
  assert.equal(await creditsOf(s.buyerId), 10);
});

test("admin approve: seller gets price - 5%, listing is sold, fee is recorded, buyer is notified, total AZN is conserved", async () => {
  const s = await setup();
  const orderId = await placeOrder(s);
  const r = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "approve", admin_note: "ok" });
  assert.deepEqual([r.status, r.json], [200, { ok: true, action: "approve" }]);
  const o = (await pool.query("SELECT status, fee_azn, seller_receives, admin_note, resolved_at FROM marketplace_orders WHERE id=$1", [orderId])).rows[0];
  assert.equal(o.status, "approved"); assert.equal(Number(o.fee_azn), 2); assert.equal(Number(o.seller_receives), 38);
  assert.equal(o.admin_note, "ok"); assert.ok(o.resolved_at);
  assert.equal(await creditsOf(s.sellerId), 38);
  assert.equal(await creditsOf(s.buyerId), 60);
  const l = (await pool.query("SELECT status, buyer_id FROM marketplace_listings WHERE id=$1", [s.listingId])).rows[0];
  assert.deepEqual([l.status, l.buyer_id], ["sold", s.buyerId]);
  const fee = (await pool.query("SELECT user_id, type, azn_amount, status FROM credit_transactions")).rows;
  assert.equal(fee.length, 1);
  assert.deepEqual([fee[0].user_id, fee[0].type, Number(fee[0].azn_amount), fee[0].status], [s.sellerId, "marketplace_fee", 2, "completed"]);
  assert.deepEqual(notifications(), [["orderResolved", s.buyerId, "approve", "Your order has been approved!"]]);
  assert.equal((await creditsOf(s.buyerId))! + (await creditsOf(s.sellerId))! + Number(fee[0].azn_amount), 100);
});

test("admin reject: the escrow goes back to the buyer, the listing stays active, the note is stored", async () => {
  const s = await setup();
  const orderId = await placeOrder(s);
  const r = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "reject", admin_note: "no stock" });
  assert.deepEqual([r.status, r.json], [200, { ok: true, action: "reject" }]);
  assert.equal(await creditsOf(s.buyerId), 100);
  const o = (await pool.query("SELECT status, admin_note FROM marketplace_orders WHERE id=$1", [orderId])).rows[0];
  assert.deepEqual([o.status, o.admin_note], ["rejected", "no stock"]);
  assert.equal((await pool.query("SELECT status FROM marketplace_listings WHERE id=$1", [s.listingId])).rows[0].status, "active");
  assert.deepEqual(notifications(), [["orderResolved", s.buyerId, "reject", "Your order was rejected. Reason: no stock"]]);
});

test("admin order action: invalid action is 400, an already resolved order is 400, a non-admin is 403", async () => {
  const s = await setup();
  const orderId = await placeOrder(s);
  assert.equal((await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "maybe" })).status, 400);
  assert.equal((await call(app.base, s.buyer, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "approve" })).status, 403);
  await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "approve" });
  const again = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}`, { action: "approve" });
  assert.deepEqual([again.status, again.json.error], [400, "Order already approved"]);
  assert.equal(await creditsOf(s.sellerId), 38); // paid once
});

async function seedDisputed(s: Awaited<ReturnType<typeof setup>>, feePct = 5): Promise<number> {
  const r = await pool.query(
    "INSERT INTO marketplace_orders (listing_id, buyer_id, seller_id, price_azn, fee_pct, status) VALUES ($1,$2,$3,40,$4,'disputed') RETURNING id",
    [s.listingId, s.buyerId, s.sellerId, feePct],
  );
  return Number(r.rows[0].id);
}

test("resolve-dispute refund: buyer gets the price back, order is rejected with the default note", async () => {
  const s = await setup(60); // 40 already escrowed
  const id = await seedDisputed(s);
  const r = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${id}/resolve-dispute`, { action: "refund" });
  assert.deepEqual([r.status, r.json], [200, { ok: true, action: "refund" }]);
  assert.equal(await creditsOf(s.buyerId), 100);
  const o = (await pool.query("SELECT status, admin_note, resolved_at FROM marketplace_orders WHERE id=$1", [id])).rows[0];
  assert.deepEqual([o.status, o.admin_note], ["rejected", "Dispute resolved: refunded"]); assert.ok(o.resolved_at);
});

test("resolve-dispute complete: seller is paid price - the fee stored on the ORDER (not the constant), order is completed", async () => {
  const s = await setup(60);
  const id = await seedDisputed(s, 10); // order says 10%, constant is 5%
  const r = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${id}/resolve-dispute`, { action: "complete" });
  assert.equal(r.status, 200);
  assert.equal(await creditsOf(s.sellerId), 36);
  const o = (await pool.query("SELECT status, fee_azn, seller_receives, admin_note FROM marketplace_orders WHERE id=$1", [id])).rows[0];
  assert.deepEqual([o.status, Number(o.fee_azn), Number(o.seller_receives), o.admin_note], ["completed", 4, 36, "Dispute resolved: force-completed"]);
});

test("resolve-dispute: only disputed orders (404) and only refund/complete (400)", async () => {
  const s = await setup();
  const orderId = await placeOrder(s); // pending, not disputed
  const nd = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}/resolve-dispute`, { action: "refund" });
  assert.deepEqual([nd.status, nd.json.error], [404, "Disputed order not found"]);
  const bad = await call(app.base, s.admin, "PATCH", `/admin/marketplace/orders/${orderId}/resolve-dispute`, { action: "x" });
  assert.deepEqual([bad.status, bad.json.error], [400, "action must be 'refund' or 'complete'"]);
});

test("DEFECT PINNED (MKT-ISSUE-7): a failing credits debit AFTER the order insert leaves an order without escrow", async () => {
  const s = await setup();
  await pool.query("CREATE OR REPLACE FUNCTION mkt_test_fail_update() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql");
  await pool.query("CREATE TRIGGER mkt_test_fail BEFORE UPDATE ON credits FOR EACH ROW EXECUTE FUNCTION mkt_test_fail_update()");
  try {
    const r = await call(app.base, s.buyer, "POST", `/marketplace/listings/${s.listingId}/buy`, {});
    assert.equal(r.status, 500);
    assert.match(String(r.json.error), /forced failure/);
    const orders = (await pool.query("SELECT status FROM marketplace_orders")).rows;
    assert.deepEqual(orders.map((o) => o.status), ["pending"], "the order row exists although the debit failed");
    assert.equal(await creditsOf(s.buyerId), 100, "and nothing was escrowed");
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS mkt_test_fail ON credits");
  }
});
