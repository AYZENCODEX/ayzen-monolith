import { createEnforcementFabric } from "@ayzen/platform-governance";

export function createRuntimeEnforcement({ graph, audit = () => {}, onQuarantine = () => {} } = {}) {
  const fabric = createEnforcementFabric({ graph, audit, quarantine: onQuarantine });
  return Object.freeze({
    authorize(edge) {
      return fabric.assertApproved(edge);
    },
    evaluate(edge) {
      return fabric.evaluate(edge);
    },
    status: () => graph.status(),
  });
}