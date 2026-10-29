export function createPolicySimulator({ policyService, cases = [] } = {}) {
  if (!policyService || typeof policyService.decide !== "function") throw new Error("Policy service is required");
  function run(input) {
    const first = policyService.decide(input);
    const second = policyService.decide(input);
    return { input, decision: first, deterministic: first.decision === second.decision && first.reason === second.reason };
  }
  function regression() {
    return cases.map((testCase) => ({ ...testCase, result: run(testCase.input), passed: run(testCase.input).decision.decision === testCase.expected }));
  }
  return Object.freeze({ run, regression });
}