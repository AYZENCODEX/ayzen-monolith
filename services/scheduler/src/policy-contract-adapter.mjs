import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", scheduler consumer.
 *
 * Scheduled jobs run without a live user, so the acting identity is the
 * job's owning service (actorType "service"). This client lets the
 * scheduler ask the contract whether that service may fire a job's
 * capability before it enqueues it. Not yet injected into the trigger path
 * in index.mjs (see CHANGES doc, known limitations).
 */
export function createSchedulerPolicyClient({ app, audit } = {}) {
  return createConsumerClient("scheduler", { app, audit });
}

export function decideScheduledJob({ app, capability, subject, scopes = [], roles = [], stepUpAt } = {}) {
  return createSchedulerPolicyClient({ app }).decide({ capability, subject, actorType: "service", scopes, roles, stepUpAt });
}
