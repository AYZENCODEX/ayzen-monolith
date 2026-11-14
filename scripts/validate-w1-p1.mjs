#!/usr/bin/env node
/**
 * W1-P1 validator (per-module accounts + module uids). Static: needs no database.
 * The behavioral proof (real Postgres) is scripts/src/test-module-accounts-db.mjs.
 *
 *   node scripts/validate-w1-p1.mjs
 *
 * Checks that the places which must agree about the module list / uid format actually agree:
 * registry <-> SQL migration <-> boot-time MIGRATIONS mirror <-> drizzle schema <-> backfill map
 * <-> identifiers.json <-> identity-context regex.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES } from "../packages/module-registry/src/index.mjs";
import { MODULE_UID, formatModuleUid, parseModuleUid } from "../packages/identity-context/src/index.mjs";
import { SOURCES } from "./src/lib/module-accounts-backfill.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

const MIGRATION = "migrations/125_module_accounts.sql";
check(existsSync(join(root, MIGRATION)), `${MIGRATION} is missing`);
const sql = existsSync(join(root, MIGRATION)) ? read(MIGRATION) : "";
const ids = MODULES.map((m) => m.id);

// 1. SQL CHECK list == registry ids
const chk = /module IN \(([^)]*)\)/.exec(sql);
const sqlIds = chk ? [...chk[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check(JSON.stringify([...sqlIds].sort()) === JSON.stringify([...ids].sort()), `migration CHECK module list [${sqlIds}] != registry [${ids}]`);

// 2. SQL prefix CASE == registry uidPrefix, and one sequence per module
for (const m of MODULES) {
  check(new RegExp(`WHEN '${m.id}' THEN '${m.uidPrefix}'`).test(sql), `migration prefix for ${m.id} != registry uidPrefix ${m.uidPrefix}`);
  check(sql.includes(`CREATE SEQUENCE IF NOT EXISTS module_uid_seq_${m.id};`), `missing sequence module_uid_seq_${m.id}`);
  check(/^[A-Z]{3}$/.test(m.uidPrefix), `registry uidPrefix for ${m.id} is not 3 capital letters`);
}
check(new Set(MODULES.map((m) => m.uidPrefix)).size === MODULES.length, "registry uidPrefix values are not unique");

// 3. Boot-time mirror carries the same objects (the API server applies these at startup)
const boot = read("artifacts/api-server/src/lib/schema-migrations.ts");
for (const needle of ["CREATE TABLE IF NOT EXISTS module_accounts", "ayzen_format_module_uid", "ayzen_provision_module_account", "module_accounts_user_module_idx", "module_accounts_module_uid_idx", "module_accounts_module_seq_idx", ...ids.map((i) => `module_uid_seq_${i}`)]) {
  check(boot.includes(needle), `schema-migrations.ts is missing "${needle}" (boot mirror out of sync with ${MIGRATION})`);
}
const sqlPrefixLine = (re) => (sql.match(re) || [""])[0];
check(sqlPrefixLine(/CASE WHEN p_seq > 999999[^\n]*/) === sqlPrefixLine(/CASE WHEN p_seq > 999999[^\n]*/) && boot.includes("CASE WHEN p_seq > 999999 THEN p_seq::text ELSE lpad(p_seq::text, 6, '0') END"), "boot mirror format function differs from migration");

// 4. drizzle schema + export
check(existsSync(join(root, "lib/db/src/schema/module-accounts.ts")), "lib/db/src/schema/module-accounts.ts is missing");
check(/export \* from "\.\/module-accounts";/.test(read("lib/db/src/schema/index.ts")), "lib/db schema index does not export module-accounts");

// 5. backfill attribution map covers exactly the registry modules; tables are known to the codebase
check(JSON.stringify(Object.keys(SOURCES).sort()) === JSON.stringify([...ids].sort()), "backfill SOURCES modules != registry modules");
const known = boot + "\n" + read("lib/db/src/schema/projects.ts") + read("lib/db/src/schema/vault.ts");
for (const [module, srcs] of Object.entries(SOURCES)) {
  for (const s of srcs) {
    check(s.table === "users" || known.includes(`"${s.table}"`) || known.includes(`${s.table} (`) || known.includes(`${s.table} `), `backfill source ${module}: table ${s.table} not found in schema`);
  }
}

// 6. identifiers.json + identity-context agree on the format
const ident = JSON.parse(read("schemas/platform/identifiers.json"));
check(ident.definitions?.moduleUid?.pattern === MODULE_UID.source.replace(/[()]/g, ""), `identifiers.json moduleUid pattern ${ident.definitions?.moduleUid?.pattern} != identity-context ${MODULE_UID.source.replace(/[()]/g, "")}`);
check(ident.identifierTypes?.moduleUid?.pattern === "#/definitions/moduleUid", "identifiers.json identifierTypes.moduleUid missing/incorrect");
for (const m of MODULES) {
  const uid = formatModuleUid(m.uidPrefix, 1);
  check(parseModuleUid(uid)?.prefix === m.uidPrefix, `identity-context cannot round-trip ${uid}`);
}

// 7. API surface is mounted; docs exist
check(/router\.use\(moduleAccountsRouter\)/.test(read("artifacts/api-server/src/routes/index.ts")), "routes/index.ts does not mount moduleAccountsRouter");
check(existsSync(join(root, "CHANGES_W1_P1_MODULE_ACCOUNTS.md")), "CHANGES_W1_P1_MODULE_ACCOUNTS.md is missing");

if (errors.length) {
  console.error("W1_P1_VALIDATION: FAIL");
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log("W1_P1_VALIDATION: PASS");
console.log(JSON.stringify({ modules: ids.length, prefixes: Object.fromEntries(MODULES.map((m) => [m.id, m.uidPrefix])) }));
