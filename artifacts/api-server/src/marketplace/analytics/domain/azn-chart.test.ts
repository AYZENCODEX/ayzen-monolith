import test from "node:test";
import assert from "node:assert/strict";
import { buildAznChart } from "./azn-chart";

// ---- reference: the handler body exactly as routes/marketplace.ts had it before MKT-05f (Math.random replaced by `rand`) ----
function reference(now: Date, rand: () => number) {
  const BASE_PRICE = 0.01;
  const days = 30;
  const data: any[] = [];
  let price = BASE_PRICE;
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const seed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    const pseudoRand = (s: number) => ((s * 1664525 + 1013904223) & 0x7FFFFFFF) / 0x7FFFFFFF;
    const r1 = pseudoRand(seed); const r2 = pseudoRand(seed + 1); const r3 = pseudoRand(seed + 2); const r4 = pseudoRand(seed + 3);
    const intraSwing = (r1 - 0.5) * 0.08; const closeAdj = (r2 - 0.5) * 0.02;
    const open = price; const high = price * (1 + Math.abs(intraSwing) + r3 * 0.02); const low = price * (1 - Math.abs(intraSwing) - r4 * 0.02); const close = price * (1 + closeAdj);
    data.push({ date: dateStr, open: Number(open.toFixed(5)), high: Number(high.toFixed(5)), low: Number(low.toFixed(5)), close: Number(close.toFixed(5)), volume: Math.floor(10000 + r1 * 90000), price_usd: Number(close.toFixed(5)), azn_per_usd: Math.round(1 / close) });
    price = close;
  }
  const last = data[data.length - 1];
  last.close = BASE_PRICE * (1 + (rand() - 0.5) * 0.01);
  last.price_usd = last.close;
  last.azn_per_usd = Math.round(1 / last.close);
  return { base_usd: BASE_PRICE, azn_per_usd: 100, data };
}

test("the chart equals the original algorithm for many dates and random values (including month and year boundaries)", () => {
  const dates = ["2026-01-01T00:00:00Z", "2026-03-01T12:00:00Z", "2026-03-31T23:59:59Z", "2026-12-31T10:00:00Z", "2028-02-29T08:00:00Z", "2026-10-27T05:30:00Z"];
  for (const d of dates) for (const r of [0, 0.25, 0.5, 0.999, 0.123456]) {
    assert.deepEqual(buildAznChart(new Date(d), () => r), reference(new Date(d), () => r), `${d} ${r}`);
  }
});
test("shape: 31 daily points, fixed base, and the random source is used exactly once, for the last point only", () => {
  let calls = 0;
  const c = buildAznChart(new Date("2026-06-15T12:00:00Z"), () => { calls++; return 0.5; });
  assert.equal(calls, 1);
  assert.equal(c.data.length, 31); assert.equal(c.base_usd, 0.01); assert.equal(c.azn_per_usd, 100);
  assert.equal(c.data[30].close, 0.01); // random 0.5 gives no wobble
  const again = buildAznChart(new Date("2026-06-15T12:00:00Z"), () => 0.9);
  assert.deepEqual(c.data.slice(0, 30), again.data.slice(0, 30), "everything but the last point is deterministic");
});
