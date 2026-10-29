import { readJson, gate } from "../enforcement-lib.mjs";
const registry = readJson("infrastructure/secrets/registry.json");
const passed = registry.valuesNeverStored === true && registry.entries.every((entry) => entry.revocationTest === true && entry.rotationDays > 0);
console.log(JSON.stringify(gate("secret-lifecycle", passed, { entries: registry.entries.length }), null, 2));