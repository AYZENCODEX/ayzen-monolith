import crypto from "node:crypto";
import { canonicalize } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { OptimizationCandidate, OptimizationObjective, OptimizationResult } from "./advanced-types";

export class OptimizationEngine {
  constructor(private readonly store: AdvancedEngineStore) {}
  optimize(input: { candidates: OptimizationCandidate[]; objectives: OptimizationObjective[]; constraints?: Array<(candidate: OptimizationCandidate) => boolean>; version?: string }): OptimizationResult {
    const constraints = input.constraints ?? [];
    const candidates = input.candidates.map((candidate) => ({ ...candidate, violations: [...candidate.violations, ...constraints.flatMap((constraint, index) => constraint(candidate) ? [] : [`constraint_${index}`])] }));
    const viable = candidates.filter((candidate) => candidate.violations.length === 0);
    const score = (candidate: OptimizationCandidate) => input.objectives.reduce((total, objective) => {
      const value = candidate.metrics[objective.name] ?? 0;
      return total + (objective.direction === "minimize" ? -value : value) * objective.weight;
    }, 0);
    const selected = [...viable].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
    const reproducibilityKey = crypto.createHash("sha256").update(canonicalize({ candidates, objectives: input.objectives, version: input.version ?? "1" })).digest("hex");
    const result = { candidates, selected, reproducibilityKey, explanation: selected ? [`Selected ${selected.id} using weighted objective scoring`] : ["No candidate satisfies all constraints"] };
    this.store.optimizationResults.set(reproducibilityKey, result);
    return result;
  }
}