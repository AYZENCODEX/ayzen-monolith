import test from "node:test";
import assert from "node:assert/strict";
import { feeByFraction, feeByProduct, feeRounded4 } from "./money";

// The inline expressions the route files used before MKT-03, kept here as the reference.
const inlineFraction = (amount: number, pct: number) => amount * (pct / 100);
const inlineProduct = (amount: number, pct: number) => (amount * pct) / 100;
const inlineRounded4 = (amount: number, pct: number) => Number(((amount * pct) / 100).toFixed(4));

function* samples(): Generator<[number, number]> {
  const pcts = [0, 0.1, 2.5, 3, 5, 7.25, 33.3333, 100];
  const amounts = [0, 0.01, 0.1, 0.2, 0.3, 1, 1.005, 2.675, 9.99, 10, 12.34, 99.99, 100, 1234.5678, 1e6, 123456789.123];
  for (const p of pcts) for (const a of amounts) yield [a, p];
  let seed = 12345; // deterministic pseudo-random inputs
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const a = (seed % 1000000) / 100;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    yield [a, (seed % 10000) / 100];
  }
}

test("feeByFraction is bit-for-bit amount * (pct / 100)", () => {
  for (const [a, p] of samples()) assert.ok(Object.is(feeByFraction(a, p), inlineFraction(a, p)), `${a} ${p}`);
});
test("feeByProduct is bit-for-bit (amount * pct) / 100", () => {
  for (const [a, p] of samples()) assert.ok(Object.is(feeByProduct(a, p), inlineProduct(a, p)), `${a} ${p}`);
});
test("feeRounded4 is bit-for-bit Number(((amount * pct) / 100).toFixed(4))", () => {
  for (const [a, p] of samples()) assert.ok(Object.is(feeRounded4(a, p), inlineRounded4(a, p)), `${a} ${p}`);
});
test("the three forms are NOT interchangeable (this is why they stay separate)", () => {
  let differs = 0;
  for (const [a, p] of samples()) if (!Object.is(feeByFraction(a, p), feeByProduct(a, p))) differs++;
  assert.ok(differs > 0, "expected at least one input where the operation order changes the last bit");
});
