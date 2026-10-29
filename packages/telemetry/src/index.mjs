export function createMetrics() {
  const values = new Map();
  const key = (name, labels = {}) => `${name}|${JSON.stringify(Object.keys(labels).sort().map((label) => [label, labels[label]]))}`;
  return {
    increment(name, labels = {}, amount = 1) {
      const metricKey = key(name, labels);
      values.set(metricKey, (values.get(metricKey) ?? 0) + amount);
    },
    snapshot() {
      return [...values.entries()].map(([metricKey, value]) => ({ metricKey, value }));
    },
    prometheus() {
      return [...values.entries()].map(([metricKey, value]) => {
        const [name] = metricKey.split("|");
        return `${name} ${value}`;
      }).join("\n") + (values.size ? "\n" : "");
    },
  };
}

export function createHealthRegistry() {
  const checks = new Map();
  return {
    register(name, check) {
      if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name) || typeof check !== "function") throw new Error("Invalid health check");
      checks.set(name, check);
    },
    async run() {
      const results = {};
      for (const [name, check] of checks) {
        try {
          results[name] = (await check()) === true;
        } catch {
          results[name] = false;
        }
      }
      return results;
    },
  };
}

export function createHistogram({ buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 5000] } = {}) {
  const counts = new Map(buckets.map((bucket) => [bucket, 0]));
  let sum = 0;
  let count = 0;
  return {
    observe(value) {
      if (!Number.isFinite(value) || value < 0) return;
      sum += value;
      count += 1;
      for (const bucket of buckets) if (value <= bucket) counts.set(bucket, counts.get(bucket) + 1);
    },
    snapshot() { return { sum, count, buckets: Object.fromEntries(counts) }; },
  };
}

export function createTtlCache({ ttlMs = 30_000, maxEntries = 1_000 } = {}) {
  const values = new Map();
  function prune() {
    const now = Date.now();
    for (const [key, entry] of values) if (entry.expiresAt <= now) values.delete(key);
    while (values.size > maxEntries) values.delete(values.keys().next().value);
  }
  return {
    get(key) { prune(); return values.get(key)?.value; },
    set(key, value, customTtlMs = ttlMs) { prune(); values.set(key, { value, expiresAt: Date.now() + customTtlMs }); return value; },
    delete(key) { return values.delete(key); },
    clear() { values.clear(); },
    size() { prune(); return values.size; },
  };
}

export function paginate(items, { page = 1, pageSize = 50, maxPageSize = 1000 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Page must be a positive integer");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) throw new Error("Page size is invalid");
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length, hasNext: start + pageSize < items.length };
}