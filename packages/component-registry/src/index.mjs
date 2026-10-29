import { validateComponentDefinition, COMPONENT_KINDS, COMPONENT_ENVIRONMENTS } from "./validate.mjs";

export { validateComponentDefinition, COMPONENT_KINDS, COMPONENT_ENVIRONMENTS };

/**
 * Canonical Component Registry (Phase 01).
 *
 * One machine-readable catalog for every production component — apps,
 * features, sub-features, functions, modules, APIs, services, databases,
 * events, workflows, worker pools, scheduler jobs, notification channels,
 * Telegram commands, UI routes, artifacts, engines and control-planes.
 *
 * Every entry is required to carry a stable id, owner, app, environment and
 * lifecycle (enforced by validateComponentDefinition) and a duplicate id is
 * rejected outright, so bad data structurally cannot enter the registry.
 */
export function createComponentCatalog({ components = [], expectedSources = [] } = {}) {
  const byId = new Map();

  function register(definition) {
    const component = validateComponentDefinition(definition);
    if (byId.has(component.id)) throw new Error(`Duplicate component id: ${component.id}`);
    byId.set(component.id, component);
    return component;
  }

  for (const definition of components) register(definition);

  function resolve(id) {
    const component = byId.get(id);
    if (!component) throw new Error(`Unknown component: ${id}`);
    return component;
  }

  const list = () => [...byId.values()];
  const byKind = (kind) => list().filter((component) => component.kind === kind);
  const byApp = (app) => list().filter((component) => component.app === app);
  const byOwner = (owner) => list().filter((component) => component.owner === owner);
  const bySourceRegistry = (registry) => list().filter((component) => component.source.registry === registry);

  /**
   * Registry-level findings, distinct from per-component validation:
   * a declared source registry that contributed zero components, and any
   * component left in a QUARANTINED lifecycle state.
   */
  function findings() {
    const result = [];
    const represented = new Set(list().map((component) => component.source.registry));
    for (const registry of expectedSources) {
      if (!represented.has(registry)) result.push({ severity: "critical", code: "SOURCE_REGISTRY_NOT_REPRESENTED", registry });
    }
    for (const component of list()) {
      if (component.lifecycle === "QUARANTINED") result.push({ severity: "warning", code: "COMPONENT_QUARANTINED", id: component.id });
    }
    return result;
  }

  /** Registry completeness scan (Phase 01 verification requirement). */
  function completeness() {
    const total = expectedSources.length || 0;
    const representedCount = expectedSources.filter((registry) => bySourceRegistry(registry).length > 0).length;
    return {
      totalComponents: list().length,
      totalSourceRegistries: total,
      representedSourceRegistries: representedCount,
      ratio: total === 0 ? 1 : representedCount / total,
      byKind: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, byKind(kind).length])),
    };
  }

  return Object.freeze({
    register,
    resolve,
    list,
    byKind,
    byApp,
    byOwner,
    bySourceRegistry,
    findings,
    completeness,
    status: () => (findings().some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY"),
  });
}
