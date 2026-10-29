import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBankSms, parseQuickEntryText } from "./finance-ai";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance integration-backed module tests require DATABASE_URL_TARGET="replit-test".');
}

test("quick entry parsing preserves compound entries and caller currency", async () => {
  const drafts = await parseQuickEntryText(0, "salary received 1,200 and also lunch $15", "USD");
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map(({ amount, currency, kind, suggestedCategory, parseOk }) => ({
    amount, currency, kind, suggestedCategory, parseOk,
  })), [
    { amount: 1200, currency: "USD", kind: "income", suggestedCategory: "Salary", parseOk: true },
    { amount: 15, currency: "USD", kind: "expense", suggestedCategory: "Food", parseOk: true },
  ]);
});

test("bank SMS parsing detects USD and INR and rejects messages without amounts", () => {
  assert.equal(parseBankSms("USD 1,500 credited")?.currency, "USD");
  assert.equal(parseBankSms("₹1,250 received")?.currency, "INR");
  assert.equal(parseBankSms("Payment confirmed") , null);
});
