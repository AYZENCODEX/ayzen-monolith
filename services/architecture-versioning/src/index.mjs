import { sha256 } from "@ayzen/enforcement-core";

export function createArchitectureHistory({ versions = [], audit = () => {} } = {}) {
  const records = [...versions];
  function publish(graph, { owner = "platform", approvedBy, sensitive = false, reason } = {}) {
    if (sensitive && !approvedBy) throw new Error("Sensitive architecture changes require approval");
    const prior = records.at(-1);
    const record = Object.freeze({
      version: (prior?.version ?? 0) + 1,
      digest: sha256(graph),
      graph,
      owner,
      approvedBy,
      sensitive,
      reason,
      publishedAt: new Date().toISOString(),
    });
    records.push(record);
    audit({ action: "architecture.version.published", version: record.version, digest: record.digest, sensitive });
    return record;
  }
  return Object.freeze({
    publish,
    current: () => records.at(-1),
    list: () => [...records],
    diff: (left, right) => ({ changed: left.digest !== right.digest, from: left.digest, to: right.digest }),
  });
}