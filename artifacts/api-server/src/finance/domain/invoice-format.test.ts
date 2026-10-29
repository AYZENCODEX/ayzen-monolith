import assert from "node:assert/strict";
import test from "node:test";
import { amountInWords, formatInvoiceNumber } from "./invoice-format";

// Expected values were captured from the pre-extraction implementation in
// lib/finance-invoice.ts (FIN-02B baseline), including its current quirks.
const CREATED = new Date(2026, 5, 15);

test("formatInvoiceNumber preserves prefix sanitising, default prefix and zero padding", () => {
  const cases: [string | null | undefined, number, string][] = [
    [null, 42, "INV-2026-00042"],
    ["inv", 7, "INV-2026-00007"],
    ["  ab-c 1! ", 123456, "ABC1-2026-123456"],
    ["!!!", 1, "INV-2026-00001"],
    ["", 0, "INV-2026-00000"],
    [undefined, 99999, "INV-2026-99999"],
  ];
  for (const [prefix, id, expected] of cases) {
    assert.equal(formatInvoiceNumber(prefix, id, CREATED), expected);
  }
});

test("amountInWords preserves wording, cents rounding and clamping", () => {
  const cases: [number, string][] = [
    [0, "BDT Zero Only"],
    [1, "BDT One Only"],
    [19, "BDT Nineteen Only"],
    [20, "BDT Twenty Only"],
    [21, "BDT Twenty One Only"],
    [99, "BDT Ninety Nine Only"],
    [100, "BDT One Hundred Only"],
    [101, "BDT One Hundred One Only"],
    [999, "BDT Nine Hundred Ninety Nine Only"],
    [1000, "BDT One Thousand Only"],
    [12000.5, "BDT Twelve Thousand and 50/100 Only"],
    [12000.499, "BDT Twelve Thousand and 50/100 Only"],
    [0.005, "BDT Zero and 01/100 Only"],
    [0.994, "BDT Zero and 99/100 Only"],
    [1234567.89, "BDT One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven and 89/100 Only"],
    [1000000000, "BDT One Billion Only"],
    [2147483647.99, "BDT Two Billion One Hundred Forty Seven Million Four Hundred Eighty Three Thousand Six Hundred Forty Seven and 99/100 Only"],
    [-5, "BDT Zero Only"],
    [NaN, "BDT Zero Only"],
  ];
  for (const [amount, expected] of cases) {
    assert.equal(amountInWords("BDT", amount), expected);
  }
  assert.equal(amountInWords("USD", null as unknown as number), "USD Zero Only");
});

test("amountInWords keeps the existing international-scale quirk above one billion", () => {
  assert.equal(amountInWords("BDT", 1e12), "BDT Ten Hundred Billion Only");
});
