import { validateLifecycleTransition } from "./index.mjs";

export function createLifecycleRegistry({ resources = [] } = {}) {
  const registry = new Map(resources.map((resource) => [resource.id, { ...resource }]));
  function transition(id, to) {
    const resource = registry.get(id);
    if (!resource) throw new Error(`Unknown lifecycle resource: ${id}`);
    validateLifecycleTransition(resource.lifecycle, to);
    const next = { ...resource, lifecycle: to };
    registry.set(id, next);
    return Object.freeze(next);
  }
  function findings() {
    const result = [];
    for (const resource of registry.values()) {
      if (resource.lifecycle === "ACTIVE" && resource.requiredService && resource.requiredServiceLifecycle !== "ACTIVE") {
        result.push({ code: "ACTIVE_RESOURCE_WITH_INACTIVE_DEPENDENCY", resource: resource.id, dependency: resource.requiredService });
      }
    }
    return result;
  }
  return Object.freeze({ list: () => [...registry.values()], transition, findings, status: () => findings().length ? "BLOCKED" : "READY" });
}