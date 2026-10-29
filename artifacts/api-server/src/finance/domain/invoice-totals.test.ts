import assert from "node:assert/strict";
import test from "node:test";
import { computeInvoiceTotals, computeLineItemsTotal } from "./invoice-totals";

test("line totals sum quantities and round the overall result to two decimals", () => {
  assert.equal(computeLineItemsTotal([
    { description: "Service", quantity: 2, unitPrice: 12.34 },
    { description: "Materials", quantity: 3, unitPrice: 0.2 },
  ]), 25.28);
  assert.equal(computeLineItemsTotal([]), 0);
});

test("line totals preserve current JavaScript half-cent rounding behavior", () => {
  assert.equal(computeLineItemsTotal([
    { description: "Legacy half-cent case", quantity: 1, unitPrice: 1.005 },
  ]), 1);
  assert.equal(computeLineItemsTotal([
    { description: "Legacy half-cent case", quantity: 1, unitPrice: 1.015 },
  ]), 1.01);
});

test("invoice totals apply percentage discount before tax and round each stage", () => {
  assert.deepEqual(computeInvoiceTotals(
    [{ description: "Invoice", quantity: 1, unitPrice: 19.99 }],
    { discountType: "percent", discountValue: 12.5, taxRate: 8.25 },
  ), {
    subtotal: 19.99,
    discountAmount: 2.5,
    taxableAmount: 17.49,
    taxAmount: 1.44,
    total: 18.93,
  });
});

test("invoice totals preserve discount and tax bounds", () => {
  const line = [{ description: "Invoice", quantity: 1, unitPrice: 100 }];
  assert.deepEqual(computeInvoiceTotals(line, {
    discountType: "percent",
    discountValue: 125,
    taxRate: 5,
  }), {
    subtotal: 100,
    discountAmount: 100,
    taxableAmount: 0,
    taxAmount: 0,
    total: 0,
  });
  assert.deepEqual(computeInvoiceTotals(line, {
    discountType: "flat",
    discountValue: -10,
    taxRate: -5,
  }), {
    subtotal: 100,
    discountAmount: 0,
    taxableAmount: 100,
    taxAmount: 0,
    total: 100,
  });
});
