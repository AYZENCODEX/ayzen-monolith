import { readJson, gate } from "../enforcement-lib.mjs";
const coverage = readJson("config/observability/coverage.json");
console.log(JSON.stringify(gate("observability-completeness", coverage.requiredSignals.length === 5 && coverage.missingSignalAction === "block-readiness", coverage), null, 2));