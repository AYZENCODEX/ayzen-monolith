import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", API consumer.
 *
 * Gives API handlers/gateways the same `{ decide, explain }` client the
 * other six consumers use. Route-level checks (method + pathname) go
 * through the coarse route gate service-runtime already uses; capability
 * checks go through the capability engine.
 */
export function createApiPolicyClient({ app, audit } = {}) {
  return createConsumerClient("api", { app, audit });
}

export function decideApiRoute({ app, method, pathname, auth, internalService } = {}) {
  return createApiPolicyClient({ app }).decide({ method, pathname, auth, internalService });
}
