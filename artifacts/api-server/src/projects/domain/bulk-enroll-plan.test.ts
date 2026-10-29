import assert from "node:assert/strict";
import test from "node:test";
import { payableCount, planBulkEnroll } from "./bulk-enroll-plan";

test("new entities are created, repeat bulk enroll creates nothing (PRJ-ISSUE-4)", () => {
  const first = planBulkEnroll([1, 2, 3], []);
  assert.deepEqual(first.create, [1, 2, 3]);
  assert.equal(payableCount(first), 3);
  const again = planBulkEnroll([1, 2, 3], [1, 2, 3].map((v) => ({ id: v, vaultEntryId: v, status: "active" })));
  assert.deepEqual(again.create, []);
  assert.deepEqual(again.skipped.map((s) => s.reason), ["already_active", "already_active", "already_active"]);
  assert.equal(payableCount(again), 0);
});

test("cancelled and disqualified rows are reactivated, banned rows are skipped", () => {
  const plan = planBulkEnroll([1, 2, 3, 4], [
    { id: 10, vaultEntryId: 1, status: "cancelled" },
    { id: 11, vaultEntryId: 2, status: "disqualified" },
    { id: 12, vaultEntryId: 3, status: "banned" },
  ]);
  assert.deepEqual(plan.reactivate, [{ entityId: 1, enrollmentId: 10, from: "cancelled" }, { entityId: 2, enrollmentId: 11, from: "disqualified" }]);
  assert.deepEqual(plan.skipped, [{ entityId: 3, reason: "banned" }]);
  assert.deepEqual(plan.create, [4]);
  assert.equal(payableCount(plan), 3);
});

test("legacy duplicate rows: active or banned wins over a cancelled copy", () => {
  const plan = planBulkEnroll([1, 2], [
    { id: 1, vaultEntryId: 1, status: "cancelled" }, { id: 2, vaultEntryId: 1, status: "active" },
    { id: 3, vaultEntryId: 2, status: "cancelled" }, { id: 4, vaultEntryId: 2, status: "banned" },
  ]);
  assert.deepEqual(plan.skipped, [{ entityId: 1, reason: "already_active" }, { entityId: 2, reason: "banned" }]);
  assert.equal(payableCount(plan), 0);
});

test("duplicate requested ids are planned once", () => {
  assert.deepEqual(planBulkEnroll([5, 5, 5], []).create, [5]);
});
