import test from "node:test";
import assert from "node:assert/strict";
import { createReportsService } from "./reports";
import { createReportsRepo, REPORTS_SQL, type Queryable } from "../infrastructure/reports-repo";
import type { TxClient } from "../../kernel/infrastructure/tx";

function build(opts: { pool?: (t: string) => any[]; client?: (t: string) => any[]; failOn?: string[]; connectFails?: boolean } = {}) {
  const poolCalls: Array<[string, any[] | undefined]> = [];
  const clientCalls: Array<[string, any[] | undefined]> = [];
  let released = 0;
  const db: Queryable = { async query(t, p) { poolCalls.push([t, p]); return { rows: (opts.pool ?? (() => []))(t) }; } };
  const client: TxClient = {
    async query(t, p) { clientCalls.push([t, p]); if (opts.failOn?.includes(t)) throw new Error(`boom on ${t}`); return { rows: (opts.client ?? (() => []))(t), rowCount: 0 }; },
    release() { released++; },
  };
  const svc = createReportsService(createReportsRepo(db), async () => { if (opts.connectFails) throw new Error("no connection"); return client; });
  return { svc, poolCalls, clientCalls, released: () => released };
}

test("reportListing: reason first (no query), then the listing must exist (404), then the insert", async () => {
  const a = build();
  assert.deepEqual(await a.svc.reportListing(1, 2, {}), { ok: false, status: 400, error: "reason is required" });
  assert.equal(a.poolCalls.length, 0);
  assert.deepEqual(await a.svc.reportListing(1, 2, { reason: "spam" }), { ok: false, status: 404, error: "Listing not found" });
  assert.deepEqual(a.poolCalls, [[REPORTS_SQL.listingExists, [2]]]);
  const b = build({ pool: (t) => (t === REPORTS_SQL.listingExists ? [{ id: 2 }] : [{ id: 9 }]) });
  assert.deepEqual(await b.svc.reportListing(1, 2, { reason: "spam", details: "d" }), { ok: true, row: { id: 9 } });
  assert.deepEqual(b.poolCalls[1], [REPORTS_SQL.insertListingReport, [2, 1, "spam", "d"]]);
});
test("reportSeller: reason, then self-report, then the insert with reported_user_id first", async () => {
  const a = build();
  assert.equal((await a.svc.reportSeller(5, 5, { reason: "x" }) as any).error, "Cannot report yourself");
  assert.equal(a.poolCalls.length, 0);
  const b = build({ pool: () => [{ id: 3 }] });
  assert.deepEqual(await b.svc.reportSeller(5, 6, { reason: "x" }), { ok: true, row: { id: 3 } });
  assert.deepEqual(b.poolCalls, [[REPORTS_SQL.insertSellerReport, [6, 5, "x", null]]]);
});
test("resolve: an invalid action is a 400 result and no connection is opened", async () => {
  let connected = 0;
  const svc = createReportsService(createReportsRepo({ async query() { return { rows: [] }; } }), async () => { connected++; throw new Error("x"); });
  assert.deepEqual(await svc.resolve(1, { action: "nope" }), { ok: false, status: 400, error: "action must be 'dismiss' or 'remove_listing'" });
  assert.equal(connected, 0);
});
test("resolve dismiss: BEGIN, lock, mark resolved with the action as note, COMMIT, release; no listing update", async () => {
  const t = build({ client: (q) => (q === REPORTS_SQL.lockPending ? [{ id: 7, listing_id: 11 }] : []) });
  assert.deepEqual(await t.svc.resolve(7, { action: "dismiss" }), { ok: true, action: "dismiss" });
  assert.deepEqual(t.clientCalls, [["BEGIN", undefined], [REPORTS_SQL.lockPending, [7]], [REPORTS_SQL.markResolved, ["dismiss", 7]], ["COMMIT", undefined]]);
  assert.equal(t.released(), 1);
});
test("resolve remove_listing: the listing is removed between the lock and the mark, the admin note is kept", async () => {
  const t = build({ client: (q) => (q === REPORTS_SQL.lockPending ? [{ id: 7, listing_id: 11 }] : []) });
  await t.svc.resolve(7, { action: "remove_listing", admin_note: "scam" });
  assert.deepEqual(t.clientCalls.map((c) => c[0]), ["BEGIN", REPORTS_SQL.lockPending, REPORTS_SQL.removeListing, REPORTS_SQL.markResolved, "COMMIT"]);
  assert.deepEqual(t.clientCalls[2][1], [11]); assert.deepEqual(t.clientCalls[3][1], ["scam", 7]);
});
test("resolve remove_listing on a report without a listing only marks the report", async () => {
  const t = build({ client: (q) => (q === REPORTS_SQL.lockPending ? [{ id: 7, listing_id: null }] : []) });
  await t.svc.resolve(7, { action: "remove_listing" });
  assert.deepEqual(t.clientCalls.map((c) => c[0]), ["BEGIN", REPORTS_SQL.lockPending, REPORTS_SQL.markResolved, "COMMIT"]);
});
test("resolve: no pending report rolls back and is a 404 result; the client is released", async () => {
  const t = build();
  assert.deepEqual(await t.svc.resolve(7, { action: "dismiss" }), { ok: false, status: 404, error: "Pending report not found" });
  assert.deepEqual(t.clientCalls.map((c) => c[0]), ["BEGIN", REPORTS_SQL.lockPending, "ROLLBACK"]);
  assert.equal(t.released(), 1);
});
test("resolve: a failure rolls back and comes back as a 500 result with the message; release once", async () => {
  const t = build({ client: (q) => (q === REPORTS_SQL.lockPending ? [{ id: 7, listing_id: 11 }] : []), failOn: [REPORTS_SQL.markResolved] });
  const r = await t.svc.resolve(7, { action: "dismiss" });
  assert.deepEqual(r, { ok: false, status: 500, error: `boom on ${REPORTS_SQL.markResolved}` });
  assert.deepEqual(t.clientCalls.map((c) => c[0]).slice(-1), ["ROLLBACK"]);
  assert.equal(t.released(), 1);
});
test("resolve: when the work fails AND ROLLBACK fails, the ROLLBACK error escapes (as it did from the route) and the client is still released", async () => {
  const t = build({ client: (q) => (q === REPORTS_SQL.lockPending ? [{ id: 7, listing_id: null }] : []), failOn: [REPORTS_SQL.markResolved, "ROLLBACK"] });
  await assert.rejects(t.svc.resolve(7, { action: "dismiss" }), /boom on ROLLBACK/);
  assert.equal(t.released(), 1);
});
test("resolve: connect failure escapes, nothing was run", async () => {
  const t = build({ connectFails: true });
  await assert.rejects(t.svc.resolve(7, { action: "dismiss" }), /no connection/);
  assert.equal(t.clientCalls.length, 0);
});
