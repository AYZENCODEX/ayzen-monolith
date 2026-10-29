export function createCostGovernance({ budgets = {}, sharedKinds = [], audit = () => {} } = {}) {
  const usage = new Map();
  function observe(component, amount, metadata = {}) {
    const budget = budgets[component] ?? budgets.default ?? Infinity;
    const current = (usage.get(component) ?? 0) + amount;
    usage.set(component, current);
    const breached = current > budget;
    if (breached) audit({ action: "cost.budget.breached", component, current, budget });
    return { component, current, budget, breached, metadata };
  }
  function duplicateEngine(component) {
    return sharedKinds.includes(component.kind) && component.physicalInstances > 1;
  }
  return Object.freeze({
    observe, usage: () => Object.fromEntries(usage),
    findDuplicateEngines: (components = []) => components.filter(duplicateEngine),
    budget: (component) => budgets[component] ?? budgets.default,
  });
}