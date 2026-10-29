import crypto from "node:crypto";

export function createLeaseStore({ now = () => Date.now() } = {}) {
  const leases = new Map();
  function acquire(key, { owner = crypto.randomUUID(), ttlMs = 30_000 } = {}) {
    if (typeof key !== "string" || !key) throw new Error("Lease key is required");
    const existing = leases.get(key);
    const timestamp = now();
    if (existing && existing.expiresAt > timestamp && existing.owner !== owner) return { acquired: false, ...existing };
    const lease = { key, owner, acquiredAt: timestamp, expiresAt: timestamp + ttlMs, fencingToken: crypto.randomUUID() };
    leases.set(key, lease);
    return { acquired: true, ...lease, renew: () => renew(key, owner, ttlMs), release: () => release(key, owner) };
  }
  function renew(key, owner, ttlMs = 30_000) {
    const current = leases.get(key);
    if (!current || current.owner !== owner || current.expiresAt <= now()) return { renewed: false };
    const next = { ...current, expiresAt: now() + ttlMs };
    leases.set(key, next);
    return { renewed: true, ...next };
  }
  function release(key, owner) {
    const current = leases.get(key);
    if (!current || current.owner !== owner) return false;
    leases.delete(key);
    return true;
  }
  return Object.freeze({ acquire, renew, release, list: () => [...leases.values()] });
}