export function createResourceOrchestrator({ budgets = [] } = {}) {
  const state = new Map(budgets.map((budget) => [budget.id, { ...budget, usage: budget.usage ?? 0 }]));
  function observe(id, usage) {
    const budget = state.get(id);
    if (!budget || !Number.isFinite(usage)) throw new Error(`Unknown resource budget: ${id}`);
    const next = { ...budget, usage };
    state.set(id, next);
    return Object.freeze({ ...next, pressure: usage > budget.limit ? "critical" : usage >= budget.limit * 0.8 ? "warning" : "normal" });
  }
  function pressure() {
    return [...state.values()].map((budget) => ({ ...budget, pressure: budget.usage > budget.limit ? "critical" : budget.usage >= budget.limit * 0.8 ? "warning" : "normal" }));
  }
  return Object.freeze({
    list: pressure,
    observe,
    status: () => pressure().some((item) => item.pressure === "critical") ? "BLOCKED" : "READY",
    enforce(id) {
      const item = pressure().find((entry) => entry.id === id);
      if (!item) throw new Error(`Unknown resource budget: ${id}`);
      return { action: item.pressure === "critical" ? "THROTTLE" : "ALLOW", ...item };
    },
  });
}