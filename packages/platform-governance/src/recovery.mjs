export function createRecoveryController({ policies = [] } = {}) {
  const registry = new Map(policies.map((policy) => [policy.id, { ...policy, attempts: 0, lastOutcome: undefined }]));
  function plan(id) {
    const policy = registry.get(id);
    if (!policy) throw new Error(`Unknown recovery policy: ${id}`);
    return Object.freeze({ id, retry: policy.retry, fallback: policy.fallback, reconcile: policy.reconcile, verify: policy.verify, operatorApproval: policy.operatorApproval === true });
  }
  function record(id, outcome) {
    const policy = registry.get(id);
    if (!policy) throw new Error(`Unknown recovery policy: ${id}`);
    const next = { ...policy, attempts: policy.attempts + 1, lastOutcome: outcome };
    registry.set(id, next);
    return plan(id);
  }
  return Object.freeze({
    list: () => [...registry.values()].map((item) => ({ ...item })),
    plan,
    record,
    status: () => [...registry.values()].every((policy) => policy.retry && policy.fallback && policy.reconcile && policy.verify) ? "READY" : "BLOCKED",
  });
}