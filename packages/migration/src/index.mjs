import crypto from "node:crypto";

export const CUTOVER_STATES = Object.freeze(["monolith", "dual_read", "read_switched", "write_switched", "extracted"]);
export const REQUIRED_GATES = Object.freeze(["backup", "characterization", "backfill", "validation", "rollback"]);

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

export function checksum(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

export function compareSnapshots({ sourceRows = [], targetRows = [], key = "id", fields = [] } = {}) {
  const source = new Map(sourceRows.map((row) => [String(row[key]), row]));
  const target = new Map(targetRows.map((row) => [String(row[key]), row]));
  const missing = [];
  const extra = [];
  const mismatched = [];
  for (const [id, row] of source) {
    if (!target.has(id)) {
      missing.push(id);
      continue;
    }
    const targetRow = target.get(id);
    const comparedFields = fields.length ? fields : Object.keys(row).filter((field) => field !== key);
    if (checksum(Object.fromEntries(comparedFields.map((field) => [field, row[field]]))) !== checksum(Object.fromEntries(comparedFields.map((field) => [field, targetRow[field]])))) mismatched.push(id);
  }
  for (const id of target.keys()) if (!source.has(id)) extra.push(id);
  return { sourceCount: source.size, targetCount: target.size, missing, extra, mismatched, valid: !missing.length && !extra.length && !mismatched.length };
}

export function assertBackfillValid(result) {
  if (!result?.valid) throw new Error(`Backfill validation failed: missing=${result?.missing?.length ?? 0}, extra=${result?.extra?.length ?? 0}, mismatched=${result?.mismatched?.length ?? 0}`);
  return result;
}

export function createCutoverPlan({ service, routePrefix, owner, sourceSchema = "public", targetSchema, state = "monolith" } = {}) {
  if (!service || !routePrefix || !owner) throw new Error("Service, route prefix, and owner are required");
  if (!CUTOVER_STATES.includes(state)) throw new Error(`Unknown cutover state: ${state}`);
  return Object.freeze({
    service,
    routePrefix,
    owner,
    sourceSchema,
    targetSchema: targetSchema ?? `${service}_owned`,
    state,
    requiredGates: REQUIRED_GATES,
    rollback: { action: "disable route URL and restore monolith traffic", reversible: true },
  });
}

export function canAdvanceCutover(current, next, completedGates = []) {
  const currentIndex = CUTOVER_STATES.indexOf(current);
  const nextIndex = CUTOVER_STATES.indexOf(next);
  return currentIndex >= 0 && nextIndex === currentIndex + 1 && REQUIRED_GATES.every((gate) => completedGates.includes(gate));
}

export function createReconciliationReport({ service, sourceRows = [], targetRows = [], key = "id", fields = [], at = new Date().toISOString() } = {}) {
  if (!service) throw new Error("Migration service is required");
  const comparison = compareSnapshots({ sourceRows, targetRows, key, fields });
  return Object.freeze({
    service,
    at,
    ...comparison,
    gate: comparison.valid ? "validation_passed" : "validation_failed",
    rollbackRequired: !comparison.valid,
  });
}

export function assertMigrationGates(completedGates = []) {
  const missing = REQUIRED_GATES.filter((gate) => !completedGates.includes(gate));
  if (missing.length) throw new Error(`Migration gates are incomplete: ${missing.join(", ")}`);
  return true;
}

export function createMigrationJournal({ service, clock = () => new Date().toISOString() } = {}) {
  const entries = [];
  return {
    record({ action, state, actor, details = {} } = {}) {
      if (!action || !state) throw new Error("Migration journal action and state are required");
      const entry = Object.freeze({ id: crypto.randomUUID(), service, action, state, actor, details, at: clock() });
      entries.push(entry);
      return entry;
    },
    list() { return [...entries]; },
    checksum() { return checksum(entries); },
  };
}

export {
  BETA_STAGES,
  MIGRATION_CATEGORIES,
  createAppMigrationManifest,
  createBetaMigrationPlan,
  createMigrationCatalog,
  createWorkspaceMigrationManifest,
} from "./beta.mjs";

export {
  assertDatabaseTarget,
  validateStaticMigrationSql,
} from "./beta.mjs";

export { createMigrationExecutor } from "./runtime.mjs";