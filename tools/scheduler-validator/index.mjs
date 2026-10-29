import { readJson, gate } from "../enforcement-lib.mjs";
const policy = readJson("config/scheduler/policy.json");
const passed = policy.lease.required && policy.idempotency.required && policy.safePauseResume && policy.duplicateExecution === "deny";
console.log(JSON.stringify(gate("scheduler-ha", passed, policy), null, 2));