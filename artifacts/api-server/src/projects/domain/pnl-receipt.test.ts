import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectReceiptPdfSpec, formatPublicReceipt } from "./pnl-receipt";
import { computeProjectPnl } from "./roi";

// PRJ-04: pins the public receipt card and PDF layout moved out of routes/projects.ts.
const now = new Date("2026-05-05T00:00:00Z");
const base = (tier: string | null, pnl = computeProjectPnl([{ kind: "investment", total: 100 }, { kind: "expense", total: 40 }, { kind: "income", total: 70 }])) =>
  formatPublicReceipt({ receipt: { id: 9 }, project: { id: 3, name: "Alpha", tier, thumbnailUrl: null }, issuedBy: "alice", summary: pnl }, now);

test("formatPublicReceipt maps project, summary and issuer", () => {
  assert.deepEqual(base("2"), {
    id: 9, projectId: 3, projectName: "Alpha", projectTier: "2", thumbnailUrl: null,
    invested: 100, spent: 40, earned: 70, netPnl: 30, netPosition: 130, roiPct: 75, issuedBy: "alice", generatedAt: now.toISOString(),
  });
});

test("PDF spec with a ROI figure", () => {
  const spec = buildProjectReceiptPdfSpec(base("2"));
  assert.equal(spec.heroLabel, "Return on Investment");
  assert.equal(spec.heroValue, "+75.0%");
  assert.equal(spec.heroPositive, true);
  assert.equal(spec.subtitle, "Tier 2");
  assert.deepEqual(spec.stats.map((s) => s.value), ["$100.00", "$70.00", "$40.00", "+$30.00", "$130.00"]);
  assert.equal(spec.filenamePrefix, "project-pnl");
  assert.equal(spec.receiptId, 9);
});

test("PDF spec without ROI falls back to net P&L; amounts always print with a $ prefix", () => {
  const spec = buildProjectReceiptPdfSpec(base(null, computeProjectPnl([{ kind: "investment", total: 50 }])));
  assert.equal(spec.heroLabel, "Net P&L");
  assert.equal(spec.heroValue, "+$0.00");
  assert.equal(spec.subtitle, undefined);
  const loss = buildProjectReceiptPdfSpec(base("1", computeProjectPnl([{ kind: "expense", total: 10 }])));
  assert.equal(loss.heroValue, "-100.0%");
  assert.equal(loss.heroPositive, false);
  assert.equal(loss.stats[3].value, "$-10.00");
  assert.equal(loss.stats[3].color, "#e4453a");
});
