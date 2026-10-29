import { assertIdentifier } from "@ayzen/platform-governance";

/**
 * Stages the current source registries (Phase 01 component registry,
 * endpoint registry, event catalog) can actually populate today. A circuit
 * missing one of these is a REQUIRED_STAGE_MISSING critical finding (the
 * roadmap's "missing-edge gate"). Every other universal-circuit stage from
 * roadmap section 4 (scheduler, notification, telemetry, intelligence,
 * recovery, lifecycle, runtime-graph, enforcement-gate, ...) is tracked as
 * optional until a later phase produces that data -- listing them as
 * required here would fail almost every circuit on data this phase has no
 * way to source, which is a false gate, not a real one.
 */
export const REQUIRED_STAGES = Object.freeze(["feature", "api", "service", "data", "audit"]);

export const OPTIONAL_STAGES = Object.freeze([
  "sub-feature", "function", "module", "outbox", "event", "workflow", "worker",
  "scheduler", "notification", "telemetry", "intelligence", "recovery",
  "lifecycle", "artifact", "deployment", "admin-telegram",
]);

const SOURCE_KINDS = new Set(["curated-feature-component", "endpoint-registry", "event-catalog"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

/**
 * Validates and normalizes one feature circuit entry against
 * schemas/circuit/feature-circuit.v1.json's required-field shape.
 * Distinct from the required-STAGE gate in `findings()` below: this only
 * enforces that the entry is well-formed, not that every stage is present.
 */
export function validateCircuitDefinition(definition = {}) {
  const circuit = {
    id: assertIdentifier(definition.id ?? `circuit:${definition.feature ?? ""}`, "Circuit id"),
    feature: requiredString(definition.feature, "Circuit feature"),
    componentId: definition.componentId ?? null,
    api: requiredString(definition.api, "Circuit api"),
    service: requiredString(definition.service, "Circuit service"),
    data: requiredString(definition.data, "Circuit data"),
    audit: requiredString(definition.audit ?? "none", "Circuit audit"),
    stages: Array.isArray(definition.stages) ? [...new Set(definition.stages)] : [],
    source: {
      kind: requiredString(definition.source?.kind, "Circuit source kind"),
      registry: requiredString(definition.source?.registry, "Circuit source registry"),
    },
  };
  if (!circuit.id.startsWith("circuit:")) throw new Error(`${circuit.feature}: circuit id must start with "circuit:"`);
  if (!SOURCE_KINDS.has(circuit.source.kind)) throw new Error(`${circuit.feature}: invalid source kind "${circuit.source.kind}"`);

  // Passthrough optional fields, preserved as given.
  for (const key of [
    "domain", "subFeature", "function", "module", "route", "auth", "policy",
    "outbox", "event", "consumers", "workflow", "worker", "scheduler",
    "notification", "telemetry", "intelligence", "recovery", "lifecycle",
    "artifact", "deployment", "adminTelegram",
  ]) {
    if (definition[key] !== undefined) circuit[key] = definition[key];
  }
  return Object.freeze(circuit);
}
