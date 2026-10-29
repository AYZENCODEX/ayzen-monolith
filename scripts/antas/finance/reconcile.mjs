import fs from "node:fs";

const failures = [];
const service = fs.existsSync("services/finance/src/index.mjs") ? fs.readFileSync("services/finance/src/index.mjs", "utf8") : "";
if (!service) failures.push("finance service evidence is missing");
for (const marker of ["idempot", "ledger", "transaction"]) {
  if (!service.toLowerCase().includes(marker)) failures.push(`finance marker missing: ${marker}`);
}
const report = {
  schemaVersion: 1,
  status: failures.length ? "BLOCKED" : "UNVERIFIED",
  checks: {
    debitsEqualCredits: "UNVERIFIED",
    balanceEquation: "UNVERIFIED",
    postedTransactionsImmutable: "UNVERIFIED",
    providerBackedReconciliation: "UNVERIFIED",
  },
  reason: "No provider-backed ledger dataset was supplied; the script refuses to invent balances.",
};
fs.mkdirSync("reports/antas/ANTAS-06", { recursive: true });
fs.writeFileSync("reports/antas/ANTAS-06/reconciliation.json", `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("ANTAS finance contract found; reconciliation is UNVERIFIED without a ledger dataset");