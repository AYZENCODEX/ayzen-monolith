import assert from "node:assert/strict";
import test from "node:test";
import { computeProjectPnl, entityRoi, summarizeRoi } from "./roi";

// PRJ-04: pins the money rules moved out of routes/projects.ts. No rounding, no currency conversion.

test("entityRoi keeps a stored value (including 0) and falls back to profit minus cost", () => {
  assert.equal(entityRoi({ roi: 5, totalProfit: 1, totalCost: 1 }), 5);
  assert.equal(entityRoi({ roi: 0, totalProfit: 9, totalCost: 1 }), 0);
  assert.equal(entityRoi({ roi: null, totalProfit: 10, totalCost: 4 }), 6);
  assert.equal(entityRoi({ roi: null, totalProfit: 1, totalCost: 4 }), -3);
});

test("summarizeRoi totals profit and cost and ISO-formats dates", () => {
  const d = new Date("2026-01-01T00:00:00Z");
  const row = (id: number, p: number, c: number, roi: number | null) => ({ vaultEntryId: id, entitySerial: "S", entityName: null, totalProfit: p, totalCost: c, roi, recordedAt: d });
  const s = summarizeRoi(7, [row(1, 10, 4, null), row(2, 5, 5, 0)]);
  assert.equal(s.projectId, 7);
  assert.deepEqual(s.summary, { totalProfit: 15, totalCost: 9, totalRoi: 6 });
  assert.deepEqual(s.entries.map((e) => e.roi), [6, 0]);
  assert.equal(s.entries[0].recordedAt, d.toISOString());
  assert.deepEqual(summarizeRoi(7, []).summary, { totalProfit: 0, totalCost: 0, totalRoi: 0 });
});

test("computeProjectPnl: kinds, net figures and roiPct cases", () => {
  assert.deepEqual(computeProjectPnl([{ kind: "investment", total: 100 }, { kind: "expense", total: 40 }, { kind: "income", total: 70 }]),
    { invested: 100, spent: 40, earned: 70, netPnl: 30, netPosition: 130, roiPct: 75 });
  assert.equal(computeProjectPnl([{ kind: "income", total: 5 }]).roiPct, 100);
  assert.equal(computeProjectPnl([]).roiPct, null);
  assert.equal(computeProjectPnl([{ kind: "investment", total: 9 }]).roiPct, null);
  assert.equal(computeProjectPnl([{ kind: "expense", total: 10 }, { kind: "income", total: 4 }]).roiPct, -60);
  assert.deepEqual(computeProjectPnl([{ kind: "transfer", total: 999 }]), { invested: 0, spent: 0, earned: 0, netPnl: 0, netPosition: 0, roiPct: null });
});

test("computeProjectPnl uses plain doubles: no rounding is applied", () => {
  const r = computeProjectPnl([{ kind: "income", total: 0.1 }, { kind: "income", total: 0.2 }]);
  assert.equal(r.earned, 0.1 + 0.2);
  assert.notEqual(r.earned, 0.3);
});
