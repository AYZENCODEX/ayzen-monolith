import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, nextRunAfter } from "../src/cron.mjs";

test("parseCron rejects the wrong number of fields", () => {
  assert.throws(() => parseCron("* * * *"), /5 fields/);
  assert.throws(() => parseCron("not a cron"), /5 fields/);
});

test("parseCron rejects out-of-range and malformed values", () => {
  assert.throws(() => parseCron("60 * * * *"));
  assert.throws(() => parseCron("0 24 * * *"));
  assert.throws(() => parseCron("0 0 32 * *"));
  assert.throws(() => parseCron("0 0 1 13 *"));
  assert.throws(() => parseCron("0 0 1 1 7-3"));
  assert.throws(() => parseCron("*/0 * * * *"));
});

test("parseCron accepts month and day-of-week names case-insensitively", () => {
  assert.doesNotThrow(() => parseCron("0 0 1 JAN,jul mon"));
});

test("nextRunAfter: wildcard-every-minute always lands one minute after `from`", () => {
  const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(nextRunAfter("* * * * *", from).toISOString(), "2026-01-01T00:01:00.000Z");
});

test("nextRunAfter: a list of hours picks the next one in the list, rolling to the next day", () => {
  const from = new Date(Date.UTC(2026, 0, 1, 23, 0, 0));
  assert.equal(nextRunAfter("0 6,12,18 * * *", from).toISOString(), "2026-01-02T06:00:00.000Z");
});

test("nextRunAfter: a stepped range fires only inside its bounds", () => {
  const from = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
  // 9-17/4 -> 9, 13, 17
  assert.equal(nextRunAfter("0 9-17/4 * * *", from).toISOString(), "2026-01-01T13:00:00.000Z");
});

test("nextRunAfter: restricted day-of-month OR day-of-week matches either, not their intersection", () => {
  // "0 0 1 * MON": the 1st of the month, or any Monday. 2026-01-01 is a
  // Thursday; the next Monday on/after it is 2026-01-05.
  const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(nextRunAfter("0 0 1 * MON", from).toISOString(), "2026-01-05T00:00:00.000Z");
});

test("nextRunAfter: day-of-week 7 is treated the same as 0 (Sunday)", () => {
  // 2026-01-04 is a Sunday.
  const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  assert.equal(nextRunAfter("0 0 * * 7", from).toISOString(), "2026-01-04T00:00:00.000Z");
});

test("nextRunAfter: February 29 only fires on a leap year", () => {
  const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)); // 2026 is not a leap year
  const next = nextRunAfter("0 0 29 2 *", from);
  assert.equal(next.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("nextRunAfter propagates an invalid cron expression as a plain Error", () => {
  assert.throws(() => nextRunAfter("garbage", new Date()));
});
