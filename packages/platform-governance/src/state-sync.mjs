export function createStateSyncRegistry({ sources = [] } = {}) {
  const registry = new Map();
  for (const source of sources) {
    if (!source.id || !source.sourceOfTruth || !Number.isSafeInteger(source.version)) throw new Error("State source requires id, sourceOfTruth, and integer version");
    registry.set(source.id, { ...source, checkpoint: source.checkpoint ?? source.version });
  }
  function report(id, { version, checksum, checkpoint } = {}) {
    const prior = registry.get(id);
    if (!prior || !Number.isSafeInteger(version)) throw new Error(`Unknown or invalid state source: ${id}`);
    const next = { ...prior, version, checksum: checksum ?? prior.checksum, checkpoint: checkpoint ?? prior.checkpoint };
    registry.set(id, next);
    return Object.freeze({ ...next });
  }
  function divergences() {
    return [...registry.values()]
      .filter((source) => source.checkpoint !== source.version)
      .map((source) => ({ id: source.id, sourceOfTruth: source.sourceOfTruth, version: source.version, checkpoint: source.checkpoint, code: "STATE_DIVERGENCE" }));
  }
  return Object.freeze({
    list: () => [...registry.values()].map((item) => Object.freeze({ ...item })),
    report,
    divergences,
    status: () => divergences().length ? "NOT_HEALTHY" : "HEALTHY",
    reconcile(id, { version, checksum } = {}) {
      const prior = registry.get(id);
      if (!prior) throw new Error(`Unknown state source: ${id}`);
      return report(id, { version, checksum, checkpoint: version });
    },
  });
}