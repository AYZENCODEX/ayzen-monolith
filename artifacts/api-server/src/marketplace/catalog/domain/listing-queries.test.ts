import test from "node:test";
import assert from "node:assert/strict";
import { buildListingsCount, buildListingsList, buildSearch } from "./listing-queries";

// ---- reference: the handler logic exactly as routes/marketplace.ts had it before MKT-05g ----
function refList(query: any) {
  const { type, limit = 50, offset = 0 } = query;
    let q = `
      SELECT ml.*, u.username as seller_username
      FROM marketplace_listings ml
      LEFT JOIN users u ON u.id = ml.seller_id
      WHERE ml.status = 'active'
        AND (ml.listing_expires_at IS NULL OR ml.listing_expires_at > NOW())
    `;
    const params: any[] = [];
    if (type) { q += ` AND ml.listing_type = $${params.length + 1}`; params.push(type); }
    q += ` ORDER BY ml.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
  return { sql: q, params };
}
function refCount(type: any) {
  return { sql: `SELECT COUNT(*) FROM marketplace_listings WHERE status = 'active'${type ? " AND listing_type = $1" : ""}`, params: type ? [type] : [] };
}
function refSearch(input: any) {
  const { q, type, min_price, max_price, condition, limit = 50, offset = 0 } = input;
    let query = `
      SELECT ml.*, u.username as seller_username
      FROM marketplace_listings ml
      LEFT JOIN users u ON u.id = ml.seller_id
      WHERE ml.status = 'active'
        AND (ml.listing_expires_at IS NULL OR ml.listing_expires_at > NOW())
    `;
    const params: any[] = [];
    if (q) { params.push(`%${q}%`); query += ` AND (ml.title ILIKE $${params.length} OR ml.description ILIKE $${params.length})`; }
    if (type) { params.push(type); query += ` AND ml.listing_type = $${params.length}`; }
    if (condition) { params.push(condition); query += ` AND ml.condition = $${params.length}`; }
    if (min_price) { params.push(Number(min_price)); query += ` AND ml.price_azn >= $${params.length}`; }
    if (max_price) { params.push(Number(max_price)); query += ` AND ml.price_azn <= $${params.length}`; }
    query += ` ORDER BY (ml.is_featured AND (ml.featured_until IS NULL OR ml.featured_until > NOW())) DESC, ml.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
  return { sql: query, params };
}

const nan = (xs: any[]) => xs.map((x) => (typeof x === "number" && Number.isNaN(x) ? "NaN" : x));
const same = (a: { sql: string; params: any[] }, b: { sql: string; params: any[] }, label: string) => { assert.equal(a.sql, b.sql, label); assert.deepEqual(nan(a.params), nan(b.params), label); };
const odd: any[] = [undefined, null, "", "x", "wallet", 0, "0", 5, "25", "abc", true, false];

test("list and count: SQL and parameters equal the original for every type x limit x offset", () => {
  let n = 0;
  for (const type of odd) for (const limit of odd) for (const offset of odd) {
    same(buildListingsList({ type, limit, offset }), refList({ type, limit, offset }), `list ${String(type)} ${String(limit)} ${String(offset)}`);
    same(buildListingsCount(type), refCount(type), `count ${String(type)}`);
    n++;
  }
  assert.equal(n, odd.length ** 3);
});
test("search: SQL and parameters equal the original for every combination of q, type, condition, min and max price (limit and offset fixed per pass)", () => {
  const vals: any[] = [undefined, "", "usb", "0", 12.5];
  let n = 0;
  for (const q of vals) for (const type of vals) for (const condition of vals) for (const min_price of vals) for (const max_price of vals) for (const [limit, offset] of [[undefined, undefined], ["10", "20"], ["abc", null]]) {
    const input = { q, type, condition, min_price, max_price, limit, offset };
    same(buildSearch(input), refSearch(input), JSON.stringify(input));
    n++;
  }
  assert.equal(n, vals.length ** 5 * 3);
});
test("search parameter order: q, type, condition, min, max, then limit and offset; q is wrapped in %", () => {
  const r = buildSearch({ q: "usb", type: "wallet", condition: "new", min_price: "1", max_price: "9", limit: 5, offset: 10 });
  assert.deepEqual(r.params, ["%usb%", "wallet", "new", 1, 9, 5, 10]);
  assert.match(r.sql, /\$6 OFFSET \$7$/);
});
