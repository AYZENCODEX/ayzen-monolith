import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", admin consumer.
 *
 * `@ayzen/admin-policy`'s authorizeAdminAction (scope + break-glass
 * checks) is untouched. The "admin" app policy pack in
 * @ayzen/authorization declares roles owner/operator/auditor and
 * sensitiveRequiresStepUp; this client exposes that pack, plus capability
 * decisions, through the unified contract for admin surfaces.
 */
export function createAdminPolicyClient({ audit } = {}) {
  return createConsumerClient("admin", { app: "admin", audit });
}

export function decideAdminRole({ role, action, requiredRole, subject = "admin-operator" } = {}) {
  return createAdminPolicyClient().decide({ subject, role, action, requiredRole });
}
