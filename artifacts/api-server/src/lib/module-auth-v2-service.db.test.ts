/**
 * DB tests for lib/module-auth-v2-service.ts against a REAL Postgres (set MODULE_AUTH_TEST_DATABASE_URL; skips otherwise).
 * Codes are read back by capturing what the service hands to the mailer (`send`), never from the database.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { poolAuthDb, loginWithPassword, type AuthDb, type ClientInfo } from "./module-auth-service";
import {
  checkCaptcha, completeCodeReset, completeLogin, completeSignup, getProfile, isReferralValid, isUsernameFree, newCaptcha, normalizeUsername,
  sendLoginEmailCode, startCodeReset, startLogin, startSignup, updateProfile, OTP_MAX_ATTEMPTS,
} from "./module-auth-v2-service";
import { generateBase32Secret, totpGenerate } from "./totp";

const adminUrl = process.env.MODULE_AUTH_TEST_DATABASE_URL;
const skip = adminUrl ? false : "MODULE_AUTH_TEST_DATABASE_URL not set";
const migration = (n: string) => readFileSync(new URL(`../../../../migrations/${n}`, import.meta.url), "utf8");
const CLIENT: ClientInfo = { ip: "203.0.113.9", userAgent: "node-test", deviceLabel: "Test device" };
const PW = "correct-horse-battery";
const ENV = { MODULE_AUTH_HMAC_SECRET: "test-secret" } as NodeJS.ProcessEnv;
const ENV_EMAIL = { ...ENV, MODULE_LOGIN_STEP_UP: "email" } as NodeJS.ProcessEnv;

let admin: any, pool: any, db: AuthDb, dbName: string, n = 0;
const q = (sql: string, params?: unknown[]) => pool.query(sql, params);
const email = () => `v2u${++n}.${randomBytes(3).toString("hex")}@example.test`;
const uname = () => `user_${++n}_${randomBytes(2).toString("hex")}`;

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  dbName = `w3v2_${randomBytes(4).toString("hex")}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(adminUrl!); u.pathname = `/${dbName}`;
  pool = new pg.Pool({ connectionString: u.toString(), max: 10 }); db = poolAuthDb(pool);
  await q(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
             role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', email_verified BOOLEAN NOT NULL DEFAULT FALSE, referral_code TEXT);
           CREATE TABLE service_table_ownership (id SERIAL PRIMARY KEY, service_key TEXT NOT NULL, table_name TEXT NOT NULL, UNIQUE(service_key, table_name));
           CREATE TABLE user_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, jti TEXT NOT NULL,
             device_label TEXT NOT NULL DEFAULT 'Unknown device', ip TEXT, user_agent TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
             last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(), revoked_at TIMESTAMP, expires_at TIMESTAMP NOT NULL, origin_client_id TEXT NULL);
           CREATE UNIQUE INDEX idx_user_sessions_jti ON user_sessions(jti);`);
  for (const m of ["125_module_accounts.sql", "126_module_credentials_sessions.sql", "127_module_oidc_audit_events.sql", "128_module_external_identities.sql", "129_module_auth_v2.sql"]) await q(migration(m));
});
after(async () => { if (skip) return; await pool.end(); await admin.query(`DROP DATABASE ${dbName}`); await admin.end(); });

const solve = (module: string) => { const c = newCaptcha(module as any, { env: ENV }); const [a, b] = c.question.split(" + ").map(Number); return { id: c.id, answer: a + b }; };
async function register(module = "fyra", extra: Record<string, unknown> = {}) {
  const e = email(), cap = solve(module);
  const s: any = await startSignup(db, { module, email: e, captchaId: cap.id, captchaAnswer: cap.answer, client: CLIENT, env: ENV });
  assert.equal(s.ok, true, JSON.stringify(s)); assert.ok(s.send, "free email gets a code");
  const username = uname();
  const r: any = await completeSignup(db, { module, email: e, code: s.send.code, password: PW, username, client: CLIENT, env: ENV, profile: { firstName: "Ada", lastName: "L" }, ...extra });
  return { e, username, r, code: s.send.code };
}

test("migration 129 applies twice", { skip }, async () => { await q(migration("129_module_auth_v2.sql")); await q(migration("129_module_auth_v2.sql")); });

test("captcha: right answer passes; wrong, expired, other module, tampered all fail", { skip }, () => {
  const c = newCaptcha("fyra", { env: ENV, now: 1_000_000 });
  const [a, b] = c.question.split(" + ").map(Number);
  assert.ok(checkCaptcha("fyra", c.id, a + b, { env: ENV, now: 1_000_000 }));
  assert.ok(checkCaptcha("fyra", c.id, String(a + b), { env: ENV, now: 1_000_000 }));
  assert.ok(!checkCaptcha("fyra", c.id, a + b + 1, { env: ENV, now: 1_000_000 }));
  assert.ok(!checkCaptcha("fyra", c.id, a + b, { env: ENV, now: 1_000_000 + 301_000 }));
  assert.ok(!checkCaptcha("wisp", c.id, a + b, { env: ENV, now: 1_000_000 }));
  assert.ok(!checkCaptcha("fyra", c.id + "x", a + b, { env: ENV, now: 1_000_000 }));
  assert.ok(!checkCaptcha("fyra", c.id, a + b, { env: { MODULE_AUTH_HMAC_SECRET: "other" } as any, now: 1_000_000 }));
});

test("sign-up: code -> verified account + profile + session; code is single-use", { skip }, async () => {
  const { e, username, r, code } = await register();
  assert.equal(r.ok, true, JSON.stringify(r));
  const c = (await q("SELECT identifier_verified_at FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0];
  assert.ok(c.identifier_verified_at);
  const p: any = await getProfile(pool.query.bind(pool), r.moduleAccountId);
  assert.equal(p.username, username); assert.equal(p.displayName, "Ada L");
  const again: any = await completeSignup(db, { module: "fyra", email: e, code, password: PW, username: uname(), client: CLIENT, env: ENV });
  assert.deepEqual([again.ok, again.code], [false, "INVALID_CODE"]);
  const stored = (await q("SELECT code_hash FROM module_otps WHERE identifier_norm=$1", [e])).rows[0].code_hash;
  assert.ok(!stored.includes(code) && stored.length === 64, "code stored only as a hash");
});

test("sign-up refuses bad captcha, wrong code (attempt cap), taken username, bad referral, weak password — and a typo does not burn the code", { skip }, async () => {
  const e = email(), cap = solve("fyra");
  assert.equal(((await startSignup(db, { module: "fyra", email: e, captchaId: cap.id, captchaAnswer: 0, client: CLIENT, env: ENV })) as any).code, "INVALID_CAPTCHA");
  const s: any = await startSignup(db, { module: "fyra", email: e, captchaId: cap.id, captchaAnswer: cap.answer, client: CLIENT, env: ENV });
  const base = { module: "fyra", email: e, password: PW, client: CLIENT, env: ENV };
  assert.equal(((await completeSignup(db, { ...base, code: s.send.code, username: "ab" })) as any).code, "USERNAME_INVALID");
  assert.equal(((await completeSignup(db, { ...base, code: s.send.code, username: uname(), password: "short" })) as any).code, "PASSWORD_TOO_SHORT");
  assert.equal(((await completeSignup(db, { ...base, code: s.send.code, username: uname(), referral: "NOPE-REF" })) as any).code, "REFERRAL_INVALID");
  const taken = (await register()).username;
  assert.equal(((await completeSignup(db, { ...base, code: s.send.code, username: taken })) as any).code, "USERNAME_TAKEN");
  const wrong = s.send.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) assert.equal(((await completeSignup(db, { ...base, code: wrong, username: uname() })) as any).code, "INVALID_CODE");
  assert.equal(((await completeSignup(db, { ...base, code: s.send.code, username: uname() })) as any).code, "INVALID_CODE", "attempt cap voids the code");
});

test("typos before the code check leave the code usable", { skip }, async () => {
  const e = email(), cap = solve("fyra");
  const s: any = await startSignup(db, { module: "fyra", email: e, captchaId: cap.id, captchaAnswer: cap.answer, client: CLIENT, env: ENV });
  await completeSignup(db, { module: "fyra", email: e, code: s.send.code, password: "short", username: uname(), client: CLIENT, env: ENV });
  const ok: any = await completeSignup(db, { module: "fyra", email: e, code: s.send.code, password: PW, username: uname(), client: CLIENT, env: ENV });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("existing email: start answers ok with no code (no enumeration); usernames are per module; referral validates against users", { skip }, async () => {
  const { e } = await register("fyra");
  const cap = solve("fyra");
  const s: any = await startSignup(db, { module: "fyra", email: e, captchaId: cap.id, captchaAnswer: cap.answer, client: CLIENT, env: ENV });
  assert.deepEqual([s.ok, s.send], [true, null]);
  const un = uname(); const a: any = await register("fyra");
  assert.equal(((await isUsernameFree(db.query, "fyra", a.username)) as any).available, false);
  assert.equal(((await isUsernameFree(db.query, "wisp", a.username)) as any).available, true);
  assert.equal(((await isUsernameFree(db.query, "fyra", "@" + un.toUpperCase())) as any).username, un);
  await q("INSERT INTO users (username,email,password_hash,referral_code) VALUES ('ref1','ref1@x.test','h','AYZ-REF1')");
  assert.ok(await isReferralValid(db.query, "AYZ-REF1")); assert.ok(!await isReferralValid(db.query, "AYZ-NOPE"));
  assert.equal(normalizeUsername("A b"), null);
});

test("sign-up with a valid referral records it", { skip }, async () => {
  await q("INSERT INTO users (username,email,password_hash,referral_code) VALUES ('ref2','ref2@x.test','h','AYZ-REF2')").catch(() => {});
  const { r } = await register("wisp", { referral: "AYZ-REF2" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await q("SELECT referral_code_used FROM module_profiles WHERE module_account_id=$1", [r.moduleAccountId])).rows[0].referral_code_used, "AYZ-REF2");
});

test("login: default = direct session; email step-up mode = challenge + emailed code; wrong code refused, right code opens session", { skip }, async () => {
  const { e } = await register("fyra");
  const direct: any = await startLogin(db, { module: "fyra", email: e, password: PW, client: CLIENT, env: ENV });
  assert.equal(direct.ok, true, JSON.stringify(direct)); assert.ok(direct.jti && !direct.stepUp);
  const st: any = await startLogin(db, { module: "fyra", email: e, password: PW, client: CLIENT, env: ENV_EMAIL });
  assert.ok(st.stepUp && !st.jti && st.stepUp.methods.join() === "email" && st.stepUp.send.code);
  assert.equal(((await completeLogin(db, { module: "fyra", challenge: st.stepUp.challenge, code: "000000", client: CLIENT, env: ENV })) as any).code, "INVALID_CODE");
  const done: any = await completeLogin(db, { module: "fyra", challenge: st.stepUp.challenge, code: st.stepUp.send.code, client: CLIENT, env: ENV });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(done.module, "fyra");
  const reuse: any = await completeLogin(db, { module: "fyra", challenge: st.stepUp.challenge, code: st.stepUp.send.code, client: CLIENT, env: ENV });
  assert.equal(reuse.code, "INVALID_CODE", "code single-use");
  assert.equal(((await completeLogin(db, { module: "wisp", challenge: st.stepUp.challenge, code: "123456", client: CLIENT, env: ENV })) as any).code, "CHALLENGE_INVALID", "other module");
  assert.equal(((await startLogin(db, { module: "fyra", email: e, password: "nope-nope-nope", client: CLIENT, env: ENV_EMAIL })) as any).code, "INVALID_CREDENTIALS");
});

test("login: enrolled authenticator is always challenged; TOTP opens session; email fallback is offered on demand; hash is not clobbered", { skip }, async () => {
  const { e, r } = await register("skarn");
  const secret = generateBase32Secret();
  await q("UPDATE module_credentials SET mfa_enabled=TRUE, mfa_secret=$2 WHERE module_account_id=$1", [r.moduleAccountId, secret]);
  const before = (await q("SELECT password_hash FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0].password_hash;
  const st: any = await startLogin(db, { module: "skarn", email: e, password: PW, client: CLIENT, env: ENV });
  assert.deepEqual(st.stepUp.methods, ["totp", "email"]); assert.equal(st.stepUp.send, null);
  assert.equal(((await completeLogin(db, { module: "skarn", challenge: st.stepUp.challenge, code: "000000", client: CLIENT, env: ENV })) as any).ok, false);
  const ok: any = await completeLogin(db, { module: "skarn", challenge: st.stepUp.challenge, code: totpGenerate(secret), client: CLIENT, env: ENV });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const mail: any = await sendLoginEmailCode(db, { module: "skarn", challenge: st.stepUp.challenge, client: CLIENT, env: ENV });
  assert.equal(((await completeLogin(db, { module: "skarn", challenge: st.stepUp.challenge, code: mail.send.code, client: CLIENT, env: ENV })) as any).ok, true);
  assert.equal((await q("SELECT password_hash FROM module_credentials WHERE module_account_id=$1", [r.moduleAccountId])).rows[0].password_hash, before);
  assert.equal(((await loginWithPassword(db, { module: "skarn", identifier: e, password: PW, client: CLIENT })) as any).ok, true);
  assert.ok(Number((await q("SELECT count(*) FROM module_auth_events WHERE event='step_up'")).rows[0].count) >= 3);
});

test("a step-up challenge for a banned owner is dead", { skip }, async () => {
  const { e, r } = await register("fyra");
  const st: any = await startLogin(db, { module: "fyra", email: e, password: PW, client: CLIENT, env: ENV_EMAIL });
  await q("UPDATE users SET status='banned' WHERE id=$1", [r.userId]);
  assert.equal(((await completeLogin(db, { module: "fyra", challenge: st.stepUp.challenge, code: st.stepUp.send.code, client: CLIENT, env: ENV })) as any).code, "CHALLENGE_INVALID");
});

test("code reset: unknown email gives nothing; code resets password, revokes sessions, single-use; weak password keeps code", { skip }, async () => {
  assert.equal((await startCodeReset(db, { module: "fyra", email: "nobody@example.test", client: CLIENT, env: ENV })).send, null);
  const { e, r } = await register("fyra");
  const s = await startCodeReset(db, { module: "fyra", email: e, client: CLIENT, env: ENV });
  assert.ok(s.send);
  assert.equal(((await completeCodeReset(db, { module: "fyra", email: e, code: s.send!.code, newPassword: "short", client: CLIENT, env: ENV })) as any).code, "PASSWORD_TOO_SHORT");
  const NEW = "brand-new-passphrase-1";
  assert.equal(((await completeCodeReset(db, { module: "wisp", email: e, code: s.send!.code, newPassword: NEW, client: CLIENT, env: ENV })) as any).ok, false, "other module");
  assert.equal(((await completeCodeReset(db, { module: "fyra", email: e, code: s.send!.code, newPassword: NEW, client: CLIENT, env: ENV })) as any).ok, true);
  assert.equal(((await completeCodeReset(db, { module: "fyra", email: e, code: s.send!.code, newPassword: NEW + "2", client: CLIENT, env: ENV })) as any).ok, false);
  assert.equal(((await loginWithPassword(db, { module: "fyra", identifier: e, password: NEW, client: CLIENT })) as any).ok, true);
  assert.equal(((await loginWithPassword(db, { module: "fyra", identifier: e, password: PW, client: CLIENT })) as any).ok, false);
  assert.equal(Number((await q("SELECT count(*) FROM user_sessions WHERE module_account_id=$1 AND revoked_at IS NULL AND created_at < NOW()-INTERVAL '0 seconds' AND jti=$2", [r.moduleAccountId, r.jti])).rows[0].count), 0, "old session revoked");
});

test("issuing codes is capped per hour and per address", { skip }, async () => {
  const e = email(); let last: any;
  for (let i = 0; i < 6; i++) { const cap = solve("fyra"); last = await startSignup(db, { module: "fyra", email: e, captchaId: cap.id, captchaAnswer: cap.answer, client: CLIENT, env: ENV }); }
  assert.equal(last.code, "TOO_MANY_CODES");
});

test("profile: update is scoped to the account and module, audited; no profile row -> refused", { skip }, async () => {
  const { r } = await register("fyra");
  assert.deepEqual(await updateProfile(db, { module: "fyra", moduleAccountId: r.moduleAccountId, profile: { firstName: "Grace", location: "Dhaka", links: ["https://a.test", "javascript:x"] }, client: CLIENT }), { ok: true });
  const p: any = await getProfile(pool.query.bind(pool), r.moduleAccountId);
  assert.deepEqual([p.firstName, p.location, p.links], ["Grace", "Dhaka", ["https://a.test"]]);
  assert.equal(((await updateProfile(db, { module: "wisp", moduleAccountId: r.moduleAccountId, profile: {}, client: CLIENT })) as any).ok, false);
  assert.equal((await q("SELECT count(*)::int n FROM module_auth_events WHERE event='profile_updated'")).rows[0].n >= 1, true);
});

test("audit rows never contain codes, passwords or emails", { skip }, async () => {
  const rows = (await q("SELECT detail::text d FROM module_auth_events WHERE event IN ('step_up','signup','password_reset_completed','profile_updated')")).rows;
  for (const r of rows) assert.doesNotMatch(r.d, /password|\b\d{6}\b|@example/i);
});
