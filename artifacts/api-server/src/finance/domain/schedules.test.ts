import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAmortizationRows, buildDepreciationRows } from "./schedules";

// The pure schedule math must reproduce, bit for bit, what the ORIGINAL DB-coupled generators wrote.
// schedules.golden.json was captured from the pre-WP-4 lib/finance-accounting.ts with the DB stubbed
// (scripts/antas/finance/schedule-golden-capture.mjs). Each case stores a digest of the canonicalised rows.

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(here, "schedules.golden.json"), "utf8"));

// Must stay identical to the canonicalisation in the capture script.
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date))
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x);
const digest = (rows: unknown) => crypto.createHash("sha256").update(canon(rows)).digest("hex");

test("golden fixture is the expected size and names the baseline source it came from", () => {
  assert.equal(golden.schemaVersion, 1);
  assert.equal(golden.amortization.length, 242);
  assert.equal(golden.depreciation.length, 201);
  assert.match(golden.capturedFrom.sha256, /^[0-9a-f]{64}$/);
});

test("buildAmortizationRows reproduces every baseline amortization schedule", () => {
  const failures: unknown[] = [];
  for (const c of golden.amortization) {
    const i = c.input;
    const rows = buildAmortizationRows({ userId: i.userId, ledgerEntryId: i.entryId, principal: i.principal, annualRate: i.annualRate, termMonths: i.termMonths, startDate: new Date(i.startDate) });
    if (rows.length !== c.rowCount || digest(rows) !== c.sha256) failures.push(i);
  }
  assert.deepEqual(failures, []);
});

test("buildDepreciationRows reproduces every baseline depreciation schedule", () => {
  const failures: unknown[] = [];
  for (const c of golden.depreciation) {
    const i = c.input;
    const rows = buildDepreciationRows({ userId: i.userId, assetId: i.assetId, method: i.method, cost: i.cost, salvage: i.salvage, months: i.months, startDate: new Date(i.startDate) });
    if (rows.length !== c.rowCount || digest(rows) !== c.sha256) failures.push(i);
  }
  assert.deepEqual(failures, []);
});

test("sample schedules in the fixture also match row for row (readable cross-check)", () => {
  const sample = golden.amortization.find((c: any) => c.sample);
  const i = sample.input;
  const rows = buildAmortizationRows({ userId: i.userId, ledgerEntryId: i.entryId, principal: i.principal, annualRate: i.annualRate, termMonths: i.termMonths, startDate: new Date(i.startDate) });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), sample.sample);
});

test("schedule invariants hold on every baseline input: principal fully repaid, book value lands on salvage", () => {
  for (const c of golden.amortization) {
    const i = c.input;
    const rows = buildAmortizationRows({ userId: 1, ledgerEntryId: 1, principal: i.principal, annualRate: i.annualRate, termMonths: i.termMonths, startDate: new Date(i.startDate) });
    const repaid = rows.reduce((s, r) => s + r.principalDue, 0);
    assert.ok(Math.abs(repaid - i.principal) < 1e-6 * Math.max(1, i.principal), `principal repaid for ${JSON.stringify(i)}`);
    assert.equal(rows[rows.length - 1].remainingBalance, 0);
  }
  for (const c of golden.depreciation) {
    const i = c.input;
    const rows = buildDepreciationRows({ userId: 1, assetId: 1, method: i.method, cost: i.cost, salvage: i.salvage, months: i.months, startDate: new Date(i.startDate) });
    const last = rows[rows.length - 1];
    assert.ok(last.bookValue >= i.salvage - 1e-9, `book value never below salvage for ${JSON.stringify(i)}`);
    if (i.cost > i.salvage) assert.ok(Math.abs(last.bookValue - i.salvage) < 1e-6 * Math.max(1, i.cost), `lands on salvage for ${JSON.stringify(i)}`);
  }
});
