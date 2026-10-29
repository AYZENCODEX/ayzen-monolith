import { assertNonEmpty, sha256 } from "@ayzen/enforcement-core";

export function createReleaseGovernance({ validator = () => [], audit = () => {} } = {}) {
  function certify(input) {
    const required = ["releaseId", "commit", "imageDigest", "rolloutCohort", "monitoringWindow", "rollbackOwner"];
    for (const field of required) assertNonEmpty(input[field], `release.${field}`);
    if (input.immutableArtifact === false) throw new Error("Immutable artifact is required");
    const failures = validator(input) ?? [];
    if (failures.length) return Object.freeze({ status: "blocked", releaseId: input.releaseId, failures });
    const record = Object.freeze({ ...input, status: "approved", evidenceDigest: sha256(input), approvedAt: new Date().toISOString() });
    audit({ action: "release.approved", releaseId: record.releaseId, evidenceDigest: record.evidenceDigest });
    return record;
  }
  return Object.freeze({ certify, canPromote: (record) => record?.status === "approved" });
}