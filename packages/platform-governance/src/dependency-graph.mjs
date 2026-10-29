import { assertIdentifier, validateLifecycleTransition } from "./index.mjs";

function requiredMetadata(node) {
  for (const key of ["type", "owner", "app", "version", "policy", "lifecycle"]) {
    if (typeof node[key] !== "string" || !node[key].trim()) throw new Error(`Graph node ${node.id} is missing ${key}`);
  }
  return node;
}

export function createPlatformGraph({ nodes = [], edges = [] } = {}) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  for (const raw of nodes) {
    const id = assertIdentifier(raw.id, "Graph node id");
    if (nodeMap.has(id)) throw new Error(`Duplicate graph node: ${id}`);
    nodeMap.set(id, Object.freeze(requiredMetadata({ ...raw, id })));
  }
  for (const raw of edges) {
    const id = assertIdentifier(raw.id ?? `${raw.from}->${raw.to}`, "Graph edge id");
    if (edgeMap.has(id)) throw new Error(`Duplicate graph edge: ${id}`);
    edgeMap.set(id, Object.freeze({ ...raw, id, from: assertIdentifier(raw.from, "Graph edge source"), to: assertIdentifier(raw.to, "Graph edge target") }));
  }
  const adjacency = () => {
    const map = new Map([...nodeMap.keys()].map((id) => [id, []]));
    for (const edge of edgeMap.values()) if (map.has(edge.from)) map.get(edge.from).push(edge.to);
    return map;
  };
  function cycles() {
    const result = [];
    const visiting = new Set();
    const visited = new Set();
    const path = [];
    function visit(id) {
      if (visiting.has(id)) {
        result.push([...path.slice(path.indexOf(id)), id]);
        return;
      }
      if (visited.has(id)) return;
      visiting.add(id);
      path.push(id);
      for (const next of adjacency().get(id) ?? []) visit(next);
      path.pop();
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of nodeMap.keys()) visit(id);
    return result;
  }
  function findings() {
    const connected = new Set();
    const result = [];
    for (const edge of edgeMap.values()) {
      connected.add(edge.from);
      connected.add(edge.to);
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) result.push({ code: "UNRESOLVED_EDGE", severity: "critical", edge });
      for (const key of ["contract", "policy", "recovery"]) if (!edge[key]) result.push({ code: `MISSING_${key.toUpperCase()}`, severity: "critical", edge });
    }
    for (const id of nodeMap.keys()) if (!connected.has(id)) result.push({ code: "ORPHAN_NODE", severity: "critical", node: id });
    for (const cycle of cycles()) result.push({ code: "DEPENDENCY_CYCLE", severity: "critical", cycle });
    return result;
  }
  return Object.freeze({
    nodes: () => [...nodeMap.values()],
    edges: () => [...edgeMap.values()],
    resolve: (id) => nodeMap.get(id),
    cycles,
    findings,
    status: () => findings().some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY",
    transition(id, lifecycle) {
      const node = nodeMap.get(id);
      if (!node) throw new Error(`Unknown graph node: ${id}`);
      validateLifecycleTransition(node.lifecycle, lifecycle);
      const next = Object.freeze({ ...node, lifecycle });
      nodeMap.set(id, next);
      return next;
    },
  });
}