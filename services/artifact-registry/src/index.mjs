import { assertNonEmpty, sha256 } from "@ayzen/enforcement-core";

export function createArtifactRegistry({ artifacts = [], audit = () => {} } = {}) {
  const entries = new Map();
  for (const artifact of artifacts) register(artifact);
  function register(input) {
    const record = Object.freeze({
      id: assertNonEmpty(input.id, "artifact id"),
      source: assertNonEmpty(input.source, "artifact source"),
      commit: assertNonEmpty(input.commit, "artifact commit"),
      buildId: assertNonEmpty(input.buildId, "artifact buildId"),
      digest: assertNonEmpty(input.digest ?? sha256(input), "artifact digest"),
      sbomDigest: input.sbomDigest,
      deploymentId: input.deploymentId,
      immutable: input.immutable !== false,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
    if (entries.has(record.id)) throw new Error(`Artifact already registered: ${record.id}`);
    entries.set(record.id, record);
    return record;
  }
  return Object.freeze({
    register, get: (id) => entries.get(id), list: () => [...entries.values()],
    verify: (id, digest) => entries.get(id)?.digest === digest,
    reverseTrace: (deploymentId) => [...entries.values()].filter((item) => item.deploymentId === deploymentId || item.id === deploymentId),
    audit: (event) => audit(event),
  });
}