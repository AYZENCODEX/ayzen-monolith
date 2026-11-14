/**
 * W1-P5 DB tests for lib/module-clerk-service.ts against a REAL Postgres (the SQL — atomic lockout, composite
 * foreign keys, single-use reset claim — is the thing under test). Set MODULE_AUTH_TEST_DATABASE_URL to any server
 * where the role may CREATE DATABASE; a throwaway database is created and dropped. Without the variable the suite
 * skips (exit 0), so it never blocks a machine without Postgres; CI sets it (see .github/workflows/ci.yml).
 *
 *   MODULE_AUTH_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres \
 *     node --test --import tsx src/lib/module-clerk-service.db.test.ts
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MODULES } from "@ayzen/module-registry";
import { checkModuleSession, poolAuthDb, signupWithPassword, type AuthDb, type ClientInfo } from "./module-auth-service";
import { clerkSignIn, clerkUserCreated, clerkUserDeleted } from "./module-clerk-service";

const adminUrl = process.env.MODULE_AUTH_TEST_DATABASE_URL;
const skip = adminUrl ? false : "MODULE_AUTH_TEST_DATABASE_URL not set";
const migration = (n: string) => readFileSync(new URL(`../../../../migrations/${n}`, import.meta.url), "utf8");

const CLIENT: ClientInfo = { ip: "203.0.113.7", userAgent: "node-test", deviceLabel: "Test device" };
const PW = "correct-horse-battery";
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

let admin: any, pool: any, db: AuthDb, dbName: string;
const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
let n = 0;
const email = (tag = "u") => `${tag}${++n}.${randomBytes(3).toString("hex")}@Example.TEST`;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  dbName = `w1p5_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = new pg.Pool({ connectionString: withDb(adminUrl!, dbName), max: 12 });
  db = poolAuthDb(pool);
  // Minimal stand-ins with the same columns production has for the tables the migrations extend.
  await q(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
             role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', email_verified BOOLEAN NOT NULL DEFAULT FALSE);
           CREATE TABLE service_table_ownership (id SERIAL PRIMARY KEY, service_key TEXT NOT NULL, table_name TEXT NOT NULL, UNIQUE(service_key, table_name));
           CREATE TABLE user_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, jti TEXT NOT NULL,
             device_label TEXT NOT NULL DEFAULT 'Unknown device', ip TEXT, user_agent TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
             last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(), revoked_at TIMESTAMP, expires_at TIMESTAMP NOT NULL, origin_client_id TEXT NULL);
           CREATE UNIQUE INDEX idx_user_sessions_jti ON user_sessions(jti);`);
  await q(migration("125_module_accounts.sql"));
  await q(migration("126_module_credentials_sessions.sql"));
  await q(migration("127_module_oidc_audit_events.sql"));
  await q(migration("128_module_external_identities.sql"));
});

after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP DATABASE ${dbName}`);
  await admin.end();
});

const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.equal(r.ok, true, JSON.stringify(r)); return r as any; };
const signup = async (module: string, e = email(), password = PW) => ({ e, r: must(await signupWithPassword(db, { module, identifier: e, password, client: CLIENT })) });


const claim = (r: any, module: string) => ({ sid: r.jti, module, moduleAccountId: r.moduleAccountId, userId: r.userId }) as any;
const cid = () => `user_${randomBytes(8).toString("hex")}`;

test("migration 128 applies twice cleanly", { skip }, async () => {
  await q(migration("128_module_external_identities.sql"));
  await q(migration("128_module_external_identities.sql"));
});

test("first social sign-in creates backing user, account, backing link, identity and a module session", { skip }, async () => {
  const id = cid();
  const r = must(await clerkSignIn(db, { module: "sylo", clerkUserId: id, email: "A@Example.test", emailVerified: true, client: CLIENT }));
  assert.equal(r.created, true);
  assert.match(r.moduleUid, /^SYL-\d{6}$/);
  const u = (await q("SELECT * FROM users WHERE id=$1", [r.userId])).rows[0];
  assert.match(u.email, /@module-accounts\.invalid$/);
  assert.equal(u.password_hash, "");
  const i = (await q("SELECT * FROM module_external_identities WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(i.external_id, id); assert.equal(i.module, "sylo"); assert.equal(i.provider, "clerk"); assert.equal(i.email_verified, true);
  assert.equal((await q("SELECT 1 FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rowCount, 0, "social-only account has no password credential");
  const s = await checkModuleSession(q, claim(r, "sylo"));
  assert.equal(s.ok, true);
});

test("second sign-in of the same Clerk user reuses the account", { skip }, async () => {
  const id = cid();
  const a = must(await clerkSignIn(db, { module: "ryft", clerkUserId: id, client: CLIENT, emailVerified: false }));
  const b = must(await clerkSignIn(db, { module: "ryft", clerkUserId: id, client: CLIENT, emailVerified: false }));
  assert.equal(b.created, false);
  assert.equal(b.moduleAccountId, a.moduleAccountId);
  assert.notEqual(a.jti, b.jti);
});

test("same Clerk id string in two modules is two unrelated accounts", { skip }, async () => {
  const id = cid();
  const a = must(await clerkSignIn(db, { module: "sylo", clerkUserId: id, client: CLIENT, emailVerified: false }));
  const b = must(await clerkSignIn(db, { module: "fyra", clerkUserId: id, client: CLIENT, emailVerified: false }));
  assert.notEqual(a.moduleAccountId, b.moduleAccountId);
  assert.notEqual(a.userId, b.userId);
});

test("verified email of an existing password account in the same module is refused, nothing is created", { skip }, async () => {
  const { e } = await (async () => { const e = email(); await signupWithPassword(db, { module: "verve", identifier: e, password: PW, client: CLIENT }); return { e }; })();
  const before = (await q("SELECT count(*)::int c FROM module_accounts")).rows[0].c;
  const r = await clerkSignIn(db, { module: "verve", clerkUserId: cid(), email: e, emailVerified: true, client: CLIENT });
  assert.deepEqual(r, { ok: false, code: "EMAIL_ACCOUNT_EXISTS" });
  assert.equal((await q("SELECT count(*)::int c FROM module_accounts")).rows[0].c, before);
});

test("unverified email never blocks nor links; same email in ANOTHER module is unaffected", { skip }, async () => {
  const e = email(); await signupWithPassword(db, { module: "skarn", identifier: e, password: PW, client: CLIENT });
  must(await clerkSignIn(db, { module: "skarn", clerkUserId: cid(), email: e, emailVerified: false, client: CLIENT }));
  must(await clerkSignIn(db, { module: "warde", clerkUserId: cid(), email: e, emailVerified: true, client: CLIENT }));
});

test("racing first sign-ins of one Clerk user -> one account, no 500", { skip }, async () => {
  const id = cid();
  const rs = await Promise.all(Array.from({ length: 6 }, () => clerkSignIn(db, { module: "wisp", clerkUserId: id, client: CLIENT, emailVerified: false })));
  for (const r of rs) must(r);
  assert.equal(new Set(rs.map((r: any) => r.moduleAccountId)).size, 1);
  assert.equal((await q("SELECT count(*)::int c FROM module_external_identities WHERE external_id=$1", [id])).rows[0].c, 1);
});

test("suspended account or banned owner cannot sign in", { skip }, async () => {
  const id = cid();
  const r = must(await clerkSignIn(db, { module: "zynth", clerkUserId: id, client: CLIENT, emailVerified: false }));
  await q("UPDATE module_accounts SET status='suspended' WHERE id=$1", [r.moduleAccountId]);
  assert.deepEqual(await clerkSignIn(db, { module: "zynth", clerkUserId: id, client: CLIENT, emailVerified: false }), { ok: false, code: "ACCOUNT_NOT_ACTIVE" });
  await q("UPDATE module_accounts SET status='active' WHERE id=$1", [r.moduleAccountId]);
  await q("UPDATE users SET status='banned' WHERE id=$1", [r.userId]);
  assert.deepEqual(await clerkSignIn(db, { module: "zynth", clerkUserId: id, client: CLIENT, emailVerified: false }), { ok: false, code: "ACCOUNT_NOT_ACTIVE" });
});

test("bad input: unknown module and malformed Clerk id", { skip }, async () => {
  assert.deepEqual(await clerkSignIn(db, { module: "nope", clerkUserId: cid(), client: CLIENT }), { ok: false, code: "INVALID_MODULE" });
  assert.deepEqual(await clerkSignIn(db, { module: "sylo", clerkUserId: "x'; DROP", client: CLIENT }), { ok: false, code: "INVALID_TOKEN" });
  await assert.rejects(q(`INSERT INTO module_external_identities (module_account_id, module, external_id) VALUES (1,'sylo','not-a-clerk-id')`));
});

test("webhook user.created is idempotent and shares the account with a later sign-in", { skip }, async () => {
  const id = cid();
  const a = must(await clerkUserCreated(db, { module: "sylo", clerkUserId: id, email: "w@example.test", emailVerified: true }));
  const b = must(await clerkUserCreated(db, { module: "sylo", clerkUserId: id }));
  assert.equal(a.created, true); assert.equal(b.created, false);
  const s = must(await clerkSignIn(db, { module: "sylo", clerkUserId: id, client: CLIENT, emailVerified: false }));
  assert.equal(s.created, false);
});

test("webhook user.deleted closes the account, revokes sessions, drops identity; repeat is a no-op; other modules untouched", { skip }, async () => {
  const id = cid();
  const a = must(await clerkSignIn(db, { module: "sylo", clerkUserId: id, client: CLIENT, emailVerified: false }));
  const other = must(await clerkSignIn(db, { module: "ryft", clerkUserId: id, client: CLIENT, emailVerified: false }));
  const d = must(await clerkUserDeleted(db, { module: "sylo", clerkUserId: id }));
  assert.equal(d.closed, true); assert.equal(d.sessionsRevoked, 1);
  assert.equal((await q("SELECT status FROM module_accounts WHERE id=$1", [a.moduleAccountId])).rows[0].status, "closed");
  assert.equal((await checkModuleSession(q, claim(a, "sylo"))).ok, false);
  assert.equal((await checkModuleSession(q, claim(other, "ryft"))).ok, true);
  assert.equal(must(await clerkUserDeleted(db, { module: "sylo", clerkUserId: id })).closed, false);
  // a deleted Clerk id that signs in again is a NEW account (the old one stays closed)
  const again = must(await clerkSignIn(db, { module: "sylo", clerkUserId: id, client: CLIENT, emailVerified: false }));
  assert.notEqual(again.moduleAccountId, a.moduleAccountId);
});

test("audit rows for clerk events carry no token and no email", { skip }, async () => {
  const id = cid();
  await clerkSignIn(db, { module: "fyra", clerkUserId: id, email: "secret-mail@example.test", emailVerified: true, client: CLIENT });
  await clerkUserDeleted(db, { module: "fyra", clerkUserId: id });
  const rows = (await q("SELECT event, outcome, detail::text d FROM module_auth_events WHERE event LIKE 'clerk_%'")).rows;
  assert.ok(rows.some((r: any) => r.event === "clerk_login") && rows.some((r: any) => r.event === "clerk_user_deleted"));
  for (const r of rows) assert.ok(!/secret-mail|user_[0-9a-f]{16}/.test(r.d), r.d);
});

test("deleting a module account cascades its identity", { skip }, async () => {
  const id = cid();
  const r = must(await clerkSignIn(db, { module: "wisp", clerkUserId: id, client: CLIENT, emailVerified: false }));
  await q("DELETE FROM user_sessions WHERE module_account_id=$1", [r.moduleAccountId]).catch(() => {});
  await q("DELETE FROM module_auth_events WHERE module_account_id=$1", [r.moduleAccountId]).catch(() => {});
  await q("DELETE FROM module_accounts WHERE id=$1", [r.moduleAccountId]);
  assert.equal((await q("SELECT 1 FROM module_external_identities WHERE external_id=$1", [id])).rowCount, 0);
});
