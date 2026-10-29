import { readJson, gate } from "../enforcement-lib.mjs";
const policy = readJson("infrastructure/platform/event-operations.json");
const passed = policy.deadLetter.enabled && policy.deadLetter.operatorApprovalForReplay && policy.checkpoint.monotonic && policy.idempotency.required;
console.log(JSON.stringify(gate("event-operations", passed, policy), null, 2));