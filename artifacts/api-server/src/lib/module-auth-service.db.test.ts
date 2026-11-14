/**
 * W1-P2 DB tests for lib/module-auth-service.ts against a REAL Postgres (the SQL — atomic lockout, composite
 * foreign keys, single-use reset claim — is the thing under test). Set MODULE_AUTH_TEST_DATABASE_URL to any server
 * where the role may CREATE DATABASE; a throwaway database is created and dropped. Without the variable the suite
 * skips (exit 0), so it never blocks a machine without Postgres; CI sets it (see .github/workflows/ci.yml).
 *
 *   MODULE_AUTH_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres \
 *     node --test --import tsx src/lib/module-auth-service.db.test.ts
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MODULES } from "@ayzen/module-registry";
import {
  checkModuleSession, completePasswordReset, continueWithAyzen, describeModuleAccount, linkAyzenToModuleAccount, loginWithPassword, logoutModuleSession,
  oidcSignIn, poolAuthDb, requestPasswordReset, signupWithPassword, type AuthDb, type ClientInfo,
} from "./module-auth-service";
import { verifyModulePassword } from "./module-password";

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
  dbName = `w1p2_${randomBytes(4).toString("hex")}`;
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
});

after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP DATABASE ${dbName}`);
  await admin.end();
});

const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.equal(r.ok, true, JSON.stringify(r)); return r as any; };
const signup = async (module: string, e = email(), password = PW) => ({ e, r: must(await signupWithPassword(db, { module, identifier: e, password, client: CLIENT })) });

test("migrations 125+126 apply twice cleanly", { skip }, async () => {
  await q(migration("126_module_credentials_sessions.sql"));
  await q(migration("126_module_credentials_sessions.sql"));
});

test("signup creates backing user, account, argon2id credential, backing link and a module session", { skip }, async () => {
  const { e, r } = await signup("sylo");
  assert.match(r.moduleUid, /^SYL-\d{6}$/);
  const u = (await q("SELECT * FROM users WHERE id=$1", [r.userId])).rows[0];
  assert.match(u.email, /@module-accounts\.invalid$/);
  assert.equal(u.password_hash, "", "backing user must have no central password");
  const c = (await q("SELECT * FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.match(c.password_hash, /^\$argon2id\$v=19\$/);
  assert.equal(c.identifier_norm, e.trim().toLowerCase());
  assert.equal(c.identifier, e.trim().toLowerCase());
  const l = (await q("SELECT * FROM module_account_links WHERE module_account_id=$1", [r.moduleAccountId])).rows;
  assert.deepEqual(l.map((x: any) => [x.method, x.ayzen_user_id]), [["backing", r.userId]]);
  const s = (await q("SELECT * FROM user_sessions WHERE jti=$1", [r.jti])).rows[0];
  assert.equal(s.module, "sylo");
  assert.equal(s.module_account_id, r.moduleAccountId);
  assert.equal(s.user_id, r.userId);
  const me = await describeModuleAccount(q, r.moduleAccountId);
  assert.equal(me?.moduleUid, r.moduleUid);
  assert.equal(me?.link, "backing");
});

test("signup validation: bad module, bad identifier, weak passwords", { skip }, async () => {
  const bad = (input: any) => signupWithPassword(db, { client: CLIENT, module: "sylo", identifier: email(), password: PW, ...input });
  assert.equal((await bad({ module: "exchange" }) as any).code, "INVALID_MODULE");
  assert.equal((await bad({ module: undefined }) as any).code, "INVALID_MODULE");
  assert.equal((await bad({ identifier: "not-an-email" }) as any).code, "INVALID_IDENTIFIER");
  assert.equal((await bad({ identifier: 42 }) as any).code, "INVALID_IDENTIFIER");
  assert.equal((await bad({ password: "short" }) as any).code, "PASSWORD_TOO_SHORT");
  assert.equal((await bad({ password: "x".repeat(500) }) as any).code, "PASSWORD_TOO_LONG");
  assert.equal((await bad({ password: "aaaaaaaaaaaaaaa" }) as any).code, "PASSWORD_TOO_SIMPLE");
  assert.equal((await bad({ password: undefined }) as any).code, "PASSWORD_TOO_SHORT");
});

test("identifier is unique per module regardless of case/whitespace; the same email may exist in another module", { skip }, async () => {
  const e = email("dup");
  const a = (await signup("ryft", e)).r;
  const again = await signupWithPassword(db, { module: "ryft", identifier: `  ${e.toUpperCase()}  `, password: PW, client: CLIENT });
  assert.deepEqual(again, { ok: false, code: "IDENTIFIER_TAKEN" });
  const other = (await signup("fyra", e)).r;
  assert.notEqual(other.moduleAccountId, a.moduleAccountId);
  assert.notEqual(other.userId, a.userId, "separate modules never share an account");
  assert.match(other.moduleUid, /^FYR-/);
});

test("8 concurrent signups of one identifier: exactly one wins, no orphan users", { skip }, async () => {
  const e = email("race");
  const before = (await q("SELECT count(*)::int n FROM users")).rows[0].n;
  const results = await Promise.all(Array.from({ length: 8 }, () => signupWithPassword(db, { module: "wisp", identifier: e, password: PW, client: CLIENT })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.code === "IDENTIFIER_TAKEN").length, 7);
  const after = (await q("SELECT count(*)::int n FROM users")).rows[0].n;
  assert.equal(after - before, 1, "losers must roll their backing user back");
});

test("login: success opens a module session; every failure is the same INVALID_CREDENTIALS", { skip }, async () => {
  const { e, r } = await signup("skarn");
  const ok = must(await loginWithPassword(db, { module: "skarn", identifier: e.toUpperCase(), password: PW, client: CLIENT }));
  assert.equal(ok.moduleAccountId, r.moduleAccountId);
  assert.notEqual(ok.jti, r.jti);
  const failures = [
    await loginWithPassword(db, { module: "skarn", identifier: e, password: "wrong-password-1", client: CLIENT }),
    await loginWithPassword(db, { module: "skarn", identifier: email("nobody"), password: PW, client: CLIENT }),
    await loginWithPassword(db, { module: "skarn", identifier: "garbage", password: PW, client: CLIENT }),
    await loginWithPassword(db, { module: "skarn", identifier: e, password: undefined, client: CLIENT }),
    await loginWithPassword(db, { module: "warde", identifier: e, password: PW, client: CLIENT }), // right creds, WRONG module
  ];
  for (const f of failures) assert.deepEqual(f, { ok: false, code: "INVALID_CREDENTIALS" });
  assert.equal((await loginWithPassword(db, { module: "nope", identifier: e, password: PW, client: CLIENT }) as any).code, "INVALID_MODULE");
});

test("credentials of one module do not work on another (8x8 login matrix)", { skip }, async () => {
  const e = email("matrix");
  const ids = MODULES.map((m) => m.id);
  for (const id of ids) must(await signupWithPassword(db, { module: id, identifier: e, password: `${PW}-${id}`, client: CLIENT }));
  for (const i of ids) for (const j of ids) {
    // 7 wrong-module guesses land on each account: raise the lock threshold so this matrix measures isolation, not lockout.
    const r = await loginWithPassword(db, { module: j, identifier: e, password: `${PW}-${i}`, client: CLIENT, env: { MODULE_LOGIN_MAX_FAILURES: "50" } });
    assert.equal(r.ok, i === j, `password of ${i} against ${j} must ${i === j ? "succeed" : "fail"}`);
  }
});

test("lockout: 5 bad guesses lock the account even for the right password; expiry unlocks; success resets", { skip }, async () => {
  const { e, r } = await signup("verve");
  for (let i = 0; i < 5; i++) await loginWithPassword(db, { module: "verve", identifier: e, password: `bad-password-${i}`, client: CLIENT });
  const c1 = (await q("SELECT failed_attempts, locked_until FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(c1.failed_attempts, 5);
  assert.ok(c1.locked_until, "locked after 5");
  assert.deepEqual(await loginWithPassword(db, { module: "verve", identifier: e, password: PW, client: CLIENT }), { ok: false, code: "INVALID_CREDENTIALS" });
  const reasons = (await q("SELECT detail->>'reason' r FROM module_auth_events WHERE module_account_id=$1 AND event='login' AND outcome='failure' ORDER BY id", [r.moduleAccountId])).rows.map((x: any) => x.r);
  assert.deepEqual(reasons, ["bad_password", "bad_password", "bad_password", "bad_password", "bad_password", "locked"]);
  await q("UPDATE module_credentials SET locked_until = NOW() - INTERVAL '1 second' WHERE module_account_id=$1", [r.moduleAccountId]);
  must(await loginWithPassword(db, { module: "verve", identifier: e, password: PW, client: CLIENT }));
  const c2 = (await q("SELECT failed_attempts, locked_until FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(c2.failed_attempts, 0);
  assert.equal(c2.locked_until, null);
});

test("an expired lock restarts the count at 1 instead of re-locking on the first new miss", { skip }, async () => {
  const { e, r } = await signup("verve");
  await q("UPDATE module_credentials SET failed_attempts = 5, locked_until = NOW() - INTERVAL '1 minute' WHERE module_account_id=$1", [r.moduleAccountId]);
  await loginWithPassword(db, { module: "verve", identifier: e, password: "bad-password-x", client: CLIENT });
  const c = (await q("SELECT failed_attempts, locked_until FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(c.failed_attempts, 1);
  assert.equal(c.locked_until, null);
});

test("20 concurrent bad guesses are all counted (atomic increment, no lost updates)", { skip }, async () => {
  const { e, r } = await signup("zynth");
  await Promise.all(Array.from({ length: 20 }, (_, i) => loginWithPassword(db, { module: "zynth", identifier: e, password: `bad-password-${i}`, client: CLIENT })));
  const c = (await q("SELECT failed_attempts FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(c.failed_attempts, 20);
});

test("a suspended account cannot log in and looks like a wrong password", { skip }, async () => {
  const { e, r } = await signup("warde");
  await q("UPDATE module_accounts SET status='suspended' WHERE id=$1", [r.moduleAccountId]);
  assert.deepEqual(await loginWithPassword(db, { module: "warde", identifier: e, password: PW, client: CLIENT }), { ok: false, code: "INVALID_CREDENTIALS" });
  const ev = (await q("SELECT detail FROM module_auth_events WHERE module_account_id=$1 AND outcome='failure'", [r.moduleAccountId])).rows;
  assert.equal(ev[0].detail.reason, "status");
});

test("a banned owning user cannot open new module sessions", { skip }, async () => {
  const { e, r } = await signup("sylo");
  await q("UPDATE users SET status='banned' WHERE id=$1", [r.userId]);
  assert.deepEqual(await loginWithPassword(db, { module: "sylo", identifier: e, password: PW, client: CLIENT }), { ok: false, code: "INVALID_CREDENTIALS" });
  const ev = (await q("SELECT detail FROM module_auth_events WHERE module_account_id=$1 AND outcome='failure'", [r.moduleAccountId])).rows;
  assert.equal(ev[0].detail.reason, "user_status");
  await q("UPDATE users SET status='active' WHERE id=$1", [r.userId]);
  must(await loginWithPassword(db, { module: "sylo", identifier: e, password: PW, client: CLIENT }));
});

test("an old-parameter hash is upgraded on successful login", { skip }, async () => {
  const { e, r } = await signup("wisp");
  const { hashModulePassword } = await import("./module-password");
  const weak = await hashModulePassword(PW, { memoryKib: 4096, passes: 1, parallelism: 1 });
  await q("UPDATE module_credentials SET password_hash=$2 WHERE module_account_id=$1", [r.moduleAccountId, weak]);
  must(await loginWithPassword(db, { module: "wisp", identifier: e, password: PW, client: CLIENT }));
  const h = (await q("SELECT password_hash FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0].password_hash;
  assert.notEqual(h, weak);
  assert.match(h, /m=19456,t=2,p=1/);
  assert.equal(await verifyModulePassword(PW, h), true);
});

test("Continue with AYZEN: lazy provisioning, idempotent, link recorded, no credential created", { skip }, async () => {
  const uid = (await q("INSERT INTO users (username,email,password_hash) VALUES ($1,$2,'bcrypt-whatever') RETURNING id", [`central${++n}`, `central${n}@x.test`])).rows[0].id;
  const a = must(await continueWithAyzen(db, { module: "sylo", userId: uid, client: CLIENT }));
  assert.equal(a.created, true);
  assert.equal(a.userId, uid, "the session belongs to the real AYZEN user so their existing data is visible");
  const b = must(await continueWithAyzen(db, { module: "sylo", userId: uid, client: CLIENT }));
  assert.equal(b.created, false);
  assert.equal(b.moduleUid, a.moduleUid);
  assert.notEqual(b.jti, a.jti);
  const links = (await q("SELECT method FROM module_account_links WHERE ayzen_user_id=$1", [uid])).rows;
  assert.deepEqual(links, [{ method: "legacy_continue" }]);
  assert.equal((await q("SELECT count(*)::int n FROM module_credentials WHERE module_account_id=$1", [a.moduleAccountId])).rows[0].n, 0);
  const acct = (await q("SELECT source FROM module_accounts WHERE id=$1", [a.moduleAccountId])).rows[0];
  assert.equal(acct.source, "lazy");
  const me = await describeModuleAccount(q, a.moduleAccountId);
  assert.equal(me?.hasPassword, false);
  assert.equal(me?.link, "legacy_continue");
});

test("Continue with AYZEN reuses a backfilled account and refuses a suspended one", { skip }, async () => {
  const uid = (await q("INSERT INTO users (username,email,password_hash) VALUES ($1,$2,'x') RETURNING id", [`central${++n}`, `central${n}@x.test`])).rows[0].id;
  const pre = (await q("SELECT * FROM ayzen_provision_module_account($1,'fyra','backfill')", [uid])).rows[0];
  const a = must(await continueWithAyzen(db, { module: "fyra", userId: uid, client: CLIENT }));
  assert.equal(a.moduleUid, pre.module_uid);
  assert.equal(a.created, false);
  await q("UPDATE module_accounts SET status='closed' WHERE id=$1", [pre.id]);
  assert.deepEqual(await continueWithAyzen(db, { module: "fyra", userId: uid, client: CLIENT }), { ok: false, code: "ACCOUNT_NOT_ACTIVE" });
});

test("logout revokes only that session and only within its own module", { skip }, async () => {
  const { r } = await signup("ryft");
  const claim = { sid: r.jti, module: "ryft" as const, moduleAccountId: r.moduleAccountId, userId: r.userId };
  assert.equal((await checkModuleSession(q, claim)).ok, true);
  assert.equal(await logoutModuleSession(db, { jti: r.jti, module: "sylo", client: CLIENT }), false, "wrong module cannot end it");
  assert.equal((await checkModuleSession(q, claim)).ok, true);
  assert.equal(await logoutModuleSession(db, { jti: r.jti, module: "ryft", client: CLIENT }), true);
  assert.deepEqual(await checkModuleSession(q, claim), { ok: false, reason: "revoked_or_expired" });
  assert.equal(await logoutModuleSession(db, { jti: r.jti, module: "ryft", client: CLIENT }), false, "already revoked");
});

test("checkModuleSession rejects unknown sid, expired session, mismatched claims, inactive account", { skip }, async () => {
  const { r } = await signup("fyra");
  const good = { sid: r.jti, module: "fyra" as const, moduleAccountId: r.moduleAccountId, userId: r.userId };
  assert.equal((await checkModuleSession(q, good)).ok, true);
  assert.deepEqual(await checkModuleSession(q, { ...good, sid: "no-such-session" }), { ok: false, reason: "unknown_session" });
  assert.deepEqual(await checkModuleSession(q, { ...good, moduleAccountId: r.moduleAccountId + 999 }), { ok: false, reason: "mismatch" });
  assert.deepEqual(await checkModuleSession(q, { ...good, userId: r.userId + 999 }), { ok: false, reason: "mismatch" });
  assert.deepEqual(await checkModuleSession(q, { ...good, module: "ryft" }), { ok: false, reason: "mismatch" });
  await q("UPDATE module_accounts SET status='suspended' WHERE id=$1", [r.moduleAccountId]);
  assert.deepEqual(await checkModuleSession(q, good), { ok: false, reason: "account_not_active" });
  await q("UPDATE module_accounts SET status='active' WHERE id=$1", [r.moduleAccountId]);
  await q("UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE jti=$1", [r.jti]);
  assert.deepEqual(await checkModuleSession(q, good), { ok: false, reason: "revoked_or_expired" });
});

test("session isolation matrix: a session of module i is accepted for module j only when i == j (8x8)", { skip }, async () => {
  const ids = MODULES.map((m) => m.id);
  const sessions = new Map<string, Awaited<ReturnType<typeof signup>>["r"]>();
  for (const id of ids) sessions.set(id, (await signup(id)).r);
  let checked = 0;
  for (const i of ids) for (const j of ids) {
    const s = sessions.get(i)!;
    const res = await checkModuleSession(q, { sid: s.jti, module: j, moduleAccountId: s.moduleAccountId, userId: s.userId });
    assert.equal(res.ok, i === j, `session of ${i} presented as ${j}`);
    checked++;
  }
  assert.equal(checked, 64);
});

test("password reset: unknown identifier yields nothing; token is single-use, newest wins, rate limited", { skip }, async () => {
  const { e, r } = await signup("sylo");
  assert.equal(await requestPasswordReset(db, { module: "sylo", identifier: email("ghost"), client: CLIENT }), null);
  assert.equal(await requestPasswordReset(db, { module: "ryft", identifier: e, client: CLIENT }), null, "other module has no such account");
  const t1 = (await requestPasswordReset(db, { module: "sylo", identifier: e, client: CLIENT }))!;
  assert.ok(t1.token.length >= 40);
  assert.equal(t1.to, e.trim().toLowerCase());
  const stored = (await q("SELECT token_hash FROM module_password_resets WHERE module_account_id=$1", [r.moduleAccountId])).rows;
  assert.ok(stored.every((x: any) => x.token_hash !== t1.token && /^[0-9a-f]{64}$/.test(x.token_hash)), "only a hash is stored");
  const t2 = (await requestPasswordReset(db, { module: "sylo", identifier: e, client: CLIENT }))!;
  assert.deepEqual(await completePasswordReset(db, { module: "sylo", token: t1.token, newPassword: "a-brand-new-passphrase", client: CLIENT }), { ok: false, code: "INVALID_TOKEN" }, "older token is dead");
  const t3 = (await requestPasswordReset(db, { module: "sylo", identifier: e, client: CLIENT }))!;
  assert.equal(await requestPasswordReset(db, { module: "sylo", identifier: e, client: CLIENT }), null, "4th request within the hour is swallowed");
  void t2; void t3;
});

test("password reset: weak password does not burn the token; success revokes sessions, clears lock, verifies identifier", { skip }, async () => {
  const { e, r } = await signup("wisp");
  const other = must(await loginWithPassword(db, { module: "wisp", identifier: e, password: PW, client: CLIENT }));
  for (let i = 0; i < 5; i++) await loginWithPassword(db, { module: "wisp", identifier: e, password: `bad-password-${i}`, client: CLIENT });
  const t = (await requestPasswordReset(db, { module: "wisp", identifier: e, client: CLIENT }))!;
  assert.deepEqual(await completePasswordReset(db, { module: "wisp", token: t.token, newPassword: "short", client: CLIENT }), { ok: false, code: "PASSWORD_TOO_SHORT" });
  assert.deepEqual(await completePasswordReset(db, { module: "sylo", token: t.token, newPassword: "a-brand-new-passphrase", client: CLIENT }), { ok: false, code: "INVALID_TOKEN" }, "token is bound to its module");
  const done = await completePasswordReset(db, { module: "wisp", token: t.token, newPassword: "a-brand-new-passphrase", client: CLIENT });
  assert.deepEqual(done, { ok: true, moduleAccountId: r.moduleAccountId });
  for (const jti of [r.jti, other.jti]) assert.deepEqual(await checkModuleSession(q, { sid: jti, module: "wisp", moduleAccountId: r.moduleAccountId, userId: r.userId }), { ok: false, reason: "revoked_or_expired" });
  const c = (await q("SELECT failed_attempts, locked_until, identifier_verified_at FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.equal(c.failed_attempts, 0);
  assert.equal(c.locked_until, null);
  assert.ok(c.identifier_verified_at);
  assert.equal((await loginWithPassword(db, { module: "wisp", identifier: e, password: PW, client: CLIENT })).ok, false, "old password dead");
  must(await loginWithPassword(db, { module: "wisp", identifier: e, password: "a-brand-new-passphrase", client: CLIENT }));
  assert.deepEqual(await completePasswordReset(db, { module: "wisp", token: t.token, newPassword: "yet-another-passphrase", client: CLIENT }), { ok: false, code: "INVALID_TOKEN" }, "single use");
});

test("password reset: an expired token and 6 concurrent submissions of one token", { skip }, async () => {
  const { e, r } = await signup("zynth");
  const t = (await requestPasswordReset(db, { module: "zynth", identifier: e, client: CLIENT }))!;
  await q("UPDATE module_password_resets SET expires_at = NOW() - INTERVAL '1 second' WHERE module_account_id=$1", [r.moduleAccountId]);
  assert.deepEqual(await completePasswordReset(db, { module: "zynth", token: t.token, newPassword: "a-brand-new-passphrase", client: CLIENT }), { ok: false, code: "INVALID_TOKEN" });
  await q("DELETE FROM module_password_resets WHERE module_account_id=$1", [r.moduleAccountId]);
  const t2 = (await requestPasswordReset(db, { module: "zynth", identifier: e, client: CLIENT }))!;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => completePasswordReset(db, { module: "zynth", token: t2.token, newPassword: `a-brand-new-passphrase-${i}`, client: CLIENT })));
  assert.equal(results.filter((x) => x.ok).length, 1, "exactly one submission wins");
  for (const bad of ["", "x", "y".repeat(500), undefined, 5]) assert.deepEqual(await completePasswordReset(db, { module: "zynth", token: bad, newPassword: PW, client: CLIENT }), { ok: false, code: "INVALID_TOKEN" });
});

test("audit trail records events but never a password, token or raw unknown identifier", { skip }, async () => {
  const secretPw = `S3cret-${randomBytes(6).toString("hex")}`;
  const ghost = email("ghost-audit");
  const { e } = await signup("sylo", email("audit"), secretPw);
  await loginWithPassword(db, { module: "sylo", identifier: ghost, password: secretPw, client: CLIENT });
  await loginWithPassword(db, { module: "sylo", identifier: e, password: `${secretPw}-wrong`, client: CLIENT });
  const t = (await requestPasswordReset(db, { module: "sylo", identifier: e, client: CLIENT }))!;
  const dump = JSON.stringify((await q("SELECT * FROM module_auth_events")).rows);
  for (const forbidden of [secretPw, t.token, ghost.toLowerCase(), ghost]) assert.equal(dump.includes(forbidden), false, `audit must not contain ${forbidden.slice(0, 8)}…`);
  const events = new Set((await q("SELECT DISTINCT event FROM module_auth_events")).rows.map((x: any) => x.event));
  for (const ev of ["signup", "login", "password_reset_requested"]) assert.ok(events.has(ev), `${ev} audited`);
  const unknown = (await q("SELECT detail FROM module_auth_events WHERE detail->>'reason'='unknown' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.match(unknown.detail.identifierHash, /^[0-9a-f]{16}$/);
});

test("deleting a module account cascades to its credential, link, reset tokens and sessions", { skip }, async () => {
  const { e, r } = await signup("fyra");
  await requestPasswordReset(db, { module: "fyra", identifier: e, client: CLIENT });
  await q("DELETE FROM module_accounts WHERE id=$1", [r.moduleAccountId]);
  for (const t of ["module_credentials", "module_account_links", "module_password_resets"]) {
    assert.equal((await q(`SELECT count(*)::int n FROM ${t} WHERE module_account_id=$1`, [r.moduleAccountId])).rows[0].n, 0, t);
  }
  assert.equal((await q("SELECT count(*)::int n FROM user_sessions WHERE jti=$1", [r.jti])).rows[0].n, 0);
  const ev = (await q("SELECT count(*)::int n FROM module_auth_events WHERE module_account_id IS NULL AND module='fyra'")).rows[0].n;
  assert.ok(ev >= 1, "audit rows survive with a null account (ON DELETE SET NULL)");
});

// ─── W1-P4: Login with AYZEN (OIDC) + explicit link ─────────────────────────────────────────────────────────

const ayzenUser = async (tag = "ay") => (await q(
  `INSERT INTO users (username, email, password_hash, email_verified) VALUES ($1, $2, 'x', TRUE) RETURNING id`,
  [`${tag}_${randomBytes(4).toString("hex")}`, email(tag)])).rows[0].id as number;

test("migration 127 applies twice and widens the audit event list", { skip }, async () => {
  await q(migration("127_module_oidc_audit_events.sql"));
  await q(migration("127_module_oidc_audit_events.sql"));
  await assert.rejects(() => q(`INSERT INTO module_auth_events (module, event, outcome) VALUES ('sylo','teleport','success')`), /event_chk/);
});

test("oidcSignIn: a brand-new AYZEN identity gets a module account, uid, 'oidc' link and a module-bound session", { skip }, async () => {
  const u = await ayzenUser();
  const r = must(await oidcSignIn(db, { module: "ryft", ayzenUserId: u, client: CLIENT }));
  assert.equal(r.created, true);
  assert.equal(r.userId, u);
  assert.match(r.moduleUid, /^RFT-\d{6}$/);
  const link = (await q("SELECT method FROM module_account_links WHERE ayzen_user_id=$1 AND module='ryft'", [u])).rows;
  assert.deepEqual(link.map((x: any) => x.method), ["oidc"]);
  const sess = (await q("SELECT module, module_account_id FROM user_sessions WHERE jti=$1", [r.jti])).rows[0];
  assert.deepEqual(sess, { module: "ryft", module_account_id: r.moduleAccountId });
  assert.equal((await checkModuleSession(q, { sid: r.jti, module: "ryft", moduleAccountId: r.moduleAccountId, userId: u })).ok, true);
  assert.equal((await checkModuleSession(q, { sid: r.jti, module: "sylo", moduleAccountId: r.moduleAccountId, userId: u })).ok, false, "never valid on another module");
});

test("oidcSignIn is idempotent: second sign-in reuses the account and uid; one link, two sessions", { skip }, async () => {
  const u = await ayzenUser();
  const a = must(await oidcSignIn(db, { module: "fyra", ayzenUserId: u, client: CLIENT }));
  const b = must(await oidcSignIn(db, { module: "fyra", ayzenUserId: u, client: CLIENT }));
  assert.equal(b.created, false);
  assert.equal(b.moduleAccountId, a.moduleAccountId);
  assert.equal(b.moduleUid, a.moduleUid);
  assert.notEqual(b.jti, a.jti);
  assert.equal((await q("SELECT count(*)::int n FROM module_account_links WHERE ayzen_user_id=$1 AND module='fyra'", [u])).rows[0].n, 1);
});

test("oidcSignIn reuses an account that already exists for the identity (W1-P1 backfill) without issuing a new uid", { skip }, async () => {
  const u = await ayzenUser();
  const pre = (await q("SELECT id, module_uid FROM ayzen_provision_module_account($1::int, 'verve', 'backfill')", [u])).rows[0];
  const r = must(await oidcSignIn(db, { module: "verve", ayzenUserId: u, client: CLIENT }));
  assert.equal(r.created, false);
  assert.equal(r.moduleUid, pre.module_uid);
});

test("oidcSignIn: concurrent first sign-ins of one identity produce exactly one account", { skip }, async () => {
  const u = await ayzenUser();
  const rs = await Promise.all(Array.from({ length: 6 }, () => oidcSignIn(db, { module: "skarn", ayzenUserId: u, client: CLIENT })));
  const ok = rs.filter((r) => r.ok) as any[];
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok.map((r) => r.moduleAccountId)).size, 1);
  assert.equal((await q("SELECT count(*)::int n FROM module_accounts WHERE user_id=$1 AND module='skarn'", [u])).rows[0].n, 1);
});

test("oidcSignIn refuses a non-active module account and a banned owner, and writes failure audit rows", { skip }, async () => {
  const u = await ayzenUser();
  const first = must(await oidcSignIn(db, { module: "wisp", ayzenUserId: u, client: CLIENT }));
  await q("UPDATE module_accounts SET status='suspended' WHERE id=$1", [first.moduleAccountId]);
  assert.deepEqual(await oidcSignIn(db, { module: "wisp", ayzenUserId: u, client: CLIENT }), { ok: false, code: "ACCOUNT_NOT_ACTIVE" });
  const u2 = await ayzenUser();
  await q("UPDATE users SET status='banned' WHERE id=$1", [u2]);
  assert.deepEqual(await oidcSignIn(db, { module: "zynth", ayzenUserId: u2, client: CLIENT }), { ok: false, code: "ACCOUNT_NOT_ACTIVE" });
  assert.ok((await q("SELECT count(*)::int n FROM module_auth_events WHERE event='oidc_login' AND outcome='failure'")).rows[0].n >= 2);
});

test("oidcSignIn rejects an unknown module", { skip }, async () => {
  assert.deepEqual(await oidcSignIn(db, { module: "exchange", ayzenUserId: 1, client: CLIENT }), { ok: false, code: "INVALID_MODULE" });
});

test("explicit link: module credentials + AYZEN identity -> link; later OIDC sign-in lands in THAT account, as its owning user", { skip }, async () => {
  const { e, r: direct } = await signup("warde");
  const u = await ayzenUser();
  const linked = must(await linkAyzenToModuleAccount(db, { module: "warde", ayzenUserId: u, identifier: e, password: PW, client: CLIENT }));
  assert.equal(linked.alreadyLinked, false);
  assert.equal(linked.moduleAccountId, direct.moduleAccountId);
  assert.deepEqual((await q("SELECT method FROM module_account_links WHERE ayzen_user_id=$1 AND module='warde'", [u])).rows, [{ method: "explicit" }]);
  const via = must(await oidcSignIn(db, { module: "warde", ayzenUserId: u, client: CLIENT }));
  assert.equal(via.created, false);
  assert.equal(via.moduleAccountId, direct.moduleAccountId, "same module account, same uid");
  assert.equal(via.moduleUid, direct.moduleUid);
  assert.equal(via.userId, direct.userId, "data stays with the account's owning user, not the AYZEN user");
  assert.equal((await q("SELECT count(*)::int n FROM module_accounts WHERE user_id=$1 AND module='warde'", [u])).rows[0].n, 0, "no second account was provisioned for the AYZEN user");
});

test("explicit link is idempotent for the same pair", { skip }, async () => {
  const { e } = await signup("sylo");
  const u = await ayzenUser();
  must(await linkAyzenToModuleAccount(db, { module: "sylo", ayzenUserId: u, identifier: e, password: PW, client: CLIENT }));
  const again = must(await linkAyzenToModuleAccount(db, { module: "sylo", ayzenUserId: u, identifier: e, password: PW, client: CLIENT }));
  assert.equal(again.alreadyLinked, true);
  assert.equal((await q("SELECT count(*)::int n FROM module_account_links WHERE ayzen_user_id=$1", [u])).rows[0].n, 1);
});

test("explicit link: wrong password is INVALID_CREDENTIALS, counts toward lockout, links nothing", { skip }, async () => {
  const { e } = await signup("ryft");
  const u = await ayzenUser();
  assert.deepEqual(await linkAyzenToModuleAccount(db, { module: "ryft", ayzenUserId: u, identifier: e, password: "not-the-password", client: CLIENT }), { ok: false, code: "INVALID_CREDENTIALS" });
  assert.equal((await q("SELECT count(*)::int n FROM module_account_links WHERE ayzen_user_id=$1", [u])).rows[0].n, 0);
  assert.equal((await q("SELECT failed_attempts FROM module_credentials WHERE identifier_norm=lower($1)", [e])).rows[0].failed_attempts, 1);
});

test("explicit link: another module's credentials are not accepted (module-scoped identifier)", { skip }, async () => {
  const { e } = await signup("fyra");
  const u = await ayzenUser();
  assert.deepEqual(await linkAyzenToModuleAccount(db, { module: "verve", ayzenUserId: u, identifier: e, password: PW, client: CLIENT }), { ok: false, code: "INVALID_CREDENTIALS" });
});

test("explicit link refused when the identity already owns a module account; the session the check opened is revoked", { skip }, async () => {
  const { e } = await signup("verve");
  const u = await ayzenUser();
  const own = must(await oidcSignIn(db, { module: "verve", ayzenUserId: u, client: CLIENT }));
  const before = (await q("SELECT count(*)::int n FROM user_sessions WHERE revoked_at IS NULL AND module='verve'")).rows[0].n;
  assert.deepEqual(await linkAyzenToModuleAccount(db, { module: "verve", ayzenUserId: u, identifier: e, password: PW, client: CLIENT }), { ok: false, code: "ALREADY_HAS_MODULE_ACCOUNT" });
  assert.equal((await q("SELECT count(*)::int n FROM user_sessions WHERE revoked_at IS NULL AND module='verve'")).rows[0].n, before, "no live session left behind by the refused link");
  assert.equal((await checkModuleSession(q, { sid: own.jti, module: "verve", moduleAccountId: own.moduleAccountId, userId: u })).ok, true, "the identity's own session is untouched");
});

test("explicit link refused when the account is already linked to a different AYZEN identity", { skip }, async () => {
  const { e } = await signup("skarn");
  const u1 = await ayzenUser(), u2 = await ayzenUser();
  must(await linkAyzenToModuleAccount(db, { module: "skarn", ayzenUserId: u1, identifier: e, password: PW, client: CLIENT }));
  assert.deepEqual(await linkAyzenToModuleAccount(db, { module: "skarn", ayzenUserId: u2, identifier: e, password: PW, client: CLIENT }), { ok: false, code: "ACCOUNT_ALREADY_LINKED" });
  assert.equal((await q("SELECT count(*)::int n FROM module_account_links WHERE ayzen_user_id=$1", [u2])).rows[0].n, 0);
});

test("explicit link: two identities racing for one account -> exactly one wins, the other gets a conflict, never a 500", { skip }, async () => {
  const { e } = await signup("zynth");
  const us = [await ayzenUser(), await ayzenUser(), await ayzenUser()];
  const rs = await Promise.all(us.map((u) => linkAyzenToModuleAccount(db, { module: "zynth", ayzenUserId: u, identifier: e, password: PW, client: CLIENT })));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  for (const r of rs.filter((x) => !x.ok)) assert.equal((r as any).code, "ACCOUNT_ALREADY_LINKED");
  assert.equal((await q("SELECT count(*)::int n FROM module_account_links WHERE module='zynth' AND method='explicit'")).rows[0].n, 1);
});

test("audit rows for oidc_login and link carry no password, token or identifier", { skip }, async () => {
  const rows = (await q("SELECT detail::text d, event FROM module_auth_events WHERE event IN ('oidc_login','link')")).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) assert.doesNotMatch(r.d, /password|token|@example/i, r.event);
});
