import { createPolicyDecisionPoint, validatePolicyContext } from "@ayzen/platform-governance";

/**
 * Phase 07 -- "Unified Policy Decision Contract".
 *
 * Through Phase 06 this could only ever answer allow/deny, because
 * @ayzen/platform-governance's PDP could only ever answer allow/deny.
 * That PDP now additionally understands a "conditional" policy outcome
 * (see its own header comment) -- this file's only change is to pass that
 * outcome through untouched and to tag every decision with `consumer`
 * (defaults to "service": packages/service-runtime, this file's one real
 * caller today, is itself the "service" consumer kind from the Phase 07
 * roadmap line "Create one decision interface consumed by API, service,
 * event, workflow, scheduler, Telegram and Admin"). The decision engine
 * itself is not reimplemented here (Roadmap section 3, non-duplication
 * rule) -- createPolicyDecisionPoint remains the one place a {app ->
 * {action -> policy}} table is evaluated.
 */
export function createPolicyService({ policies = {}, audit = () => {}, consumer = "service" } = {}) {
  const pdp = createPolicyDecisionPoint({ policies, audit: (decision) => audit({ ...decision, consumer }) });
  return Object.freeze({
    decide(input) {
      const context = validatePolicyContext({ ...input, decision: "deny" });
      const decision = pdp.decide(context);
      return Object.freeze({ ...decision, consumer });
    },
    decisions: pdp.decisions,
  });
}
