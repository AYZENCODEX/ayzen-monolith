import { readJson, gate } from "../enforcement-lib.mjs";
const policy = readJson("config/environments/parity.json");
console.log(JSON.stringify(gate("environment-parity", policy.ignore.includes("secretValues") && policy.driftAction === "block-promotion", policy), null, 2));