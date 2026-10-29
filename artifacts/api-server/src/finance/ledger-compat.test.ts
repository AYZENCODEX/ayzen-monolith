import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Ledger ownership gate (static, no DB). WP-3 moved the ledger core to finance/ledger/*; WP-8 removed the
// lib/finance-accounting.ts compatibility path. Mirrors the `wp3-single-owner` check in
// scripts/antas/finance/validate-boundaries.mjs.

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = ["books", "system-accounts", "journal", "repayments", "balances"];
const PUBLIC_EXPORTS = ["listBooks", "resolveBookId", "SYSTEM_ACCOUNTS", "ensureSystemAccounts", "REPAYABLE_KINDS", "postJournal", "postEntryJournal", "postEntryAdjustmentJournal", "postRepaymentJournal", "postLateFeeAccrualJournal", "deleteJournalForEntry", "deleteLedgerEntryCascade", "applyPrincipalRepayment", "applyPrincipalRepaymentTx", "recordRepayment", "payAmortizationInstallment", "computeAccountBalances"];

test("the legacy lib/finance-accounting.ts path is gone (WP-8)", () => {
  assert.ok(!fs.existsSync(path.join(here, "../lib/finance-accounting.ts")));
});

test("every ledger symbol is declared in exactly one ledger module", () => {
  for (const name of PUBLIC_EXPORTS) {
    const owners = LEDGER
      .map((f) => fs.readFileSync(path.join(here, "ledger", `${f}.ts`), "utf8"))
      .filter((src) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`).test(src));
    assert.equal(owners.length, 1, `${name} must be declared in exactly one ledger module`);
  }
});

test("ledger modules import neither the legacy path, routes, nor application code", () => {
  for (const f of LEDGER) {
    const src = fs.readFileSync(path.join(here, "ledger", `${f}.ts`), "utf8");
    assert.doesNotMatch(src, /from\s+["'][^"']*(?:finance-accounting|\/lib\/|\/routes\/|\/application\/)/, `${f}.ts has a forbidden import`);
  }
});
