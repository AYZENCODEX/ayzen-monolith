import { sha256 } from "@ayzen/enforcement-core";

export function createCertificationRegistry({ requiredPhases = Array.from({ length: 34 }, (_, i) => i + 7), now = () => new Date().toISOString() } = {}) {
  const records = new Map();
  function record(phase, status, evidence = {}) {
    if (!requiredPhases.includes(phase)) throw new Error(`Phase is outside certification scope: ${phase}`);
    const item = Object.freeze({ phase, status, evidence, recordedAt: now(), digest: sha256({ phase, status, evidence }) });
    records.set(phase, item);
    return item;
  }
  function certify({ releaseOwner, approvedAt = now() } = {}) {
    if (!releaseOwner) throw new Error("Release owner sign-off is required");
    const missing = requiredPhases.filter((phase) => records.get(phase)?.status !== "passed");
    const status = missing.length ? "blocked" : "certified";
    return Object.freeze({ status, releaseOwner, approvedAt, missing, phases: [...records.values()], digest: sha256({ status, releaseOwner, missing, phases: [...records.values()] }) });
  }
  return Object.freeze({ record, certify, get: (phase) => records.get(phase), list: () => [...records.values()] });
}