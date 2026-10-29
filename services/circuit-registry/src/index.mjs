import { validateCircuitDefinition, REQUIRED_STAGES, OPTIONAL_STAGES } from "./validate.mjs";

export { validateCircuitDefinition, REQUIRED_STAGES, OPTIONAL_STAGES };

/**
 * Full Feature Circuit Registry (Phase 03).
 *
 * A machine-readable circuit per production feature, non-duplicating Phase
 * 01's Canonical Component Registry: rather than re-describing what a
 * feature *is*, this registry describes how it is *wired* across the
 * universal circuit (roadmap section 4) -- api, service, data, outbox,
 * eventbus, workflow, worker, audit, ... -- and cross-checks that wiring
 * against the Phase 01 "feature" kind components so a feature registered in
 * one place but not traced in the other becomes a finding, not a silent gap.
 */
export function createFeatureCircuitCatalog({ circuits = [], knownFeatureComponentIds = [] } = {}) {
  const byId = new Map();
  const byFeature = new Map();

  function register(definition) {
    const circuit = validateCircuitDefinition(definition);
    if (byId.has(circuit.id)) throw new Error(`Duplicate circuit id: ${circuit.id}`);
    byId.set(circuit.id, circuit);
    byFeature.set(circuit.feature, circuit);
    return circuit;
  }

  for (const definition of circuits) register(definition);

  function resolve(id) {
    const circuit = byId.get(id);
    if (!circuit) throw new Error(`Unknown circuit: ${id}`);
    return circuit;
  }

  const list = () => [...byId.values()];
  const resolveByFeature = (feature) => byFeature.get(feature) ?? null;
  const bySource = (kind) => list().filter((circuit) => circuit.source.kind === kind);

  /**
   * Registry-level findings:
   *  - REQUIRED_STAGE_MISSING (critical): the roadmap's "missing-edge gate"
   *    -- a circuit that does not carry one of REQUIRED_STAGES.
   *  - FEATURE_COMPONENT_UNTRACED (critical): the roadmap's
   *    "incomplete-circuit gate" -- a Phase 01 "feature" component with no
   *    matching circuit entry at all.
   *  - CIRCUIT_MISSING_FEATURE_COMPONENT (warning): a circuit with no
   *    matching Phase 01 feature component (componentId is null) --
   *    typically an endpoint/event-derived circuit that has not yet been
   *    promoted into a curated Phase 01 feature. Not critical on its own,
   *    since Phase 01 intentionally started with only 4 curated features,
   *    but tracked so the backlog of "circuits waiting on a Phase 01
   *    feature entry" is visible rather than silently absorbed.
   */
  function findings() {
    const result = [];
    for (const circuit of list()) {
      const missingStages = REQUIRED_STAGES.filter((stage) => !circuit.stages.includes(stage));
      if (missingStages.length > 0) {
        result.push({ severity: "critical", code: "REQUIRED_STAGE_MISSING", id: circuit.id, feature: circuit.feature, missingStages });
      }
      if (!circuit.componentId) {
        result.push({ severity: "warning", code: "CIRCUIT_MISSING_FEATURE_COMPONENT", id: circuit.id, feature: circuit.feature });
      }
    }
    const tracedComponentIds = new Set(list().map((circuit) => circuit.componentId).filter(Boolean));
    for (const componentId of knownFeatureComponentIds) {
      if (!tracedComponentIds.has(componentId)) {
        result.push({ severity: "critical", code: "FEATURE_COMPONENT_UNTRACED", componentId });
      }
    }
    return result;
  }

  /** Phase 03 completeness scan (roadmap verification requirement). */
  function completeness() {
    const total = list().length;
    const complete = list().filter((circuit) => REQUIRED_STAGES.every((stage) => circuit.stages.includes(stage))).length;
    const withFeatureComponent = list().filter((circuit) => circuit.componentId).length;
    const optionalStageCoverage = Object.fromEntries(
      OPTIONAL_STAGES.map((stage) => [stage, list().filter((circuit) => circuit.stages.includes(stage)).length]),
    );
    return {
      totalCircuits: total,
      requiredStageComplete: complete,
      requiredStageRatio: total === 0 ? 1 : complete / total,
      tracedToFeatureComponent: withFeatureComponent,
      featureComponentRatio: total === 0 ? 1 : withFeatureComponent / total,
      knownFeatureComponents: knownFeatureComponentIds.length,
      optionalStageCoverage,
    };
  }

  return Object.freeze({
    register,
    resolve,
    resolveByFeature,
    list,
    bySource,
    findings,
    completeness,
    status: () => (findings().some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY"),
  });
}
