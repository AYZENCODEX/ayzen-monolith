import { assertNonEmpty, sha256 } from "@ayzen/enforcement-core";

export function createMigrationLedger({ migrations = [], environment = "development", audit = () => {} } = {}) {
  const ledger = new Map();
  for (const migration of migrations) register(migration);
  function register(input) {
    const record = Object.freeze({
      id: assertNonEmpty(input.id, "migration id"),
      owner: assertNonEmpty(input.owner, "migration owner"),
      checksum: input.checksum ?? sha256(input.sql ?? input),
      dependsOn: [...(input.dependsOn ?? [])],
      environments: [...(input.environments ?? ["development", "staging", "production"])],
      status: input.status ?? "pending",
    });
    if (ledger.has(record.id)) throw new Error(`Migration already registered: ${record.id}`);
    ledger.set(record.id, record);
    return record;
  }
  function apply(id, { checksum, actor = "migration-runner" } = {}) {
    const record = ledger.get(id);
    if (!record) throw new Error(`Unknown migration: ${id}`);
    if (checksum && checksum !== record.checksum) throw new Error(`Migration checksum mismatch: ${id}`);
    for (const dependency of record.dependsOn) if (ledger.get(dependency)?.status !== "applied") throw new Error(`Migration dependency is not applied: ${dependency}`);
    const applied = Object.freeze({ ...record, status: "applied", appliedEnvironment: environment, appliedBy: actor, appliedAt: new Date().toISOString() });
    ledger.set(id, applied);
    audit({ action: "migration.applied", id, environment, actor });
    return applied;
  }
  return Object.freeze({
    register, apply, get: (id) => ledger.get(id), list: () => [...ledger.values()],
    pending: () => [...ledger.values()].filter((item) => item.status !== "applied" && item.environments.includes(environment)),
    verify: (actual = {}) => [...ledger.values()].filter((item) => actual[item.id] !== item.checksum).map((item) => ({ id: item.id, expected: item.checksum, actual: actual[item.id] })),
  });
}