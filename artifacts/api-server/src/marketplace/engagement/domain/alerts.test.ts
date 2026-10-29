import test from "node:test";
import assert from "node:assert/strict";
import { buildAlertUpdate, createAlertParams, savedSearchParams, validateCreateAlert, validateSavedSearch } from "./alerts";

// ---- reference: the logic exactly as routes/marketplace-alerts.ts had it before MKT-05c ----
function refCreate(userId: number, body: any) {
  const { keyword, listing_type, max_price_azn, platform } = body;
  if (!keyword && !listing_type) return { error: "At least a keyword or listing_type is required" };
  return { params: [userId, keyword || null, listing_type || null, max_price_azn ? Number(max_price_azn) : null, platform || null] };
}
function refUpdate(body: any, id: number, userId: number) {
  const { keyword, max_price_azn, platform, is_active } = body;
  const sets: string[] = []; const params: any[] = [];
  const push = (col: string, val: any) => { params.push(val); sets.push(`${col}=$${params.length}`); };
  if (keyword !== undefined) push("keyword", keyword);
  if (max_price_azn !== undefined) push("max_price_azn", max_price_azn === null ? null : Number(max_price_azn));
  if (platform !== undefined) push("platform", platform);
  if (is_active !== undefined) push("is_active", !!is_active);
  if (sets.length === 0) return null;
  params.push(id, userId);
  return { sql: `UPDATE marketplace_alerts SET ${sets.join(", ")} WHERE id=$${params.length - 1} AND user_id=$${params.length} RETURNING *`, params };
}

const values: any[] = [undefined, null, "", "abc", 0, 1, 12.5, "7", "0", true, false, {}, []];

test("create: validation and parameters equal the original for every combination of odd inputs", () => {
  let n = 0;
  for (const keyword of values) for (const listing_type of values) for (const max_price_azn of values) for (const platform of values) {
    const body = { keyword, listing_type, max_price_azn, platform };
    const ref = refCreate(7, body);
    const err = validateCreateAlert(body);
    if ("error" in ref) assert.equal(err, ref.error); else { assert.equal(err, null); assert.deepEqual(createAlertParams(7, body), ref.params); }
    n++;
  }
  assert.equal(n, values.length ** 4);
});
test("update: SQL text and parameters equal the original for every combination of present/absent/odd fields", () => {
  let n = 0;
  for (const keyword of values) for (const max_price_azn of values) for (const platform of values) for (const is_active of values) {
    const body = { keyword, max_price_azn, platform, is_active };
    assert.deepEqual(buildAlertUpdate(body, 5, 9), refUpdate(body, 5, 9));
    n++;
  }
  assert.equal(n, values.length ** 4);
});
test("update: an empty body builds nothing, and field order is keyword, max_price_azn, platform, is_active", () => {
  assert.equal(buildAlertUpdate({}, 1, 2), null);
  assert.equal(buildAlertUpdate({ is_active: 0, keyword: "k" }, 1, 2)!.sql, "UPDATE marketplace_alerts SET keyword=$1, is_active=$2 WHERE id=$3 AND user_id=$4 RETURNING *");
});
test("saved search: validation and parameters", () => {
  for (const name of values) for (const filters of values) {
    assert.equal(validateSavedSearch({ name, filters }), !name || !filters ? "name and filters are required" : null);
  }
  assert.deepEqual(savedSearchParams(3, { name: "n", filters: { a: 1 } }), [3, "n", '{"a":1}']);
});
