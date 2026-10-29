import { createIntegrationGraph } from "@ayzen/platform-governance";

export function validateCircuit({ graph }) {
  const findings = graph.findings();
  return {
    status: findings.some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY",
    findings,
    nodeCount: graph.nodes().length,
    edgeCount: graph.edges().length,
  };
}

export function assertCircuitReady(result) {
  if (result.status !== "READY") {
    const error = new Error(`Universal circuit is blocked by ${result.findings.length} finding(s)`);
    error.code = "CIRCUIT_BLOCKED";
    error.findings = result.findings;
    throw error;
  }
  return result;
}

export { createIntegrationGraph };