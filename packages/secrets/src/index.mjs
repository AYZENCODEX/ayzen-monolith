import { assertNonEmpty, redactSecrets, sha256 } from "@ayzen/enforcement-core";

export function createSecretRegistry({ entries = [], audit = () => {}, now = () => new Date().toISOString() } = {}) {
  const records = new Map();
  for (const entry of entries) register(entry);
  function register(entry) {
    const record = Object.freeze({
      id: assertNonEmpty(entry.id, "secret id"),
      owner: assertNonEmpty(entry.owner, "secret owner"),
      scope: assertNonEmpty(entry.scope ?? "runtime", "secret scope"),
      version: Number.isSafeInteger(entry.version) && entry.version > 0 ? entry.version : 1,
      status: entry.status ?? "active",
      rotatedAt: entry.rotatedAt ?? now(),
      expiresAt: entry.expiresAt,
    });
    if (records.has(record.id)) throw new Error(`Secret already registered: ${record.id}`);
    records.set(record.id, record);
    return record;
  }
  function rotate(id, { version, actor = "secrets-control", expiresAt } = {}) {
    const prior = records.get(id);
    if (!prior) throw new Error(`Unknown secret: ${id}`);
    if (!Number.isSafeInteger(version) || version <= prior.version) throw new Error("Secret version must advance");
    const record = Object.freeze({ ...prior, version, expiresAt, rotatedAt: now(), status: "active" });
    records.set(id, record);
    audit({ action: "secret.rotated", id, version, actor });
    return record;
  }
  function revoke(id, { actor = "secrets-control", reason } = {}) {
    const prior = records.get(id);
    if (!prior) throw new Error(`Unknown secret: ${id}`);
    const record = Object.freeze({ ...prior, status: "revoked", revokedAt: now(), revocationReason: assertNonEmpty(reason ?? "operator revocation", "revocation reason") });
    records.set(id, record);
    audit({ action: "secret.revoked", id, actor, reason: record.revocationReason });
    return record;
  }
  return Object.freeze({
    register, rotate, revoke, get: (id) => records.get(id), list: () => [...records.values()],
    fingerprint: (value) => sha256(redactSecrets(value)),
    drift: (observed = {}) => [...records.values()].filter((record) => observed[record.id]?.version !== record.version).map((record) => ({ id: record.id, expectedVersion: record.version, observedVersion: observed[record.id]?.version })),
  });
}