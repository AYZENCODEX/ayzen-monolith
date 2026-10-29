import crypto from "node:crypto";

export const MIGRATION_CATEGORIES = Object.freeze([
  "features",
  "architecture",
  "security",
  "infrastructure",
]);

export const BETA_STAGES = Object.freeze([
  "inventory",
  "isolated",
  "backfill",
  "dual_read",
  "read_switched",
  "write_switched",
  "extracted",
  "rolled_back",
]);

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;
const DATABASE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const DATABASE_MODES = new Set(["shared", "isolated-capable", "isolated"]);

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...new Set(values.map((value) => value.trim()))];
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`${label} must be a safe workspace-relative path`);
  }
  return value;
}

export function assertDatabaseTarget(database = {}) {
  if (!DATABASE_MODES.has(database.mode)) throw new Error(`Database mode is invalid: ${database.mode}`);
  if (typeof database.databaseKey !== "string" || !DATABASE_IDENTIFIER.test(database.databaseKey)) {
    throw new Error("Database key is invalid");
  }
  if (typeof database.schema !== "string" || !DATABASE_IDENTIFIER.test(database.schema)) {
    throw new Error("Database schema is invalid");
  }
  if (typeof database.connectionEnv !== "string" || !/^AYZEN_DB_[A-Z0-9_]+_URL$/.test(database.connectionEnv)) {
    throw new Error("Database connection environment name is invalid");
  }
  if (database.crossAppAccess !== "forbidden") throw new Error("Cross-app database access must be forbidden");
  return Object.freeze({
    mode: database.mode,
    databaseKey: database.databaseKey,
    schema: database.schema,
    connectionEnv: database.connectionEnv,
    crossAppAccess: "forbidden",
  });
}

export function validateStaticMigrationSql(sql, label = "Migration SQL") {
  if (typeof sql !== "string" || !sql.trim()) throw new Error(`${label} is empty`);
  if (sql.includes("\u0000") || sql.includes("${") || /\bprocess\.env\b|\bchild_process\b|\bexec\s*\(/i.test(sql)) {
    throw new Error(`${label} contains dynamic execution or interpolation`);
  }
  return sql;
}

function normalizeSqlMigration(entry, app, database) {
  if (!entry || typeof entry !== "object") throw new Error(`${app}: SQL migration must be an object`);
  const id = assertIdentifier(entry.id, `${app} SQL migration id`);
  if (!/^\d{3}_[a-z0-9][a-z0-9_-]+$/.test(id)) throw new Error(`${id}: SQL migration id must use the numbered filename format`);
  return Object.freeze({
    id,
    app,
    owner: assertIdentifier(entry.owner ?? app, `${id} owner`),
    source: assertSafeRelativePath(entry.source, `${id} source`),
    target: assertSafeRelativePath(entry.target, `${id} target`),
    targetDb: database.databaseKey,
    dependsOn: Object.freeze(uniqueStrings(entry.dependsOn ?? [], `${id} dependencies`)),
    status: entry.status ?? "transferred",
  });
}

function normalizeCategoryEntries(entries, category) {
  if (!Array.isArray(entries)) throw new Error(`${category} migrations must be an array`);
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error(`${category} migration must be an object`);
    return Object.freeze({
      id: assertIdentifier(entry.id, `${category} migration id`),
      category,
      description: String(entry.description ?? ""),
      owner: assertIdentifier(entry.owner, `${category} migration owner`),
      dependsOn: Object.freeze(uniqueStrings(entry.dependsOn ?? [], `${category} dependencies`)),
      gates: Object.freeze(uniqueStrings(entry.gates ?? ["backup", "validation", "rollback"], `${category} gates`)),
      reversible: entry.reversible !== false,
      status: entry.status ?? "planned",
    });
  });
}

