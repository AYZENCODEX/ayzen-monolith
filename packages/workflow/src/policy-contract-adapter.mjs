import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", workflow consumer.
 *
 * `security-policy.mjs` in this package answers "is this workflow
 * definition/config shape allowed"; this client answers the separate
 * question "is this subject allowed to run this workflow step" through
 * the same allow/deny/conditional contract every other consumer uses. A
 * "conditional" result lets the executor pause a step for step-up rather
 * than failing it outright. Not yet injected into executor.mjs's step loop
 * (see CHANGES doc, known limitations).
 */
export function createWorkflowPolicyClient({ app, audit } = {}) {
  return createConsumerClient("workflow", { app, audit });
}

export function decideWorkflowStep({ app, capability, subject, actorType = "service", scopes = [], roles = [], stepUpAt } = {}) {
  return createWorkflowPolicyClient({ app }).decide({ capability, subject, actorType, scopes, roles, stepUpAt });
}
