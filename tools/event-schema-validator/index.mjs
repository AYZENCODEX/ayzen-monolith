import { readJson, gate } from "../enforcement-lib.mjs";
const registry = readJson("config/events/registry.json");
const schema = readJson("schemas/events/compatibility.v1.json");
const passed = registry.compatibility && schema.required.includes("eventType") && registry.requiredFields.length >= 5;
console.log(JSON.stringify(gate("event-schema-compatibility", passed, { registry, schema: schema.$id }), null, 2));