// MKT-01b: runs the Marketplace DB characterization suite against a THROWAWAY schema of the test database.
//   pnpm --filter @workspace/api-server test:marketplace-db      (DATABASE_URL_TARGET=replit-test is set by the script)
// Same pattern as lib/finance-accounting.db-runner.mjs: create an isolated schema, build the Marketplace tables from the
// application's own DDL (lib/schema-migrations.ts), add minimal stand-ins for tables Marketplace does not own, run the tests
// with search_path pinned to that schema, then drop the schema. Nothing outside the schema is touched.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { buildPoolConfig } from "@workspace/db";
import { MIGRATIONS } from "../../lib/schema-migrations.ts";
import { SCOPE_TABLE_PATTERN, STAND_INS } from "./standins.mjs";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Marketplace database tests require DATABASE_URL_TARGET="replit-test".');
}

const TEST_FILES = [
  "src/marketplace/characterization/p2p-orders.db.test.ts",
  "src/marketplace/characterization/race-defects.db.test.ts",
  "src/marketplace/characterization/wallet-and-markets.db.test.ts",
  "src/marketplace/characterization/cart.db.test.ts",
  "src/marketplace/characterization/txn-hygiene.db.test.ts",
];
// Default: tsx first, then the stub hook (hooks registered later run first, so the stub hook remaps what tsx resolved).
// If the first run shows the REAL auth module loading (JWT / users-table errors), retry with MKT_STUB_ORDER=first.
function importOrder() {
  const stubs = ["--import", "./src/marketplace/characterization/register-stubs.mjs"];
  const tsx = ["--import", "tsx"];
  return process.env.MKT_STUB_ORDER === "first" ? [...stubs, ...tsx] : [...tsx, ...stubs];
}
const safeSchemaName = `marketplace_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
const client = new pg.Client(buildPoolConfig());
let schemaCreated = false;
let exitCode = 1;

function kind(statement) {
  const s = statement.trim();
  const create = s.match(/^CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)\s*\(/i);
  if (create && SCOPE_TABLE_PATTERN.test(create[1])) return ["create", create[1]];
  const alter = s.match(/^ALTER TABLE ([a-z0-9_]+) ADD COLUMN IF NOT EXISTS /i);
  if (alter && SCOPE_TABLE_PATTERN.test(alter[1])) return ["alter", alter[1]];
  const index = s.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z0-9_]+ ON ([a-z0-9_]+)\s*\(/i);
  if (index && SCOPE_TABLE_PATTERN.test(index[1])) return ["index", index[1]];
  return null;
}

try {
  await client.connect();
  await client.query(`CREATE SCHEMA "${safeSchemaName}"`);
  schemaCreated = true;
  await client.query(`SET search_path TO "${safeSchemaName}"`);
  for (const ddl of Object.values(STAND_INS)) await client.query(ddl);

  const statements = MIGRATIONS.map((statement) => ({ statement: statement.trim(), kind: kind(statement) })).filter((x) => x.kind);
  for (const phase of ["create", "alter", "index"]) for (const item of statements) if (item.kind[0] === phase) await client.query(item.statement);

  const required = ["marketplace_wallets", "marketplace_transactions", "marketplace_listings", "marketplace_orders", "azn_listings", "nft_market_listings"];
  const present = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [safeSchemaName]);
  const have = new Set(present.rows.map((r) => r.table_name));
  const missing = required.filter((t) => !have.has(t));
  if (missing.length) throw new Error(`test schema is missing tables: ${missing.join(", ")}`);

  const scopedUrl = new URL(buildPoolConfig().connectionString);
  scopedUrl.searchParams.set("options", `-c search_path=${safeSchemaName}`);
  const run = spawnSync(
    process.execPath,
    // tsx first, then the stub hook: hooks registered later run first, so the stub hook remaps what tsx resolved.
    ["--test", "--test-concurrency=1", ...importOrder(), ...TEST_FILES],
    { cwd: new URL("../../../", import.meta.url), env: { ...process.env, DATABASE_URL_TARGET: "replit-test", DATABASE_URL: scopedUrl.toString() }, stdio: "inherit" },
  );
  if (run.error) throw run.error;
  exitCode = run.status ?? 1;
} catch (error) {
  console.error(`Marketplace test database setup failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  if (schemaCreated) {
    try {
      await client.query(`DROP SCHEMA "${safeSchemaName}" CASCADE`);
      const left = await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS present", [safeSchemaName]);
      if (left.rows[0]?.present) throw new Error("isolated schema still exists after DROP SCHEMA");
    } catch (error) {
      console.error(`Could not remove isolated Marketplace test schema "${safeSchemaName}": ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
  }
  await client.end().catch(() => {});
}
process.exitCode = exitCode;
