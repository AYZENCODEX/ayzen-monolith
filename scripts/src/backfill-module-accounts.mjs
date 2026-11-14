#!/usr/bin/env node
/**
 * W1-P1 backfill: give every existing user a module account (+ module_uid) in each module where
 * they already have data. DRY-RUN by default; pass --apply to write.
 *
 *   DATABASE_URL=... node scripts/src/backfill-module-accounts.mjs            # report only
 *   DATABASE_URL=... node scripts/src/backfill-module-accounts.mjs --apply    # create rows
 *   ... --module sylo --module fyra                                           # limit modules
 *   ... --json                                                                # machine report
 *
 * Idempotent and deterministic (user ids ascending). Requires migration 125 (the API server also
 * applies it at boot).
 */
import { createRequire } from "node:module";
// pg is a dependency of @workspace/db, not of scripts: resolve it from there (no lockfile change).
const pg = createRequire(new URL("../../lib/db/package.json", import.meta.url))("pg");
import { apply, plan, formatReport, SOURCES } from "./lib/module-accounts-backfill.mjs";

const args = process.argv.slice(2);
const doApply = args.includes("--apply");
const asJson = args.includes("--json");
const modules = args.flatMap((a, i) => (a === "--module" ? [args[i + 1]] : []));
for (const m of modules) if (!(m in SOURCES)) { console.error(`unknown module: ${m}`); process.exit(2); }

const conn = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!conn) { console.error("no DATABASE_URL / APP_DATABASE_URL"); process.exit(2); }

const client = new pg.Client({ connectionString: conn, ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false } });
await client.connect();
const query = (sql, params) => client.query(sql, params);
try {
  const opts = modules.length ? { modules } : {};
  if (!doApply) {
    const p = await plan(query, opts);
    console.log(asJson ? JSON.stringify(p, null, 2) : `DRY RUN (no writes; pass --apply)\n${formatReport(p)}`);
  } else {
    const r = await apply(query, opts);
    console.log(asJson ? JSON.stringify(r, null, 2) : `${formatReport(r.plan)}\n\nAPPLIED: ${JSON.stringify(r.created)}`);
  }
} finally {
  await client.end();
}
