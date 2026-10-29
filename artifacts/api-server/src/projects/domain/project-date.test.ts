import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectDateUpdates,
  DEFAULT_EVENT_TYPE,
  formatProjectDate,
  normalizeNewProjectDate,
  validateNewProjectDate,
} from "./project-date";

// PRJ-02: pins the behavior moved out of routes/project-dates.ts.

test("validateNewProjectDate checks label before eventDate", () => {
  assert.equal(validateNewProjectDate({}), "label is required");
  assert.equal(validateNewProjectDate({ label: "   " }), "label is required");
  assert.equal(validateNewProjectDate({ label: "TGE" }), "A valid eventDate is required");
  assert.equal(validateNewProjectDate({ label: "TGE", eventDate: "not-a-date" }), "A valid eventDate is required");
  assert.equal(validateNewProjectDate({ label: "TGE", eventDate: "2026-11-01T00:00:00Z" }), null);
});

test("normalizeNewProjectDate trims, defaults eventType and nulls empty notes", () => {
  const n = normalizeNewProjectDate({ label: "  TGE ", eventDate: "2026-11-01T00:00:00Z", notes: "" });
  assert.equal(n.label, "TGE");
  assert.equal(n.eventType, DEFAULT_EVENT_TYPE);
  assert.equal(DEFAULT_EVENT_TYPE, "snapshot");
  assert.equal(n.notes, null);
  assert.equal(n.eventDate.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(normalizeNewProjectDate({ label: "x", eventDate: "2026-11-01", eventType: "tge", notes: "n" }).eventType, "tge");
});

test("buildProjectDateUpdates only sets provided fields and resets remindedAt on a date change", () => {
  assert.deepEqual(buildProjectDateUpdates({}), { updates: {} });
  assert.deepEqual(buildProjectDateUpdates({ label: " A ", notes: "" }), { updates: { label: "A", notes: "" } });
  const withDate = buildProjectDateUpdates({ eventDate: "2026-12-01T00:00:00Z" });
  assert.ok("updates" in withDate);
  assert.equal(withDate.updates.remindedAt, null);
  assert.equal(withDate.updates.eventDate?.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.deepEqual(buildProjectDateUpdates({ eventDate: "nope" }), { error: "Invalid eventDate" });
  assert.ok(!("remindedAt" in (buildProjectDateUpdates({ label: "A" }) as any).updates));
});

test("formatProjectDate returns the unchanged public shape", () => {
  const eventDate = new Date("2026-11-01T00:00:00Z");
  const createdAt = new Date("2026-10-01T00:00:00Z");
  const base = { id: 1, projectId: 2, label: "L", eventType: "tge", eventDate, notes: null, remindedAt: null, createdAt };
  assert.deepEqual(formatProjectDate(base), {
    id: 1, projectId: 2, projectName: null, thumbnailUrl: null, label: "L", eventType: "tge",
    eventDate: eventDate.toISOString(), notes: null, remindedAt: null, createdAt: createdAt.toISOString(),
  });
  const joined = formatProjectDate({ ...base, projectName: "P", thumbnailUrl: "u", remindedAt: createdAt });
  assert.equal(joined.projectName, "P");
  assert.equal(joined.thumbnailUrl, "u");
  assert.equal(joined.remindedAt, createdAt.toISOString());
});
