import { createHealthRegistry } from "@ayzen/platform-governance";

export function createPlatformHealth({ requiredChecks = [], audit = () => {} } = {}) {
  const registry = createHealthRegistry({ checks: requiredChecks.map((id) => ({ id, status: "unknown" })) });
  function report(id, status, details) {
    const result = registry.set(id, status, details);
    audit({ action: "service.health.changed", ...result });
    return result;
  }
  return Object.freeze({ report, checks: registry.list, summary: registry.summary });
}