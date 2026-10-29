import { createLeaseStore } from "@ayzen/leases";

export function createCoordinationService({ leases = createLeaseStore(), audit = () => {} } = {}) {
  return Object.freeze({
    acquire(key, options) {
      const result = leases.acquire(key, options);
      audit({ action: result.acquired ? "lease.acquired" : "lease.denied", key, owner: options?.owner });
      return result;
    },
    renew: leases.renew,
    release: leases.release,
    list: leases.list,
  });
}