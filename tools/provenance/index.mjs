import { readJson, gate } from "../enforcement-lib.mjs";
const schema = readJson("schemas/provenance/record.v1.json");
console.log(JSON.stringify(gate("artifact-provenance", schema.required.includes("artifactDigest") && schema.required.includes("deploymentId"), { schema: schema.$id }), null, 2));