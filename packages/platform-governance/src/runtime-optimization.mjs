export function createRuntimeOptimization({ slos = [] } = {}) {
  const samples = new Map();
  for (const slo of slos) samples.set(slo.id, { ...slo, observations: [] });
  function observe(id, value) {
    const slo = samples.get(id);
    if (!slo || !Number.isFinite(value)) throw new Error(`Unknown SLO: ${id}`);
    const observations = [...slo.observations, value].slice(-1000);
    samples.set(id, { ...slo, observations });
    return evaluate(id);
  }
  function evaluate(id) {
    const slo = samples.get(id);
    if (!slo) throw new Error(`Unknown SLO: ${id}`);
    const values = [...slo.observations].sort((a, b) => a - b);
    const p95 = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] : 0;
    return { id, p95, target: slo.target, status: p95 <= slo.target ? "PASS" : "FAIL", recommendation: p95 <= slo.target ? "none" : slo.action ?? "investigate-bottleneck" };
  }
  return Object.freeze({ observe, evaluate, list: () => [...samples.keys()].map(evaluate), status: () => [...samples.keys()].every((id) => evaluate(id).status === "PASS") ? "READY" : "BLOCKED" });
}