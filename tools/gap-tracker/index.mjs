import { readJson, gate } from "../enforcement-lib.mjs";
const schema = readJson("schemas/gap-lifecycle/gap.v1.json");
console.log(JSON.stringify(gate("gap-lifecycle", schema.required.includes("remediationWorkflow") && schema.required.includes("slaHours"), { schema: schema.$id }), null, 2));