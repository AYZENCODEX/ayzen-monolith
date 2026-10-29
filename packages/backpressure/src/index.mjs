export const PRESSURE_STATES = Object.freeze(["normal", "elevated", "throttled", "shed"]);

export function createBackpressureController({ limits = {}, now = () => Date.now(), audit = () => {} } = {}) {
  const counters = new Map();
  const stateFor = (key) => {
    const limit = limits[key] ?? limits.default ?? { elevatedAt: 0.7, throttledAt: 0.9, shedAt: 1 };
    const current = counters.get(key) ?? 0;
    const ratio = limit.capacity ? current / limit.capacity : current;
    const state = ratio >= (limit.shedAt ?? 1) ? "shed" : ratio >= (limit.throttledAt ?? 0.9) ? "throttled" : ratio >= (limit.elevatedAt ?? 0.7) ? "elevated" : "normal";
    return { key, current, ratio, state };
  };
  return Object.freeze({
    admit(key, amount = 1) {
      const limit = limits[key] ?? limits.default ?? { capacity: Infinity };
      const current = (counters.get(key) ?? 0) + amount;
      counters.set(key, current);
      const result = stateFor(key);
      const allowed = result.state !== "shed" && current <= (limit.capacity ?? Infinity);
      audit({ action: allowed ? "pressure.admitted" : "pressure.rejected", ...result });
      return { ...result, allowed };
    },
    release(key, amount = 1) {
      counters.set(key, Math.max(0, (counters.get(key) ?? 0) - amount));
      return stateFor(key);
    },
    state: stateFor,
    snapshot: () => Object.fromEntries([...counters.keys()].map((key) => [key, stateFor(key)])),
  });
}