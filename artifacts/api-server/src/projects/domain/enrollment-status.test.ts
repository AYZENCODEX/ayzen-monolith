import assert from "node:assert/strict";
import test from "node:test";
import { decideEnrollment, ENROLLMENT_MODERATION_ACTIONS, formatEnrollment, MODERATION_STATUS_ERROR, moderationLogAction, serializeAccountData } from "./enrollment-status";

// PRJ-05: pins the enrollment rules moved out of routes/projects.ts.

test("moderation statuses map to activity-log actions; anything else is rejected", () => {
  assert.deepEqual(ENROLLMENT_MODERATION_ACTIONS, { disqualified: "disqualified", banned: "banned", cancelled: "cancelled", active: "enrolled" });
  assert.equal(moderationLogAction("active"), "enrolled");
  assert.equal(moderationLogAction("banned"), "banned");
  for (const bad of ["nope", "", "completed", "Banned"]) assert.equal(moderationLogAction(bad), undefined, bad);
  assert.equal(MODERATION_STATUS_ERROR, "status must be one of: disqualified, banned, cancelled, active");
});

test("decideEnrollment: banned blocks, active conflicts, others reactivate, none creates", () => {
  assert.deepEqual(decideEnrollment(undefined), { kind: "create" });
  assert.deepEqual(decideEnrollment(null), { kind: "create" });
  assert.deepEqual(decideEnrollment({ status: "banned" }), { kind: "banned" });
  assert.deepEqual(decideEnrollment({ status: "active" }), { kind: "already_active" });
  assert.deepEqual(decideEnrollment({ status: "disqualified" }), { kind: "reactivate", from: "disqualified" });
  assert.deepEqual(decideEnrollment({ status: "cancelled" }), { kind: "reactivate", from: "cancelled" });
  assert.deepEqual(decideEnrollment({ status: "completed" }), { kind: "reactivate", from: "completed" });
});

test("serializeAccountData stores only non-null objects", () => {
  assert.equal(serializeAccountData({ a: 1 }, "old"), '{"a":1}');
  assert.equal(serializeAccountData([1], null), "[1]");
  assert.equal(serializeAccountData("str", "old"), "old");
  assert.equal(serializeAccountData(undefined, null), null);
  assert.equal(serializeAccountData(null, "keep"), "keep");
});

test("formatEnrollment ISO-formats enrolledAt and parses accountData", () => {
  const d = new Date("2026-01-02T00:00:00Z");
  assert.deepEqual(formatEnrollment({ id: 1, enrolledAt: d, accountData: '{"a":1}' }), { id: 1, enrolledAt: d.toISOString(), accountData: { a: 1 } });
  assert.equal(formatEnrollment({ enrolledAt: d, accountData: null }).accountData, null);
  assert.equal(formatEnrollment({ enrolledAt: d, accountData: "" }).accountData, null);
});

test("FIXED in PRJ-06 (PRJ-ISSUE-3): inherited keys and non-strings are not valid statuses", () => {
  for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) assert.equal(moderationLogAction(key), undefined, key);
  for (const bad of [undefined, null, 5, ["banned"], { a: 1 }]) assert.equal(moderationLogAction(bad), undefined, String(bad));
  for (const ok of ["disqualified", "banned", "cancelled", "active"]) assert.equal(typeof moderationLogAction(ok), "string", ok);
});
