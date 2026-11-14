#!/usr/bin/env node
/**
 * W1-P1 DB tests for migrations/125_module_accounts.sql + scripts/src/lib/module-accounts-backfill.mjs.
 * Runs against a REAL Postgres (the SQL functions are the thing under test): set
 * MODULE_ACCOUNTS_TEST_DATABASE_URL to any server where the role may CREATE DATABASE. A throwaway
 * database is created and dropped. Without the variable the suite skips (exit 0) so it never
 * blocks a machine that has no Postgres; CI sets the variable (see .github/workflows/ci.yml).
 *
 *   MODULE_ACCOUNTS_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres \
 *     node --test scripts/src/test-module-accounts-db.mjs
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { MODULES } from "../../packages/module-registry/src/index.mjs";
import { formatModuleUid, parseModuleUid } from "../../packages/identity-context/src/index.mjs";
import { SOURCES, discover, plan, apply } from "./lib/module-accounts-backfill.mjs";

const adminUrl = process.env.MODULE_ACCOUNTS_TEST_DATABASE_URL;
const skip = adminUrl ? false : "MODULE_ACCOUNTS_TEST_DATABASE_URL not set";
const pg = skip ? null : createRequire(new URL("../../lib/db/package.json", import.meta.url))("pg");
const MIGRATION = readFileSync(new URL("../../migrations/125_module_accounts.sql", import.meta.url), "utf8");

let dbName, pool, admin;
const q = (sql, params) => pool.query(sql, params);
const withUrl = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  dbName = `w1p1_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: withUrl(adminUrl, dbName), max: 12 });
  // Minimal stand-ins for the tables the migration / backfill touch. Same column names as production.
  await q(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, ayzen_email TEXT);
           CREATE TABLE service_table_ownership (id SERIAL PRIMARY KEY, service_key TEXT NOT NULL, table_name TEXT NOT NULL, UNIQUE(service_key, table_name));`);
  for (const [, srcs] of Object.entries(SOURCES)) {
    for (const s of srcs) {
      if (s.table === "users" || s.table === "game_entries") continue; // game_entries left missing on purpose
      await q(`CREATE TABLE IF NOT EXISTS ${s.table} (id SERIAL PRIMARY KEY)`);
      await q(`ALTER TABLE ${s.table} ADD COLUMN IF NOT EXISTS ${s.column} INTEGER`);
    }
  }
  await q(MIGRATION);
});

after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP DATABASE ${dbName}`);
  await admin.end();
});

const mkUsers = async (n, extra = {}) => {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await q("INSERT INTO users (username, ayzen_email) VALUES ($1,$2) RETURNING id", [`u${Math.random()}`, extra.ayzenEmail ?? null])).rows[0].id);
  return ids;
};

test("migration is idempotent (second run is a no-op)", { skip }, async () => {
  await q(MIGRATION);
  await q(MIGRATION);
  const { rows } = await q("SELECT count(*)::int n FROM service_table_ownership WHERE table_name='module_accounts'");
  assert.equal(rows[0].n, 1);
});

test("SQL format function matches the JS formatter, including past 999999", { skip }, async () => {
  for (const seq of [1, 7, 42, 999999, 1000000, 12345678]) {
    const { rows } = await q("SELECT ayzen_format_module_uid('SYL', $1::bigint) AS uid", [seq]);
    assert.equal(rows[0].uid, formatModuleUid("SYL", seq));
    assert.deepEqual(parseModuleUid(rows[0].uid), { prefix: "SYL", seq });
  }
});

test("every registry module provisions with its registry uidPrefix, each sequence starting at 000001", { skip }, async () => {
  const [u] = await mkUsers(1);
  for (const m of MODULES) {
    const { rows } = await q("SELECT * FROM ayzen_provision_module_account($1, $2, 'signup')", [u, m.id]);
    assert.equal(rows[0].module_uid, `${m.uidPrefix}-000001`, `${m.id} must start at 000001 with prefix ${m.uidPrefix}`);
  }
});

test("provisioning is idempotent and returns the existing account", { skip }, async () => {
  const [u1, u2] = await mkUsers(2);
  const a = (await q("SELECT * FROM ayzen_provision_module_account($1,'sylo','signup')", [u1])).rows[0];
  const b = (await q("SELECT * FROM ayzen_provision_module_account($1,'sylo','admin')", [u1])).rows[0];
  assert.equal(a.id, b.id);
  assert.equal(a.module_uid, b.module_uid);
  assert.equal(b.source, "signup", "second call must not rewrite the original row");
  const c = (await q("SELECT * FROM ayzen_provision_module_account($1,'sylo','signup')", [u2])).rows[0];
  assert.equal(c.seq, a.seq + 1);
});

test("unknown module and malformed rows are rejected", { skip }, async () => {
  const [u] = await mkUsers(1);
  await assert.rejects(q("SELECT ayzen_provision_module_account($1,'exchange','signup')", [u]), /unknown module/);
  await assert.rejects(q("INSERT INTO module_accounts (user_id,module,module_uid,seq) VALUES ($1,'sylo','syl-1',1)", [u]), /module_accounts_uid_chk/);
  await assert.rejects(q("INSERT INTO module_accounts (user_id,module,module_uid,seq) VALUES ($1,'nope','SYL-000999',999)", [u]), /module_accounts_module_chk/);
  await assert.rejects(q("SELECT ayzen_provision_module_account($1,'zynth','bogus')", [u]), /module_accounts_source_chk/);
});

test("concurrent provisioning: unique ids, one row per (user, module), uid always matches seq", { skip }, async () => {
  const users = await mkUsers(30);
  const jobs = [];
  for (let round = 0; round < 4; round++) for (const u of users) jobs.push(q("SELECT * FROM ayzen_provision_module_account($1,'verve','signup')", [u]));
  const results = (await Promise.all(jobs)).map((r) => r.rows[0]);
  const byUser = new Map();
  for (const r of results) {
    if (byUser.has(r.user_id)) assert.equal(byUser.get(r.user_id), r.module_uid, "racing callers must all see the winner");
    byUser.set(r.user_id, r.module_uid);
    assert.deepEqual(parseModuleUid(r.module_uid), { prefix: "VRV", seq: r.seq });
  }
  assert.equal(new Set(byUser.values()).size, 30);
  const { rows } = await q("SELECT count(*)::int n FROM module_accounts WHERE module='verve' AND user_id = ANY($1)", [users]);
  assert.equal(rows[0].n, 30);
});

test("deleting a user cascades to their module accounts", { skip }, async () => {
  const [u] = await mkUsers(1);
  await q("SELECT ayzen_provision_module_account($1,'fyra','signup')", [u]);
  await q("DELETE FROM users WHERE id=$1", [u]);
  assert.equal((await q("SELECT count(*)::int n FROM module_accounts WHERE user_id=$1", [u])).rows[0].n, 0);
});

test("backfill: dry-run writes nothing, apply is deterministic + idempotent, orphans and missing tables are handled", { skip }, async () => {
  // fresh module scope: zynth/wisp/warde accounts so far only come from the tests above
  await q("TRUNCATE module_accounts RESTART IDENTITY");
  for (const m of MODULES) await q(`ALTER SEQUENCE module_uid_seq_${m.id} RESTART WITH 1`);
  const [a, b, c, d] = await mkUsers(4);
  const [e] = await mkUsers(1, { ayzenEmail: "e@ayzen.test" });
  const ins = (t, col, v) => q(`INSERT INTO ${t} (${col}) VALUES ($1)`, [v]);
  // Seed out of user-id order on purpose: result must still be ordered by user id.
  await ins("vault_entries", "user_id", c);
  await ins("vault_entries", "user_id", a);
  await ins("local_accounts", "user_id", a); // duplicate source for same user: still one account
  await ins("wallets", "user_id", b);
  await ins("wallets", "user_id", 999999); // orphan: user does not exist
  await ins("team_members", "user_id", d);
  await ins("marketplace_orders", "buyer_id", a);
  await ins("marketplace_orders", "seller_id", b);

  const before = await q("SELECT count(*)::int n FROM module_accounts");
  const found = await discover(q);
  assert.deepEqual(found.modules.sylo.users, [a, c]);
  assert.deepEqual(found.modules.verve.users, [a, b]);
  assert.deepEqual(found.modules.wisp.users, [e]); // users.ayzen_email source
  assert.deepEqual(found.modules.zynth.users, []);
  assert.equal(found.modules.ryft.perSource[0].orphans, 1);
  assert.equal(found.modules.sylo.perSource.find((s) => s.table === "game_entries").skipped, "table missing");
  const dry = await plan(q);
  assert.equal(dry.modules.sylo.toCreate.length, 2);
  assert.equal((await q("SELECT count(*)::int n FROM module_accounts")).rows[0].n, before.rows[0].n, "dry run must not write");

  const r1 = await apply(q);
  assert.deepEqual(r1.created, { sylo: 2, ryft: 1, fyra: 0, verve: 2, skarn: 0, warde: 1, wisp: 1, zynth: 0 });
  const uids = Object.fromEntries((await q("SELECT user_id, module_uid, source FROM module_accounts WHERE module='sylo' ORDER BY user_id")).rows.map((r) => [r.user_id, r]));
  assert.equal(uids[a].module_uid, "SYL-000001");
  assert.equal(uids[c].module_uid, "SYL-000002");
  assert.equal(uids[a].source, "backfill");

  const r2 = await apply(q);
  assert.deepEqual(Object.values(r2.created).reduce((x, y) => x + y, 0), 0, "second apply creates nothing");
  assert.equal((await q("SELECT count(*)::int n FROM module_accounts")).rows[0].n, 7);
});

test("backfill rolls a module back if provisioning fails midway", { skip }, async () => {
  const client = await pool.connect();
  try {
    const [u] = await mkUsers(1);
    await q("INSERT INTO wallets (user_id) VALUES ($1)", [u]);
    const failing = async (sql, params) => {
      if (/ayzen_provision_module_account/.test(sql) && params?.[1] === "ryft") throw new Error("boom");
      return client.query(sql, params);
    };
    await assert.rejects(apply(failing, { modules: ["ryft"] }), /boom/);
    assert.equal((await q("SELECT count(*)::int n FROM module_accounts WHERE user_id=$1", [u])).rows[0].n, 0);
  } finally {
    client.release();
  }
});
