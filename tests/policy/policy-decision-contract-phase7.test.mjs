import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyService } from "../../services/policy/src/index.mjs";
import { createPolicySimulator } from "../../services/policy-simulation/src/index.mjs";

// Phase 07 ("Unified Policy Decision Contract"), verification line:
// "Allow/deny/conditional regression suite." services/policy-simulation
// already existed as the roadmap's regression-suite runner; before this
// phase it could only ever be handed allow/deny expectations because
// nothing services/policy produced could answer "conditional". This test
// is that regression suite, run against the now-conditional-aware engine.

const policyService = createPolicyService({
  policies: {
    ryft: {
      "finance.read": true,
      "finance.write": "conditional",
      "finance.delete": () => false,
      "finance.approve": () => ({ decision: "conditional", conditions: [{ code: "SECOND_APPROVER_REQUIRED", description: "A second, distinct approver must also approve." }] }),
    },
  },
  consumer: "service",
});

const simulator = createPolicySimulator({
  policyService,
  cases: [
    { name: "allow: table literal true", input: { subject: "user-1", app: "ryft", action: "finance.read", resource: "finance" }, expected: "allow" },
    { name: "deny: unregistered action", input: { subject: "user-1", app: "ryft", action: "finance.unknown", resource: "finance" }, expected: "deny" },
    { name: "deny: function returns false", input: { subject: "user-1", app: "ryft", action: "finance.delete", resource: "finance" }, expected: "deny" },
    { name: "conditional: table literal \"conditional\"", input: { subject: "user-1", app: "ryft", action: "finance.write", resource: "finance" }, expected: "conditional" },
    { name: "conditional: function returns a structured condition", input: { subject: "user-1", app: "ryft", action: "finance.approve", resource: "finance" }, expected: "conditional" },
  ],
});

test("Phase 07 -- services/policy-simulation regression suite: allow/deny/conditional", () => {
  const results = simulator.regression();
  for (const result of results) {
    assert.equal(result.passed, true, `${result.name}: expected ${result.expected}, got ${result.result.decision.decision}`);
    assert.equal(result.result.deterministic, true, `${result.name}: decision was not deterministic across two identical calls`);
  }
  assert.equal(results.length, 5);
});

test("Phase 07 -- conditional decisions carry their conditions through to the simulator", () => {
  const decision = policyService.decide({ subject: "user-1", app: "ryft", action: "finance.approve", resource: "finance" });
  assert.equal(decision.decision, "conditional");
  assert.equal(decision.conditions[0].code, "SECOND_APPROVER_REQUIRED");
  assert.equal(decision.consumer, "service");
});
