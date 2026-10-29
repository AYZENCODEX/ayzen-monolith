import crypto from "node:crypto";
import { iso } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { JsonObject, EngineActor } from "./types";
import type { RemediationAction, RemediationExecution, RemediationPolicy } from "./advanced-types";

export class RemediationEngine {
  constructor(private readonly store: AdvancedEngineStore) {}
  registerAction(action: RemediationAction): RemediationAction {
    this.store.remediationActions.set(action.id, action);
    return action;
  }
  registerPolicy(policy: RemediationPolicy): RemediationPolicy {
    if (!this.store.remediationActions.has(policy.actionId)) throw new Error("Remediation action not found");
    this.store.remediationPolicies.set(policy.id, policy);
    return policy;
  }
  async execute(policyId: string, context: JsonObject, options: { dryRun?: boolean; approved?: boolean; actor?: EngineActor; idempotencyKey?: string } = {}): Promise<RemediationExecution> {
    const policy = this.store.remediationPolicies.get(policyId);
    if (!policy || !policy.approved) throw new Error("Remediation policy is not approved");
    const action = this.store.remediationActions.get(policy.actionId)!;
    const prior = [...this.store.remediationExecutions.values()].find((execution) => execution.policyId === policyId && options.idempotencyKey && execution.context.idempotencyKey === options.idempotencyKey);
    if (prior) return prior;
    const now = Date.now();
    const recent = [...this.store.remediationExecutions.values()].filter((execution) => execution.policyId === policyId && now - new Date(execution.createdAt).getTime() <= policy.windowMs && execution.status === "COMPLETED").length;
    if (recent >= policy.maxExecutions) throw new Error("Remediation execution limit exceeded");
    const base = { id: crypto.randomUUID(), actionId: action.id, policyId, actor: options.actor, context, createdAt: iso() };
    if (options.dryRun) {
      const execution = { ...base, status: "DRY_RUN" as const };
      this.store.remediationExecutions.set(execution.id, execution);
      return execution;
    }
    if (policy.requiresApproval && !options.approved) {
      const execution = { ...base, status: "PENDING_APPROVAL" as const };
      this.store.remediationExecutions.set(execution.id, execution);
      return execution;
    }
    try {
      const result = await action.execute(context);
      const execution = { ...base, status: "COMPLETED" as const, result };
      this.store.remediationExecutions.set(execution.id, execution);
      return execution;
    } catch (error) {
      const execution = { ...base, status: "FAILED" as const, error: error instanceof Error ? error.message : String(error) };
      this.store.remediationExecutions.set(execution.id, execution);
      return execution;
    }
  }
  history(): RemediationExecution[] { return [...this.store.remediationExecutions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
}