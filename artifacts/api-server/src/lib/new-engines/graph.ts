import crypto from "node:crypto";
import { edgeKey, iso, type InMemoryNewEngineStore } from "./store";
import type { GraphEdge, GraphNode, GraphTraversalResult } from "./types";

export class KnowledgeGraphEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  upsertNode(input: Omit<GraphNode, "updatedAt"> & { updatedAt?: string }): GraphNode {
    const current = this.store.graphNodes.get(input.id);
    if (current && input.version < current.version) return current;
    const node = { ...input, sourceRefs: [...new Set(input.sourceRefs)], updatedAt: input.updatedAt ?? iso() };
    this.store.graphNodes.set(node.id, node);
    return node;
  }

  upsertEdge(input: Omit<GraphEdge, "id" | "updatedAt"> & { id?: string; updatedAt?: string }): GraphEdge {
    if (input.from === input.to) throw new Error("Self-referential graph edges are not allowed");
    const key = edgeKey(input);
    const existing = [...this.store.graphEdges.values()].find((edge) => edgeKey(edge) === key);
    if (existing && input.version < existing.version) return existing;
    const edge = { ...input, id: existing?.id ?? input.id ?? crypto.randomUUID(), sourceRefs: [...new Set(input.sourceRefs)], updatedAt: input.updatedAt ?? iso() };
    this.store.graphEdges.set(edge.id, edge);
    return edge;
  }

  traverse(startId: string, options: { direction?: "outgoing" | "incoming" | "both"; maxDepth?: number; maxNodes?: number; canRead?: (node: GraphNode) => boolean } = {}): GraphTraversalResult {
    const direction = options.direction ?? "outgoing";
    const maxDepth = Math.min(50, Math.max(0, options.maxDepth ?? 3));
    const maxNodes = Math.min(1000, Math.max(1, options.maxNodes ?? 100));
    const seen = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    const edges = new Map<string, GraphEdge>();
    while (queue.length && seen.size < maxNodes) {
      const current = queue.shift()!;
      if (seen.has(current.id) || current.depth > maxDepth) continue;
      const node = this.store.graphNodes.get(current.id);
      if (!node || (options.canRead && !options.canRead(node))) continue;
      seen.add(current.id);
      if (current.depth === maxDepth) continue;
      for (const edge of this.store.graphEdges.values()) {
        const follows = direction === "outgoing" ? edge.from === current.id
          : direction === "incoming" ? edge.to === current.id
          : edge.from === current.id || edge.to === current.id;
        if (!follows) continue;
        const next = edge.from === current.id ? edge.to : edge.from;
        const nextNode = this.store.graphNodes.get(next);
        if (!nextNode || (options.canRead && !options.canRead(nextNode))) continue;
        edges.set(edge.id, edge);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    return { nodes: [...seen].map((id) => this.store.graphNodes.get(id)!), edges: [...edges.values()], truncated: queue.length > 0 };
  }

  findNodes(entityType?: string): GraphNode[] {
    return [...this.store.graphNodes.values()].filter((node) => !entityType || node.entityType === entityType);
  }
}