export function createAppMigrationManifest({
  app,
  displayName = app,
  owner = app,
  source = {},
  target = {},
  database = {},
  categories = {},
  sqlMigrations = [],
  beta = {},
} = {}) {
  assertIdentifier(app, "App migration name");
  assertIdentifier(owner, "App migration owner");
  const databaseTarget = assertDatabaseTarget(database);
  const normalized = Object.fromEntries(
    MIGRATION_CATEGORIES.map((category) => [category, normalizeCategoryEntries(categories[category] ?? [], category)]),
  );
  const entries = MIGRATION_CATEGORIES.flatMap((category) => normalized[category]);
  const normalizedSqlMigrations = sqlMigrations.map((entry) => normalizeSqlMigration(entry, app, databaseTarget));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate app migration: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of normalizedSqlMigrations) {
    if (ids.has(entry.id)) throw new Error(`Duplicate app migration: ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    schemaVersion: 1,
    app,
    displayName: String(displayName),
    owner,
    source: Object.freeze({ ...source }),
    target: Object.freeze({ ...target }),
    database: databaseTarget,
    categories: Object.freeze(Object.fromEntries(
      MIGRATION_CATEGORIES.map((category) => [category, Object.freeze(normalized[category])]),
    )),
    sqlMigrations: Object.freeze(normalizedSqlMigrations),
    beta: Object.freeze({
      isolationKey: beta.isolationKey ?? `${app}:beta`,
      stage: beta.stage ?? "inventory",
      trafficPercent: Number.isFinite(beta.trafficPercent) ? beta.trafficPercent : 0,
      rollback: beta.rollback ?? `disable ${app} beta route and restore monolith traffic`,
    }),
  });
}

export function createMigrationCatalog({ central, shared, apps = [] } = {}) {
  if (!central || !shared) throw new Error("Central and shared migration manifests are required");
  const appManifests = apps.map((manifest) => createAppMigrationManifest(manifest));
  const byApp = new Map(appManifests.map((manifest) => [manifest.app, manifest]));
  if (byApp.size !== appManifests.length) throw new Error("Duplicate app migration manifest");
  const allEntries = appManifests.flatMap((manifest) =>
    MIGRATION_CATEGORIES.flatMap((category) => manifest.categories[category]).concat(manifest.sqlMigrations),
  );
  const entryIds = new Set(allEntries.map((entry) => entry.id));
  const missingDependencies = allEntries.flatMap((entry) =>
    entry.dependsOn.filter((dependency) => !entryIds.has(dependency)).map((dependency) => ({
      migration: entry.id,
      dependency,
    })),
  );
  return Object.freeze({
    schemaVersion: 1,
    central: Object.freeze({ ...central }),
    shared: Object.freeze({ ...shared }),
    apps: Object.freeze(appManifests),
    validate() {
      const unsafe = appManifests.flatMap((manifest) =>
        MIGRATION_CATEGORIES.flatMap((category) =>
          manifest.categories[category]
            .filter((entry) => !entry.reversible)
            .map((entry) => `${manifest.app}:${entry.id}`),
        ),
      );
      return Object.freeze({
        valid: missingDependencies.length === 0 && unsafe.length === 0,
        missingDependencies,
        irreversible: unsafe,
      });
    },
    getApp(app) {
      return byApp.get(app);
    },
    list({ app, category, status } = {}) {
      return appManifests
        .filter((manifest) => !app || manifest.app === app)
        .flatMap((manifest) => (category
          ? manifest.categories[category] ?? []
          : MIGRATION_CATEGORIES.flatMap((item) => manifest.categories[item])))
        .filter((entry) => !status || entry.status === status);
    },
  });
}

export function createBetaMigrationPlan({
  catalog,
  app,
  requestedStage = "isolated",
  confirmation = false,
  actor = "operator",
} = {}) {
  if (!catalog || typeof catalog.getApp !== "function") throw new Error("Migration catalog is required");
  if (!BETA_STAGES.includes(requestedStage)) throw new Error(`Unknown beta stage: ${requestedStage}`);
  const manifest = catalog.getApp(app);
  if (!manifest) throw new Error(`App migration is not registered: ${app}`);
  const validation = catalog.validate();
  if (!validation.valid) throw new Error("Migration catalog has unresolved or irreversible entries");
  if (requestedStage !== "inventory" && confirmation !== true) {
    throw new Error("Beta migration confirmation is required");
  }
  return Object.freeze({
    id: crypto.randomUUID(),
    app,
    actor,
    stage: requestedStage,
    isolationKey: manifest.beta.isolationKey,
    trafficPercent: requestedStage === "isolated" ? 0 : manifest.beta.trafficPercent,
    source: manifest.source,
    target: manifest.target,
    entries: catalog.list({ app }),
    sqlMigrations: manifest.sqlMigrations,
    rollback: manifest.beta.rollback,
    createdAt: new Date().toISOString(),
  });
}

export function createWorkspaceMigrationManifest({
  centralWebsite = {},
  shared = {},
  apps = [],
} = {}) {
  return createMigrationCatalog({
    central: { type: "central-website", ...centralWebsite },
    shared: { type: "shared", ...shared },
    apps,
  });
}