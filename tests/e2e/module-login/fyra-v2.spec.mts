/**
 * Browser check: Fyra's OWN designed login page against the real module-auth v2 service on a real Postgres.
 * The design file is untouched; the injected adapter (login-adapters.mjs) maps its calls to /api/auth/module/v2/*.
 * A thin HTTP layer stands in for the Express router (same service calls, same JSON contract); e-mails land in an outbox.
 *
 *   MODULE_AUTH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node --import tsx tests/e2e/module-login/fyra-v2.spec.mts
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
import { designedLoginHtml } from "../../../packages/module-registry/src/landing-designs.mjs";
import { poolAuthDb, signupWithPassword, loginWithPassword } from "../../../artifacts/api-server/src/lib/module-auth-service";
import * as V2 from "../../../artifacts/api-server/src/lib/module-auth-v2-service";

const adminUrl = process.env.MODULE_AUTH_TEST_DATABASE_URL;
if (!adminUrl) { console.log("SKIP MODULE_AUTH_TEST_DATABASE_URL not set"); process.exit(0); }
const fail = (m: string): never => { console.error("FAIL " + m); process.exit(1); };
const mig = (n: string) => readFileSync(new URL(`../../../migrations/${n}`, import.meta.url), "utf8");
const MODULE = "fyra" as const;
const PW = "correct-horse-battery";

// ── database ──
const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
const dbName = `e2e_${randomBytes(4).toString("hex")}`; await admin.query(`CREATE DATABASE ${dbName}`);
const u = new URL(adminUrl); u.pathname = `/${dbName}`;
const pool = new pg.Pool({ connectionString: u.toString(), max: 8 }); const db = poolAuthDb(pool as any);
await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', email_verified BOOLEAN NOT NULL DEFAULT FALSE, referral_code TEXT);
  CREATE TABLE service_table_ownership (id SERIAL PRIMARY KEY, service_key TEXT NOT NULL, table_name TEXT NOT NULL, UNIQUE(service_key, table_name));
  CREATE TABLE user_sessions (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, jti TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT 'Unknown device', ip TEXT, user_agent TEXT, created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(), revoked_at TIMESTAMP, expires_at TIMESTAMP NOT NULL, origin_client_id TEXT NULL);
  CREATE UNIQUE INDEX idx_user_sessions_jti ON user_sessions(jti);`);
for (const m of ["125_module_accounts.sql", "126_module_credentials_sessions.sql", "127_module_oidc_audit_events.sql", "128_module_external_identities.sql", "129_module_auth_v2.sql"]) await pool.query(mig(m));

// ── API stand-in ──
const outbox: Array<{ to: string; code: string; what: string }> = [];
const CLIENT = { ip: "127.0.0.1", userAgent: "e2e", deviceLabel: "e2e" };
const hits: string[] = [];
const ok = (res: http.ServerResponse, code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const STATUS: Record<string, number> = { INVALID_CODE: 400, CHALLENGE_INVALID: 400, INVALID_CREDENTIALS: 401, TOO_MANY_CODES: 429, USERNAME_TAKEN: 409 };
const bad = (res: http.ServerResponse, f: any) => ok(res, STATUS[f.code] ?? 400, { error: "Request rejected", code: f.code, solution: f.code === "PASSWORD_TOO_SHORT" ? "Use at least 10 characters." : undefined });
const sess = (s: any, email?: string) => ({ token: "tok." + s.jti, account: { module: s.module, moduleUid: s.moduleUid, identifier: email } });
const api = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*"); res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("access-control-allow-methods", "POST,GET,OPTIONS");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", async () => {
    hits.push(`${req.method} ${req.url}`);
    try {
      const b = raw ? JSON.parse(raw) : {}; const p = req.url!.replace(/^\/api\/auth\/module\/v2/, "");
      if (p === "/signup/start") { const r: any = await V2.startSignup(db, { module: MODULE, email: b.email, captchaId: b.captcha?.id, captchaAnswer: b.captcha?.answer, client: CLIENT }); if (!r.ok) return bad(res, r); if (r.send) outbox.push({ ...r.send, what: "signup" }); return ok(res, 202, {}); }
      if (p === "/signup/complete") { const r: any = await V2.completeSignup(db, { module: MODULE, email: b.email, code: b.code, password: b.password, username: b.username, client: CLIENT }); return r.ok ? ok(res, 201, sess(r, b.email)) : bad(res, r); }
      if (p === "/login") { const r: any = await V2.startLogin(db, { module: MODULE, email: b.email, password: b.password, client: CLIENT, requireCode: b.requireCode === true }); if (!r.ok) return bad(res, r); if (r.stepUp) { if (r.stepUp.send) outbox.push({ ...r.stepUp.send, what: "login" }); return ok(res, 200, { stepUp: { challenge: r.stepUp.challenge, methods: r.stepUp.methods } }); } return ok(res, 200, sess(r, b.email)); }
      if (p === "/login/email-code") { const r: any = await V2.sendLoginEmailCode(db, { module: MODULE, challenge: b.challenge, client: CLIENT }); if (!r.ok) return bad(res, r); outbox.push({ ...r.send, what: "login" }); return ok(res, 202, {}); }
      if (p === "/login/verify") { const r: any = await V2.completeLogin(db, { module: MODULE, challenge: b.challenge, code: b.code, client: CLIENT }); return r.ok ? ok(res, 200, sess(r)) : bad(res, r); }
      if (p === "/reset/request") { const r = await V2.startCodeReset(db, { module: MODULE, email: b.email, client: CLIENT }); if (r.send) outbox.push({ ...r.send, what: "reset" }); return ok(res, 202, {}); }
      if (p === "/reset/confirm") { const r: any = await V2.completeCodeReset(db, { module: MODULE, email: b.email, code: b.code, newPassword: b.password, client: CLIENT }); return r.ok ? ok(res, 200, {}) : bad(res, r); }
      ok(res, 404, { error: "no route " + req.url });
    } catch (e) { console.error(e); ok(res, 500, { error: "boom" }); }
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const apiOrigin = `http://127.0.0.1:${(api.address() as any).port}`;
const site = http.createServer((req, res) => {
  const pth = new URL(req.url!, "http://x").pathname; res.setHeader("content-type", "text/html");
  res.end(pth === "/login" ? designedLoginHtml(MODULE, { apiOrigin })! : `<!doctype html><title>stub ${pth}</title>`);
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(site.address() as any).port}`;

// ── browser ──
const browser = await chromium.launch();
async function fresh() {
  const ctx = await browser.newContext(); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage(); await page.goto(`${origin}/login?next=/finance/dashboard`); return { ctx, page };
}
const digits = async (page: any, code: string, scope = "") => { const boxes = page.locator(`${scope} .otp input`); for (let i = 0; i < 6; i++) await boxes.nth(i).fill(code[i]); };
const lastCode = (to: string, what: string) => [...outbox].reverse().find((m) => m.to === to && m.what === what)?.code ?? fail(`no ${what} mail for ${to}`);
const tokenOf = (page: any) => page.evaluate(() => localStorage.getItem("ayzen_token") || sessionStorage.getItem("ayzen_token"));

try {
  // 1) sign up: username + email + password -> emailed code -> account
  {
    const { ctx, page } = await fresh(); const em = `new.${randomBytes(3).toString("hex")}@example.test`;
    await page.click('[data-v="up.form"]'); await page.fill("#u", "fyra_user1"); await page.fill("#e", em); await page.fill("#p", PW);
    await page.click('form[data-f="signup"] .b1'); await page.waitForSelector("text=Verify your email");
    await digits(page, "000000"); await page.click("#vb");
    await page.waitForSelector("#er:not(:empty)"); // wrong code: refused, stays on the screen
    const code = lastCode(em, "signup"); await digits(page, code); await page.click("#vb");
    await page.waitForFunction(() => location.pathname === "/finance/dashboard", null, { timeout: 8000 });
    const tok = await tokenOf(page); if (!tok || !String(tok).startsWith("tok.")) fail("sign-up stored no module token: " + tok);
    const c = (await pool.query("SELECT identifier_verified_at FROM module_credentials WHERE identifier_norm=$1", [em])).rows[0]; if (!c?.identifier_verified_at) fail("mailbox not marked verified");
    const prof = (await pool.query("SELECT username FROM module_profiles WHERE username_norm='fyra_user1'")).rows[0]; if (!prof) fail("profile row missing");
    await ctx.close(); console.log("ok  sign-up with emailed code creates a verified account + profile and lands on ?next=");
  }
  // 2) sign in: password, then the emailed code (design's step screen), then session
  {
    const em = `login.${randomBytes(3).toString("hex")}@example.test`;
    const su: any = await signupWithPassword(db, { module: MODULE, identifier: em, password: PW, client: CLIENT }); if (!su.ok) fail("seed signup");
    const { ctx, page } = await fresh();
    await page.fill("#e", em); await page.fill("#p", "wrong-password-x"); await page.click('form[data-f="login"] .b1');
    await page.waitForSelector("#er:not(:empty)"); if (await tokenOf(page)) fail("token stored after wrong password");
    await page.fill("#p", PW); await page.click('form[data-f="login"] .b1'); await page.waitForSelector("text=Confirm it");
    if (await tokenOf(page)) fail("token stored before the code step");
    await digits(page, "111111"); await page.click("#vb"); await page.waitForSelector("#er:not(:empty)");
    await digits(page, lastCode(em, "login")); await page.click("#vb");
    await page.waitForFunction(() => location.pathname === "/finance/dashboard", null, { timeout: 8000 });
    if (!String(await tokenOf(page)).startsWith("tok.")) fail("no token after code");
    const v = (await pool.query("SELECT identifier_verified_at FROM module_credentials WHERE identifier_norm=$1", [em])).rows[0]; if (!v.identifier_verified_at) fail("email code did not verify mailbox");
    await ctx.close(); console.log("ok  sign-in needs the emailed code; wrong password/code never store a token");
  }
  // 3) forgot password: code + new password, then sign in with it
  {
    const em = `reset.${randomBytes(3).toString("hex")}@example.test`; const NEW = "a-brand-new-passphrase";
    await signupWithPassword(db, { module: MODULE, identifier: em, password: PW, client: CLIENT });
    const { ctx, page } = await fresh();
    await page.click(".lk >> text=Forgot password?"); await page.fill("#e", em); await page.click('form[data-f="rst"] .b1');
    await page.waitForSelector("text=Choose a new password"); await digits(page, lastCode(em, "reset")); await page.fill("#p", NEW); await page.click('form[data-f="reset"] .b1');
    await page.waitForSelector('form[data-f="login"]');
    if ((await loginWithPassword(db, { module: MODULE, identifier: em, password: NEW, client: CLIENT })).ok !== true) fail("new password does not work");
    if ((await loginWithPassword(db, { module: MODULE, identifier: em, password: PW, client: CLIENT })).ok !== false) fail("old password still works");
    await ctx.close(); console.log("ok  forgot-password by emailed code");
  }
  // 4) the design never talks to the legacy central auth API
  if (hits.some((h) => !h.includes("/api/auth/module/v2/"))) fail("a request bypassed the module API: " + hits.filter((h) => !h.includes("/module/v2/")).join(", "));
  console.log("ok  every call went to /api/auth/module/v2/*");
  console.log("PASS fyra login e2e");
} finally {
  await browser.close(); api.close(); site.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbName}`); await admin.end();
}
