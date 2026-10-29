import crypto from "node:crypto";
import { canonicalize } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { ChangeDefinition, ImpactResult } from "./advanced-types";
import type { DependencyGraphEngine } from "./dependency";

export class ImpactAnalysisEngine {
  constructor(private readonly graph: DependencyGraphEngine, private readonly store: AdvancedEngineStore) {}
  define(change: ChangeDefinition): ChangeDefinition { this.store.changes.set(change.id, change); return change; }
  analyze(change: ChangeDefinition): ImpactResult {
    const direct = [...new Set(change.nodeIds)];
    const transitive = [...new Set(direct.flatMap((node) => this.graph.dependencies(node, "downstream")).filter((node) => !direct.includes(node)))];
    const all = [...direct, ...transitive];
    const affectedTypes = Object.fromEntries([...new Set(all.map((id) => this.store.dependencyNodes.get(id)?.entityType ?? "unknown"))].map((type) => [type, all.filter((id) => (this.store.dependencyNodes.get(id)?.entityType ?? "unknown") === type).length]));
    const cycles = this.graph.cycles().filter((cycle) => cycle.some((node) => all.includes(node)));
    const riskScore = Math.min(100, direct.length * 10 + transitive.length * 4 + cycles.length * 25);
    const sourceReferences = all.flatMap((id) => this.store.dependencyNodes.get(id)?.sourceRefs ?? []);
    return { changeId: change.id, direct, transitive, affectedTypes, riskScore, sourceReferences: [...new Set(sourceReferences)] };
  }
  key(change: ChangeDefinition): string { return crypto.createHash("sha256").update(canonicalize(change)).digest("hex"); }
}