import { assertIdentifier } from "@ayzen/platform-governance";

export const COMPONENT_KINDS = Object.freeze([
  "app", "domain", "feature", "sub-feature", "function", "module",
  "api", "service", "database", "event", "workflow", "worker-pool",
  "scheduler-job", "notification-channel", "telegram-command",
  "ui-route", "artifact", "engine", "control-plane",
]);

export const COMPONENT_ENVIRONMENTS = Object.freeze(["production", "staging", "development", "preview"]);

const LIFECYCLE_STATES = new Set(["DRAFT", "READY", "ACTIVE", "PAUSED", "DEPRECATED", "QUARANTINED"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

/**
 * Validates and normalizes one canonical component entry.
 * Enforces the Phase 01 gate: id, kind, owner, app, environment and lifecycle
 * are all mandatory — a component missing any of them is rejected at
 * registration time rather than being allowed to enter the registry.
 */
export function validateComponentDefinition(definition = {}) {
  const component = {
    id: assertIdentifier(definition.id, "Component id"),
    kind: requiredString(definition.kind, "Component kind"),
    owner: assertIdentifier(definition.owner, "Component owner"),
    app: assertIdentifier(definition.app ?? definition.owner, "Component app"),
    environment: requiredString(definition.environment ?? "production", "Component environment"),
    lifecycle: definition.lifecycle ?? "ACTIVE",
    source: {
      registry: requiredString(definition.source?.registry, "Component source registry"),
      originalId: requiredString(definition.source?.originalId ?? definition.id, "Component source id"),
    },
    metadata: definition.metadata && typeof definition.metadata === "object" ? { ...definition.metadata } : {},
  };
  if (!COMPONENT_KINDS.includes(component.kind)) throw new Error(`${component.id}: invalid component kind "${component.kind}"`);
  if (!COMPONENT_ENVIRONMENTS.includes(component.environment)) throw new Error(`${component.id}: invalid component environment "${component.environment}"`);
  if (!LIFECYCLE_STATES.has(component.lifecycle)) throw new Error(`${component.id}: invalid component lifecycle "${component.lifecycle}"`);
  return Object.freeze(component);
}
