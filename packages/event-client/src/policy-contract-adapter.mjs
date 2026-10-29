import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", event consumer.
 *
 * This is deliberately separate from `security-policy.mjs`'s
 * `loadEventBusSecurityPolicy` and `payload-policy.mjs`'s restricted-key
 * matcher (Roadmap section 3, non-duplication rule): those answer "is this
 * payload/producer/consumer identity shape allowed on the bus at all",
 * which is config-driven and has nothing to do with who a specific
 * subject is. This client answers the orthogonal question -- "is this
 * subject allowed to publish/consume this specific event" -- through the
 * same allow/deny/conditional contract every other consumer uses,
 * app-scoped by the event's owning domain.
 */
export function createEventPolicyClient({ app, audit } = {}) {
  return createConsumerClient("event", { app, audit });
}

/**
 * `capability` should be the event's owning domain's capability for this
 * operation (e.g. "finance.post-transaction" for a
 * finance.transaction.created publish) -- the same capability vocabulary
 * @ayzen/capabilities already uses, kept as one vocabulary rather than
 * inventing an event-specific one.
 */
export function decideEventAction({ app, capability, subject, actorType = "service", scopes = [], roles = [], stepUpAt } = {}) {
  return createEventPolicyClient({ app }).decide({ capability, subject, actorType, scopes, roles, stepUpAt });
}
