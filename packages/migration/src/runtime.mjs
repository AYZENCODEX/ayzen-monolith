import crypto from "node:crypto";
import { assertDatabaseTarget, validateStaticMigrationSql } from "./beta.mjs";

const SAFE_MIGRATION_ID = /^\d{3}_[a-z0-9][a-z0-9_-]+$/;

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertMigrationId(value) {
  if (typeof value !== "string" || !SAFE_MIGRATION_ID.test(value)) throw new Error("Migration id is invalid");
  return value;
}

/**
 * Creates a database-neutral migration executor. The caller supplies a
 * pg-compatible client and resolves the SQL from the reviewed registry.
 * Database/schema names are validated identifiers; migration SQL is static
 * content and never built from request data.
 */
export function createMigrationExecutor({ client, registry, sqlById, clock = () => new Date().toISOString() } = {}) {
  if (!client || typeof client.query !== "function") throw new Error("A pg-compatible client is required");
  if (!registry || typeof registry.getApp !== "function") throw new Error("Migration registry is required");
  if (!sqlById || typeof sqlById.get !== "function") throw new Error("A reviewed SQL resolver is required");
  async function apply({ app, migrationId, actor = "migration-operator" } = {}) {
    assertMigrationId(migrationId);
    const manifest = registry.getApp(app);
    if (!manifest) throw new Error(`App migration is not registered: ${app}`);
    assertDatabaseTarget(manifest.database);
    const migration = manifest.sqlMigrations.find((entry) => entry.id === migrationId);
    if (!migration) throw new Error(`${migrationId} is not registered for ${app}`);
    const sql = validateStaticMigrationSql(sqlById.get(migrationId), migrationId);
    const digest = checksum(sql);
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL search_path TO "${manifest.database.schema}", public`);
      await client.query(sql);
      await client.query(
        "INSERT INTO migration_beta_history (migration_id, app, target_db, checksum, actor, applied_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [migrationId, app, manifest.database.databaseKey, digest, actor, clock()],
      );
      await client.query("COMMIT");
      return Object.freeze({ migrationId, app, targetDb: manifest.database.databaseKey, checksum: digest, status: "applied" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return Object.freeze({ apply });
}

export { checksum };