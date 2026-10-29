const CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);

export function createDataGovernanceCatalog({ entries = [] } = {}) {
  const catalog = new Map();
  for (const entry of entries) {
    if (!entry.id || !entry.owner || !CLASSIFICATIONS.has(entry.classification)) throw new Error(`Invalid data governance entry: ${entry.id ?? "unknown"}`);
    if (!Array.isArray(entry.allowedConsumers) || !entry.allowedConsumers.length) throw new Error(`${entry.id}: allowedConsumers is required`);
    catalog.set(entry.id, Object.freeze({ ...entry }));
  }
  function checkFlow({ dataId, consumer, operation = "read" } = {}) {
    const entry = catalog.get(dataId);
    if (!entry) return { allowed: false, code: "DATA_UNCLASSIFIED", dataId, consumer, operation };
    const allowed = entry.allowedConsumers.includes(consumer);
    return { allowed, code: allowed ? "DATA_FLOW_ALLOWED" : "DATA_CONSUMER_NOT_ALLOWED", dataId, consumer, operation, owner: entry.owner };
  }
  return Object.freeze({
    list: () => [...catalog.values()],
    get: (id) => catalog.get(id),
    checkFlow,
    status: () => [...catalog.values()].every((entry) => entry.audit && entry.retention && entry.encryption && entry.export && entry.delete) ? "READY" : "BLOCKED",
  });
}