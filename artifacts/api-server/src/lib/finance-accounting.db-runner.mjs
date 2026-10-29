import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { buildPoolConfig } from "@workspace/db";
import { MIGRATIONS } from "./schema-migrations.ts";

if (process.env.DATABASE_URL_TARGET !== "replit-test") {
  throw new Error('Finance database tests require DATABASE_URL_TARGET="replit-test".');
}

const requiredTables = new Set([
  "finance_accounts",
  "finance_books",
  "finance_budgets",
  "finance_journal_entries",
  "finance_journal_lines",
  "finance_ledger_entries",
  "finance_parties",
  "finance_payment_methods",
  "finance_repayments",
  "finance_amortization",
  "finance_goals",
  "finance_report_schedules",
  "finance_recurring_rules",
  "finance_assets",
  "finance_asset_owners",
  "finance_currency_rates",
  "finance_attachments", // WP-5b
  "finance_invoice_lines", // WP-5b
  "finance_depreciation", // WP-4 tests (the runner never created it, so the wp4 suite could not run)
  "finance_invoices", // WP-6a
  "finance_invoice_events", // WP-6a
  "finance_invoice_line_items", // WP-6a
  "finance_payment_agreements", // WP-6a (agreements are created by the claim use case), WP-6b
]);

// The invoice and receipt code reads a few columns of the users table (username, email, Telegram chat id and the
// invoice branding fields). The real table is not part of the Finance DDL, so the isolated schema gets a minimal
// stand-in with exactly those columns. It lives in the throwaway schema and is dropped with it.
const USERS_STAND_IN = `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT,
  email TEXT,
  telegram_chat_id TEXT,
  finance_invoice_logo_url TEXT,
  finance_invoice_theme_color TEXT NOT NULL DEFAULT '#00a89f',
  finance_invoice_business_name TEXT,
  finance_invoice_business_address TEXT,
  finance_invoice_footer_note TEXT,
  finance_invoice_tax_id TEXT,
  finance_invoice_business_email TEXT,
  finance_invoice_business_phone TEXT,
  finance_invoice_website TEXT,
  finance_invoice_terms TEXT,
  finance_invoice_number_prefix TEXT NOT NULL DEFAULT 'INV'
)`;
// The passkey confirmation use case reads and updates the payer's WebAuthn credentials. Same approach: a minimal
// stand-in with the columns the code touches (the real table is not Finance DDL), dropped with the schema.
const PASSKEY_STAND_IN = `CREATE TABLE passkey_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  transports TEXT,
  name TEXT NOT NULL DEFAULT 'Passkey',
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
)`;
// The wallet bridge reads one column of the wallets table (auto_finance_sync). Same approach: a minimal stand-in
// in the throwaway schema, dropped with it.
const WALLETS_STAND_IN = `CREATE TABLE wallets (
  id SERIAL PRIMARY KEY,
  auto_finance_sync BOOLEAN NOT NULL DEFAULT TRUE
)`;
const safeSchemaName = `finance_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
const { Client } = pg;
const client = new Client(buildPoolConfig());
let schemaCreated = false;
let testExitCode = 1;

function statementKind(statement) {
  const create = statement.match(/^CREATE TABLE IF NOT EXISTS (finance_[a-z0-9_]+) \(/i);
  if (create && requiredTables.has(create[1])) return ["create", create[1]];

  const alter = statement.match(/^ALTER TABLE (finance_[a-z0-9_]+) ADD COLUMN IF NOT EXISTS /i);
  if (alter && requiredTables.has(alter[1])) return ["alter", alter[1]];

  // FIN F11: guarded real -> double precision conversion, one DO block per table.
  const convert = statement.match(/^DO \$f11_(finance_[a-z0-9_]+)\$/);
  if (convert && requiredTables.has(convert[1])) return ["convert", convert[1]];

  const index = statement.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z0-9_]+ ON (finance_[a-z0-9_]+)\(/i);
  if (index && requiredTables.has(index[1])) return ["index", index[1]];
  return null;
}

try {
  await client.connect();
  await client.query(`CREATE SCHEMA "${safeSchemaName}"`);
  schemaCreated = true;
  await client.query(`SET search_path TO "${safeSchemaName}"`);
  await client.query(USERS_STAND_IN);
  await client.query(PASSKEY_STAND_IN);
  await client.query(WALLETS_STAND_IN);
  await client.query("CREATE UNIQUE INDEX passkey_credentials_credential_id_idx ON passkey_credentials(credential_id)");

  // Reuse only Finance table DDL from the application's migration catalogue.
  // The isolated schema has no public fallback, and DML/backfills are excluded.
  const safeStatements = MIGRATIONS
    .map((statement) => ({ statement, kind: statementKind(statement) }))
    .filter((item) => item.kind);
  const createdTables = new Set(
    safeStatements.filter((item) => item.kind[0] === "create").map((item) => item.kind[1]),
  );
  const missingCreates = [...requiredTables].filter((table) => !createdTables.has(table));
  if (missingCreates.length > 0) {
    throw new Error(`Finance test schema is missing source DDL for: ${missingCreates.join(", ")}`);
  }

  for (const phase of ["create", "alter", "convert", "index"]) {
    for (const item of safeStatements) {
      if (item.kind[0] === phase) await client.query(item.statement);
    }
  }

  const tableResult = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [safeSchemaName, [...requiredTables]],
  );
  const presentTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = [...requiredTables].filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`Finance test schema is missing tables: ${missingTables.join(", ")}`);
  }

  const scopedUrl = new URL(buildPoolConfig().connectionString);
  scopedUrl.searchParams.set("options", `-c search_path=${safeSchemaName}`);
  const test = spawnSync(
    process.execPath,
    [
      "--test",
      "--import",
      "tsx",
      "src/lib/finance-accounting.db.test.ts",
      "src/finance/ai/finance-ai.test.ts",
      "src/finance/application/reports.db.test.ts",
      "src/finance/networth/networth.db.test.ts",
      "src/finance/payment-methods/payment-methods.db.test.ts",
      "src/finance/receipts/receipt-tokens.db.test.ts",
      "src/finance/ledger-invariants.db.test.ts",
      "src/finance/jobs/due-rules.db.test.ts",
      "src/finance/application/wp5a-use-cases.db.test.ts",
      "src/finance/application/wp5b-use-cases.db.test.ts",
      "src/finance/application/wp6a-use-cases.db.test.ts",
      "src/finance/application/wp6b-use-cases.db.test.ts",
      "src/finance/wp7-use-cases.db.test.ts",
      "src/finance/application/wp2-use-cases.db.test.ts",
      "src/finance/application/wp2b-use-cases.db.test.ts",
      "src/finance/application/wp4-use-cases.db.test.ts",
      "src/finance/f11-precision.db.test.ts",
    ],
    {
      cwd: new URL("../../", import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL_TARGET: "replit-test",
        DATABASE_URL: scopedUrl.toString(),
      },
      stdio: "inherit",
    },
  );
  if (test.error) throw test.error;
  testExitCode = test.status ?? 1;
} catch (error) {
  console.error(`Finance test database setup failed: ${error instanceof Error ? error.message : String(error)}`);
  testExitCode = 1;
} finally {
  if (schemaCreated) {
    try {
      await client.query(`DROP SCHEMA "${safeSchemaName}" CASCADE`);
      const remaining = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS present",
        [safeSchemaName],
      );
      if (remaining.rows[0]?.present) {
        throw new Error("isolated schema still exists after DROP SCHEMA");
      }
    } catch (error) {
      console.error(`Could not remove isolated Finance test schema "${safeSchemaName}".`);
      console.error(error instanceof Error ? error.message : String(error));
      testExitCode = 1;
    }
  }
  await client.end().catch(() => {});
}

process.exitCode = testExitCode;
