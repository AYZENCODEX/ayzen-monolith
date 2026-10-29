import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeGraph } from "../../services/runtime-graph/src/index.mjs";

test("runtime graph detects a missing critical hop", () => {
  const graph = createRuntimeGraph();
  graph.record({ traceId: "failure-trace", from: "api", to: "service" });
  const result = graph.compare([{ from: "api", to: "service" }, { from: "service", to: "eventbus" }]);
  assert.equal(result.complete, false);
  assert.equal(result.missing.length, 1);
});