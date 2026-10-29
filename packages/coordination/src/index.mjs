import crypto from "node:crypto";
import { assertNonEmpty } from "@ayzen/enforcement-core";

export function createCoordinationPrimitives({ now = () => Date.now(), audit = () => {} } = {}) {
  const leases = new Map();
  const idempotency = new Map();
  function acquire(key, { owner = crypto.randomUUID(), ttlMs = 30_000 } = {}) {
    assertNonEmpty(key, "coordination key");
    const current = leases.get(key);
    const timestamp = now();
    if (current && current.expiresAt > timestamp && current.owner !== owner) return { acquired: false, ...current };
    const lease = { key, owner, fencingToken: crypto.randomUUID(), acquiredAt: timestamp, expiresAt: timestamp + ttlMs };
    leases.set(key, lease);
    audit({ action: "coordination.lease.acquired", key, owner, fencingToken: lease.fencingToken });
    return { acquired: true, ...lease };
  }
  function release(key, owner) {
    const current = leases.get(key);
    if (!current || current.owner !== owner) return false;
    leases.delete(key);
    audit({ action: "coordination.lease.released", key, owner });
    return true;
  }
  function runOnce(scope, key, valueFactory, { ttlMs = 86_400_000 } = {}) {
    const id = `${assertNonEmpty(scope, "scope")}:${assertNonEmpty(key, "key")}`;
    const prior = idempotency.get(id);
    if (prior && prior.expiresAt > now()) return { status: "replay", value: prior.value };
    const value = valueFactory();
    idempotency.set(id, { value, expiresAt: now() + ttlMs });
    return { status: "completed", value };
  }
  return Object.freeze({
    acquire, release,
    renew(key, owner, ttlMs = 30_000) {
      const current = leases.get(key);
      if (!current || current.owner !== owner || current.expiresAt <= now()) return { renewed: false };
      const next = { ...current, expiresAt: now() + ttlMs };
      leases.set(key, next);
      return { renewed: true, ...next };
    },
    runOnce,
    snapshot: () => ({ leases: [...leases.values()], idempotency: [...idempotency.keys()] }),
  });
}