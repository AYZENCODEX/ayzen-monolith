import test from "node:test";
import assert from "node:assert/strict";
import { isValidAction, listingReportParams, resolveNote, sellerReportParams, shouldRemoveListing, validateReason, validateSellerReport } from "./reports";

const values: any[] = [undefined, null, "", "abc", 0, 1, "dismiss", "remove_listing", "remove", true, false, {}, []];

test("action validation equals the original array check for every odd value", () => {
  for (const v of values) assert.equal(isValidAction(v), ["dismiss", "remove_listing"].includes(v), String(v));
});
test("reason and seller-report validation keep the original order of checks", () => {
  for (const reason of values) for (const sid of [1, 2]) {
    const ref = !reason ? "reason is required" : sid === 1 ? "Cannot report yourself" : null;
    assert.equal(validateSellerReport(1, sid, reason), ref);
  }
  for (const reason of values) assert.equal(validateReason(reason), !reason ? "reason is required" : null);
});
test("parameters: details falls back to null; the note falls back to the action; remove only when the report has a listing", () => {
  for (const d of values) { assert.deepEqual(listingReportParams(3, 4, "r", d), [3, 4, "r", d || null]); assert.deepEqual(sellerReportParams(3, 4, "r", d), [3, 4, "r", d || null]); }
  for (const n of values) assert.equal(resolveNote(n, "dismiss"), n || "dismiss");
  for (const l of values) {
    assert.equal(shouldRemoveListing("remove_listing", { listing_id: l }), !!l);
    assert.equal(shouldRemoveListing("dismiss", { listing_id: l }), false);
  }
});
