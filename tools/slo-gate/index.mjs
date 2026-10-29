import { readJson, gate } from "../enforcement-lib.mjs";
const policy = readJson("config/slo/gates.json");
const passed = policy.operator === "all-must-pass" && policy.breachAction === "block-promotion-and-create-gap" && Object.keys(policy.services).length > 0;
console.log(JSON.stringify(gate("slo-release-gate", passed, policy), null, 2));