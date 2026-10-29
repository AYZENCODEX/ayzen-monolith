import { readJson, gate } from "../enforcement-lib.mjs";
const ledger = readJson("infrastructure/migrations/ledger.json");
const passed = ledger.checksumAlgorithm === "sha256" && ledger.requiredEvidence.includes("restoreEvidence");
console.log(JSON.stringify(gate("schema-drift", passed, ledger), null, 2));