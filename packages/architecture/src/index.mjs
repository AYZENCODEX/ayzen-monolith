import crypto from "node:crypto";

export const CIRCUIT_STAGES = Object.freeze([
  "domain",
  "dns-edge",
  "frontend",
  "page-route",
  "ui-module",
  "component",
  "feature",
  "sub-feature",
  "function",
  "sub-function",
  "module",
  "api-client",
  "api",
  "api-server",
  "service",
  "artifact",
  "deployment",
  "db-resource",
  "eventbus",
  "workflow",
  "audit",
  "intelligence",
  "admin-telegram",
]);

export const LINK_STATUSES = Object.freeze(["CONNECTED", "BROKEN", "MISSING", "OPTIONAL", "N/A", "DEPRECATED"]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a valid identifier`);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function indexById(items, label) {
  const index = new Map();
  for (const item of items ?? []) {
    assertIdentifier(item?.id, `${label} id`);
    if (index.has(item.id)) throw new Error(`Duplicate ${label}: ${item.id}`);
    if (typeof item.owner !== "string" || !item.owner.trim()) throw new Error(`${label} ${item.id} requires an owner`);
    index.set(item.id, clone(item));
  }
  return index;
}

function dependenciesOf(node) {
  return [
    ...(node?.dependsOn ?? []),
    ...(node?.dependencies ?? []),
    ...(node?.links ?? []).map((link) => link?.to).filter(Boolean),
  ];
}

function assertKnownReferences(indexes, item, label) {
  for (const reference of dependenciesOf(item)) {
    if (!Object.values(indexes).some((index) => index.has(reference))) {
      throw new Error(`${label} ${item.id} references unknown component: ${reference}`);
    }
  }
}

function freezeResult(value) {
  return Object.freeze(value);
}

export function validateArchitectureInput(input = {}) {
  const normalized = {
    components: input.components ?? [],
    domains: input.domains ?? [],
    features: input.features ?? [],
    resources: input.resources ?? [],
    routes: input.routes ?? [],
    events: input.events ?? [],
    workflows: input.workflows ?? [],
    deployments: input.deployments ?? [],
  };
  const indexes = {
    components: indexById(normalized.components, "component"),
    domains: indexById(normalized.domains, "domain"),
    features: indexById(normalized.features, "feature"),
    resources: indexById(normalized.resources, "resource"),
    routes: indexById(normalized.routes, "route"),
    events: indexById(normalized.events, "event"),
    workflows: indexById(normalized.workflows, "workflow"),
    deployments: indexById(normalized.deployments, "deployment"),
  };
  for (const [label, index] of Object.entries(indexes)) {
    for (const item of index.values()) assertKnownReferences(indexes, item, label);
  }
  return freezeResult({ normalized: clone(normalized), indexes });
}

export function createArchitectureRegistry(input = {}) {
  const validated = validateArchitectureInput(input);
  const state = {
    ...validated.normalized,
    runtimeObservations: [],
    findings: [],
  };
  const indexes = validated.indexes;

  function get(id) {
    assertIdentifier(id, "Architecture id");
    for (const index of Object.values(indexes)) if (index.has(id)) return clone(index.get(id));
    return undefined;
  }

  function traceCircuit(featureId) {
    const feature = indexes.features.get(featureId);
    if (!feature) throw new Error(`Feature is not registered: ${featureId}`);
    const links = feature.circuit ?? {};
    const nodes = CIRCUIT_STAGES.map((stage) => {
      const target = links[stage];
      const status = target === undefined
        ? (feature.optionalStages?.includes(stage) ? "OPTIONAL" : "MISSING")
        : target === null
          ? "N/A"
          : feature.deprecatedStages?.includes(stage)
            ? "DEPRECATED"
            : get(target)
              ? "CONNECTED"
              : "BROKEN";
      return { stage, target: target ?? null, status };
    });
    return freezeResult({
      featureId,
      status: nodes.some((node) => node.status === "BROKEN" || node.status === "MISSING") ? "INCOMPLETE" : "COMPLETE",
      nodes,
    });
  }

  function findImpacted(changedIds) {
    const wanted = new Set((changedIds ?? []).map((id) => assertIdentifier(id, "Changed id")));
    const impacted = new Set(wanted);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of Object.values(indexes).flatMap((index) => [...index.values()])) {
        if (!impacted.has(item.id) && dependenciesOf(item).some((dependency) => impacted.has(dependency))) {
          impacted.add(item.id);
          changed = true;
        }
      }
    }
    return [...impacted].map((id) => get(id)).filter(Boolean);
  }

  function dependencyCycles() {
    const nodes = Object.values(indexes).flatMap((index) => [...index.values()]);
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const visiting = new Set();
    const visited = new Set();
    const cycles = [];
    function visit(id, path = []) {
      if (visiting.has(id)) {
        const start = path.indexOf(id);
        cycles.push(path.slice(start).concat(id));
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      const item = byId.get(id);
      for (const dependency of dependenciesOf(item)) if (byId.has(dependency)) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    }
    for (const item of nodes) visit(item.id);
    return cycles;
  }

  function recordRuntimeObservation(observation = {}) {
    const required = ["traceId", "featureId", "path"];
    for (const field of required) if (typeof observation[field] !== "string" && !Array.isArray(observation[field])) {
      throw new Error(`Runtime observation ${field} is required`);
    }
    if (!Array.isArray(observation.path) || observation.path.length === 0) throw new Error("Runtime observation path is required");
    const record = {
      id: observation.id ?? crypto.randomUUID(),
      traceId: String(observation.traceId),
      featureId: String(observation.featureId),
      path: [...observation.path],
      latencyMs: Number.isFinite(observation.latencyMs) ? observation.latencyMs : undefined,
      retries: Number.isSafeInteger(observation.retries) ? observation.retries : 0,
      failed: observation.failed === true,
      occurredAt: observation.occurredAt ?? new Date().toISOString(),
    };
    state.runtimeObservations.push(record);
    return freezeResult(clone(record));
  }

  function compareRuntimePath(featureId, actualPath) {
    const expected = traceCircuit(featureId).nodes
      .filter((node) => node.status === "CONNECTED")
      .map((node) => node.target);
    const actual = [...(actualPath ?? [])];
    return freezeResult({
      featureId,
      expected,
      actual,
      missing: expected.filter((node) => !actual.includes(node)),
      unexpected: actual.filter((node) => !expected.includes(node)),
      matches: expected.every((node) => actual.includes(node)) && actual.every((node) => expected.includes(node)),
    });
  }

  function snapshot() {
    const data = {
      schemaVersion: 1,
      components: state.components,
      domains: state.domains,
      features: state.features,
      resources: state.resources,
      routes: state.routes,
      events: state.events,
      workflows: state.workflows,
      deployments: state.deployments,
    };
    return freezeResult({ ...clone(data), snapshotHash: digest(data) });
  }

  return freezeResult({
    get,
    list(kind) {
      if (!Object.prototype.hasOwnProperty.call(indexes, kind)) throw new Error(`Unknown architecture collection: ${kind}`);
      return [...indexes[kind].values()].map(clone);
    },
    traceCircuit,
    findImpacted,
    dependencyCycles,
    recordRuntimeObservation,
    compareRuntimePath,
    runtimeObservations: () => clone(state.runtimeObservations),
    snapshot,
  });
}

export function diffArchitectureSnapshots(before = {}, after = {}) {
  const collections = ["components", "domains", "features", "resources", "routes", "events", "workflows", "deployments"];
  const diff = {};
  for (const collection of collections) {
    const oldItems = new Map((before[collection] ?? []).map((item) => [item.id, item]));
    const newItems = new Map((after[collection] ?? []).map((item) => [item.id, item]));
    diff[collection] = {
      added: [...newItems.keys()].filter((id) => !oldItems.has(id)),
      removed: [...oldItems.keys()].filter((id) => !newItems.has(id)),
      changed: [...newItems.keys()].filter((id) => oldItems.has(id) && stable(newItems.get(id)) !== stable(oldItems.get(id))),
    };
  }
  return freezeResult(diff);
}

export function createFeatureCompletenessReport(registry, featureId) {
  const trace = registry.traceCircuit(featureId);
  const required = trace.nodes.filter((node) => !["OPTIONAL", "N/A", "DEPRECATED"].includes(node.status));
  const connected = required.filter((node) => node.status === "CONNECTED").length;
  return freezeResult({
    featureId,
    status: trace.status,
    connected,
    required: required.length,
    score: required.length ? Math.round((connected / required.length) * 100) : 100,
    missing: required.filter((node) => node.status !== "CONNECTED").map((node) => node.stage),
  });
}

export function createArchitectureHealthScorecard(registry) {
  const features = registry.list("features").map((feature) => createFeatureCompletenessReport(registry, feature.id));
  const observations = registry.runtimeObservations();
  const cycles = registry.dependencyCycles();
  const circuitScore = features.length
    ? Math.round(features.reduce((sum, feature) => sum + feature.score, 0) / features.length)
    : 100;
  const runtimeFailures = observations.filter((observation) => observation.failed).length;
  const runtimeScore = observations.length ? Math.round(((observations.length - runtimeFailures) / observations.length) * 100) : 100;
  return freezeResult({
    generatedAt: new Date().toISOString(),
    status: circuitScore === 100 && runtimeScore === 100 && cycles.length === 0 ? "healthy" : "attention_required",
    circuitScore,
    runtimeScore,
    dependencyCycles: cycles.length,
    features,
    runtimeObservations: observations.length,
  });
}

export function createArchitectureLoop(registry, { requireApproval = true } = {}) {
  const recommendations = [];
  return freezeResult({
    observe() {
      return createArchitectureHealthScorecard(registry);
    },
    propose({ title, reason, affectedIds = [], action = "review" } = {}) {
      if (typeof title !== "string" || title.trim().length < 3) throw new Error("Recommendation title is required");
      if (typeof reason !== "string" || reason.trim().length < 10) throw new Error("Recommendation evidence is required");
      const recommendation = {
        id: crypto.randomUUID(),
        title: title.trim(),
        reason: reason.trim(),
        affectedIds: affectedIds.map((id) => assertIdentifier(id, "Affected id")),
        action,
        status: requireApproval ? "awaiting_approval" : "proposed",
        createdAt: new Date().toISOString(),
      };
      recommendations.push(recommendation);
      return freezeResult(clone(recommendation));
    },
    list() {
      return clone(recommendations);
    },
    approve(id, { approver, reason } = {}) {
      const recommendation = recommendations.find((item) => item.id === id);
      if (!recommendation) throw new Error("Recommendation is not registered");
      if (requireApproval && (typeof approver !== "string" || !approver.trim())) throw new Error("Approver is required");
      recommendation.status = "approved";
      recommendation.approvedBy = approver;
      recommendation.approvalReason = reason;
      recommendation.approvedAt = new Date().toISOString();
      return freezeResult(clone(recommendation));
    },
  });
}

export const STRA_STAGES = Object.freeze([
  "domain",
  "app",
  "capability",
  "feature",
  "sub-feature",
  "function",
  "sub-function",
  "module",
  "service",
  "server-runtime",
  "api",
  "artifact",
  "db-resource",
  "eventbus",
  "workflow",
  "audit",
  "intelligence",
]);

export const STRA_EDGE_TYPES = Object.freeze([
  "contains",
  "depends-on",
  "routes-to",
  "authorizes",
  "uses",
  "deploys",
  "persists-to",
  "publishes",
  "consumes",
  "starts",
  "audits",
  "observes",
]);

export const STRA_STATES = Object.freeze([
  "CONNECTED",
  "BROKEN",
  "MISSING",
  "OPTIONAL",
  "BLOCKED",
  "DEPRECATED",
  "N/A",
]);

function validateStraGraphInput(input = {}) {
  const nodes = input.nodes ?? [];
  const edges = input.edges ?? [];
  const localCircuits = input.localCircuits ?? [];
  const nodeIndex = indexById(nodes, "STRA node");
  for (const node of nodeIndex.values()) {
    if (!STRA_STAGES.includes(node.stage)) throw new Error(`Unknown STRA stage for ${node.id}: ${node.stage}`);
    if (typeof node.kind !== "string" || !node.kind.trim()) throw new Error(`STRA node ${node.id} requires a kind`);
    if (node.state !== undefined && !STRA_STATES.includes(node.state)) {
      throw new Error(`Unknown STRA state for ${node.id}: ${node.state}`);
    }
  }
  const edgeIds = new Set();
  const normalizedEdges = edges.map((edge, index) => {
    const id = edge.id ?? `edge-${index + 1}`;
    assertIdentifier(id, "STRA edge id");
    if (edgeIds.has(id)) throw new Error(`Duplicate STRA edge: ${id}`);
    edgeIds.add(id);
    if (!nodeIndex.has(edge.from) || !nodeIndex.has(edge.to)) {
      throw new Error(`STRA edge ${id} references an unknown node`);
    }
    if (!STRA_EDGE_TYPES.includes(edge.type)) throw new Error(`Unknown STRA edge type: ${edge.type}`);
    return { ...clone(edge), id };
  });
  const circuitIndex = indexById(localCircuits, "STRA circuit");
  for (const circuit of circuitIndex.values()) {
    if (!Array.isArray(circuit.nodeIds) || circuit.nodeIds.length === 0) {
      throw new Error(`STRA circuit ${circuit.id} requires nodeIds`);
    }
    for (const nodeId of circuit.nodeIds) {
      if (!nodeIndex.has(nodeId)) throw new Error(`STRA circuit ${circuit.id} references unknown node: ${nodeId}`);
    }
    if (circuit.entryNode && !nodeIndex.has(circuit.entryNode)) {
      throw new Error(`STRA circuit ${circuit.id} references unknown entry node: ${circuit.entryNode}`);
    }
  }
  return {
    nodes: [...nodeIndex.values()],
    edges: normalizedEdges,
    localCircuits: [...circuitIndex.values()],
    nodeIndex,
    circuitIndex,
  };
}

export function createStraGraphRegistry(input = {}) {
  const validated = validateStraGraphInput(input);
  const state = {
    nodes: validated.nodes,
    edges: validated.edges,
    localCircuits: validated.localCircuits,
    runtimeObservations: [],
  };
  const nodeIndex = validated.nodeIndex;
  const circuitIndex = validated.circuitIndex;

  function getNode(id) {
    assertIdentifier(id, "STRA node id");
    return nodeIndex.has(id) ? clone(nodeIndex.get(id)) : undefined;
  }

  function traceLocalCircuit(circuitId) {
    const circuit = circuitIndex.get(circuitId);
    if (!circuit) throw new Error(`STRA circuit is not registered: ${circuitId}`);
    const nodeIds = [...circuit.nodeIds];
    const nodes = nodeIds.map((id) => {
      const node = nodeIndex.get(id);
      const stateValue = node.state ?? "CONNECTED";
      return { id, stage: node.stage, state: stateValue, owner: node.owner };
    });
    const edges = state.edges
      .filter((edge) => nodeIds.includes(edge.from) && nodeIds.includes(edge.to))
      .map(clone);
    const incomplete = nodes.some((node) => ["BROKEN", "MISSING", "BLOCKED"].includes(node.state));
    return freezeResult({
      circuitId,
      entryNode: circuit.entryNode ?? nodeIds[0],
      nodes,
      edges,
      status: incomplete ? "INCOMPLETE" : "COMPLETE",
    });
  }

  function findImpacted(changedIds = []) {
    const impacted = new Set(changedIds.map((id) => assertIdentifier(id, "Changed STRA node id")));
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of state.edges) {
        if (impacted.has(edge.to) && !impacted.has(edge.from)) {
          impacted.add(edge.from);
          changed = true;
        }
      }
    }
    return [...impacted].map((id) => getNode(id)).filter(Boolean);
  }

  function dependencyCycles() {
    const adjacency = new Map(state.nodes.map((node) => [node.id, []]));
    for (const edge of state.edges) {
      if (["depends-on", "uses", "persists-to", "publishes", "consumes", "starts"].includes(edge.type)) {
        adjacency.get(edge.from).push(edge.to);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const cycles = [];
    function visit(id, path = []) {
      if (visiting.has(id)) {
        const start = path.indexOf(id);
        cycles.push(path.slice(start).concat(id));
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of adjacency.get(id) ?? []) visit(dependency, [...path, id]);
      visiting.delete(id);
      visited.add(id);
    }
    for (const node of state.nodes) visit(node.id);
    return cycles;
  }

  function compareRuntimePath(circuitId, actualPath = []) {
    const expected = traceLocalCircuit(circuitId).nodes.map((node) => node.id);
    const actual = [...actualPath];
    return freezeResult({
      circuitId,
      expected,
      actual,
      missing: expected.filter((id) => !actual.includes(id)),
      unexpected: actual.filter((id) => !expected.includes(id)),
      matches: expected.length === actual.length && expected.every((id, index) => id === actual[index]),
    });
  }

  function recordRuntimeObservation(observation = {}) {
    if (typeof observation.circuitId !== "string" || !circuitIndex.has(observation.circuitId)) {
      throw new Error("Runtime observation circuitId must reference a STRA circuit");
    }
    if (!Array.isArray(observation.path) || observation.path.length === 0) {
      throw new Error("Runtime observation path is required");
    }
    const record = {
      id: observation.id ?? crypto.randomUUID(),
      traceId: String(observation.traceId ?? crypto.randomUUID()),
      circuitId: observation.circuitId,
      path: [...observation.path],
      failed: observation.failed === true,
      latencyMs: Number.isFinite(observation.latencyMs) ? observation.latencyMs : undefined,
      occurredAt: observation.occurredAt ?? new Date().toISOString(),
    };
    state.runtimeObservations.push(record);
    return freezeResult(clone(record));
  }

  function snapshot() {
    const data = {
      schemaVersion: 1,
      stages: STRA_STAGES,
      nodes: state.nodes,
      edges: state.edges,
      localCircuits: state.localCircuits,
    };
    return freezeResult({ ...clone(data), snapshotHash: digest(data) });
  }

  return freezeResult({
    getNode,
    listNodes: () => state.nodes.map(clone),
    listEdges: () => state.edges.map(clone),
    listCircuits: () => state.localCircuits.map(clone),
    traceLocalCircuit,
    findImpacted,
    dependencyCycles,
    compareRuntimePath,
    recordRuntimeObservation,
    runtimeObservations: () => clone(state.runtimeObservations),
    snapshot,
  });
}

export function createStraHealthScorecard(registry) {
  const circuits = registry.listCircuits().map((circuit) => registry.traceLocalCircuit(circuit.id));
  const observations = registry.runtimeObservations();
  const cycles = registry.dependencyCycles();
  const complete = circuits.filter((circuit) => circuit.status === "COMPLETE").length;
  const runtimeFailures = observations.filter((observation) => observation.failed).length;
  return freezeResult({
    generatedAt: new Date().toISOString(),
    status: complete === circuits.length && runtimeFailures === 0 && cycles.length === 0 ? "healthy" : "attention_required",
    circuitScore: circuits.length ? Math.round((complete / circuits.length) * 100) : 100,
    runtimeScore: observations.length ? Math.round(((observations.length - runtimeFailures) / observations.length) * 100) : 100,
    dependencyCycles: cycles.length,
    circuits: circuits.map(({ circuitId, status, nodes, edges }) => ({ circuitId, status, nodeCount: nodes.length, edgeCount: edges.length })),
  });
}