import { createIntegrationGraph } from "../../packages/platform-governance/src/index.mjs";
import { validateContracts } from "../contract-validator/index.mjs";

export function validateIntegration({ graphDefinition, contracts = {} } = {}) {
  const graph = createIntegrationGraph(graphDefinition);
  const graphFindings = graph.findings();
  const contractResult = validateContracts(contracts);
  const critical = graphFindings.filter((finding) => finding.severity === "critical");
  return {
    status: critical.length || !contractResult.valid ? "BLOCKED" : "READY",
    graph: { nodes: graph.nodes().length, edges: graph.edges().length, findings: graphFindings },
    contracts: contractResult,
  };
}

export function assertIntegrationReady(result) {
  if (result.status !== "READY") {
    const error = new Error("Integration graph has unresolved critical findings");
    error.code = "INTEGRATION_NOT_READY";
    error.result = result;
    throw error;
  }
  return result;
}