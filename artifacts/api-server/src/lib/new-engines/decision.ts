import crypto from "node:crypto";
import { canonicalize, iso } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { DecisionEvidence, DecisionResult } from "./advanced-types";

export class DecisionIntelligenceEngine {
  constructor(private readonly store: AdvancedEngineStore) {}
  decide(input: { context: Record<string, unknown>; evidence: DecisionEvidence[]; outcomes: string[]; authorizationRequired?: boolean; strategy?: "weighted-majority" | "highest-weight" }): DecisionResult {
    if (!input.outcomes.length) throw new Error("At least one outcome is required");
    const evidence = [...input.evidence].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const totals = new Map(input.outcomes.map((outcome) => [outcome, 0]));
    const conflicts: string[] = [];
    for (const item of evidence) {
      const value = typeof item.value === "string" ? item.value : undefined;
      if (value && totals.has(value)) totals.set(value, totals.get(value)! + item.weight);
      else conflicts.push(`Evidence ${item.id} does not map to a known outcome`);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const totalWeight = evidence.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    const outcome = input.strategy === "highest-weight" ? evidence.find((item) => typeof item.value === "string" && totals.has(item.value))?.value as string | undefined : ranked[0][0];
    const confidence = totalWeight > 0 ? Math.min(1, (totals.get(outcome!) ?? 0) / totalWeight) : 0;
    const contextHash = crypto.createHash("sha256").update(canonicalize({ context: input.context, evidence, outcomes: input.outcomes })).digest("hex");
    const result = { id: crypto.randomUUID(), outcome: outcome ?? "UNCERTAIN", confidence, evidence, conflicts, explanation: [`${evidence.length} evidence item(s) considered`, `Top outcome weight: ${totals.get(outcome!) ?? 0}`], contextHash, authorizationRequired: input.authorizationRequired ?? false, createdAt: iso() };
    this.store.decisions.set(result.id, result);
    return result;
  }
  get(id: string): DecisionResult | undefined { return this.store.decisions.get(id); }
}