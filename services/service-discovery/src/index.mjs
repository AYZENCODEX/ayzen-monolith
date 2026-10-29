import { createHealthRegistry } from "@ayzen/platform-governance";
import { createServiceRegistry } from "@ayzen/service-registry";

export function createServiceDiscovery({ services = [], fallback = "monolith", now = () => Date.now(), staleAfterMs = 90_000 } = {}) {
  const registry = createServiceRegistry(services);
  const health = createHealthRegistry({ checks: services.map((service) => ({ id: service.id, status: "unknown" })) });
  const instances = new Map();
  function report({ serviceId, instanceId = serviceId, status, details = {} }) {
    registry.resolve(serviceId);
    const record = { serviceId, instanceId, status, details, checkedAt: now() };
    instances.set(instanceId, record);
    health.set(instanceId, status, details);
    return record;
  }
  function resolve(serviceId) {
    const service = registry.resolve(serviceId);
    const candidates = [...instances.values()].filter((item) => item.serviceId === serviceId && now() - item.checkedAt <= staleAfterMs && item.status === "healthy");
    return candidates[0] ?? (serviceId === fallback ? { service, instanceId: fallback, status: "fallback" } : undefined);
  }
  function pruneStale() {
    const removed = [];
    for (const [instanceId, item] of instances) {
      if (now() - item.checkedAt > staleAfterMs) {
        instances.delete(instanceId);
        removed.push(item);
      }
    }
    return removed;
  }
  return Object.freeze({ registry, health, report, resolve, pruneStale, instances: () => [...instances.values()], ready: (serviceId) => Boolean(resolve(serviceId)) });
}