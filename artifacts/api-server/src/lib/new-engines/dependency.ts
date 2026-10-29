import crypto from "node:crypto";
import { canonicalize, iso } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { DependencyEdge, DependencyNode, DependencyPlan } from "./advanced-types";

export class DependencyGraphEngine {
  constructor(private readonly store: AdvancedEngineStore) {}
  upsertNode(node: DependencyNode): DependencyNode {
    this.store.dependencyNodes.set(node.id, { ...node, updatedAt: node.updatedAt ?? iso() });
    return this.store.dependencyNodes.get(node.id)!;
  }
  upsertEdge(edge: DependencyEdge): DependencyEdge {
    if (!this.store.dependencyNodes.has(edge.from) || !this.store.dependencyNodes.has(edge.to)) throw new Error("Dependency edge references an unknown node");
    if (edge.from === edge.to) throw new Error("Dependency cycles must involve distinct nodes");
    this.store.dependencyEdges.set(edge.id, { ...edge, updatedAt: edge.updatedAt ?? iso() });
    return this.store.dependencyEdges.get(edge.id)!;
  }
  dependencies(nodeId: string, direction: "upstream" | "downstream" = "upstream"): string[] {
    const result = new Set<string>(), queue = [nodeId];
    while (queue.length) {
      const current = queue.shift()!;
      for (const edge of this.store.dependencyEdges.values()) {
        const next = direction === "upstream" && edge.to === current ? edge.from : direction === "downstream" && edge.from === current ? edge.to : undefined;
        if (next && !result.has(next)) { result.add(next); queue.push(next); }
      }
    }
    return [...result];
  }
  cycles(): string[][] {
    const cycles: string[][] = [];
    const visit = (node: string, path: string[], active: Set<string>) => {
      if (active.has(node)) { cycles.push(path.slice(path.indexOf(node))); return; }
      if (path.includes(node)) return;
      active.add(node);
      for (const edge of this.store.dependencyEdges.values()) if (edge.from === node) visit(edge.to, [...path, node], active);
      active.delete(node);
    };
    for (const node of this.store.dependencyNodes.keys()) visit(node, [], new Set());
    return cycles;
  }
}

export class DependencyResolutionEngine {
  constructor(private readonly graph: DependencyGraphEngine, private readonly store: AdvancedEngineStore) {}
  plan(nodeIds: string[]): DependencyPlan {
    const requested = [...new Set(nodeIds)];
    const all = new Set(requested);
    for (const node of requested) for (const dependency of this.graph.dependencies(node)) all.add(dependency);
    const conflicts: string[] = [];
    const cycles = this.graph.cycles().filter((cycle) => cycle.some((node) => all.has(node)));
    const indegree = new Map([...all].map((node) => [node, 0]));
    for (const edge of this.store.dependencyEdges.values()) if (all.has(edge.from) && all.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to)! + 1);
    const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([node]) => node).sort();
    const orderedNodes: string[] = [];
    while (queue.length) {
      const node = queue.shift()!;
      orderedNodes.push(node);
      for (const edge of this.store.dependencyEdges.values()) if (edge.from === node && indegree.has(edge.to)) {
        indegree.set(edge.to, indegree.get(edge.to)! - 1);
        if (indegree.get(edge.to) === 0) queue.push(edge.to);
      }
      queue.sort();
    }
    if (orderedNodes.length !== all.size) conflicts.push("Dependency cycle prevents a complete execution plan");
    const reproducibilityKey = crypto.createHash("sha256").update(canonicalize({ nodeIds: requested.sort(), orderedNodes, cycles })).digest("hex");
    const result = { id: crypto.randomUUID(), nodes: [...all], orderedNodes, conflicts, cycles, reproducibilityKey };
    return result;
  }
}