import { readJson, gate } from "../enforcement-lib.mjs";
const graph = readJson("infrastructure/platform/runtime-execution-graph.json");
console.log(JSON.stringify(gate("runtime-execution-graph", graph.identity.includes("traceId") && graph.comparison, graph), null, 2));