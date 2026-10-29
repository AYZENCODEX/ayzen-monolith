import { readJson, gate } from "../enforcement-lib.mjs";
const schema = readJson("schemas/data-lineage/record.v1.json");
console.log(JSON.stringify(gate("data-lineage", schema.required.includes("featureId") && schema.required.includes("destination"), { schema: schema.$id }), null, 2));