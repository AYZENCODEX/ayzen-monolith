/**
 * Browser check: the modules' OWN designed login pages (fyra via adapter, wisp natively) against the real module-auth v2 service on a real Postgres.
 * The design file is untouched; the injected adapter (login-adapters.mjs) maps its calls to /api/auth/module/v2/*.
 * A thin HTTP layer stands in for the Express router (same service calls, same JSON contract); e-mails land in an outbox.
 *
 *   MODULE_AUTH_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node --import tsx tests/e2e/module-login/login-v2.spec.mts
 */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
import { designedLoginHtml, designedLandingHtml, designedRegisterHtml, isPortal, designRoot } from "../../../packages/module-registry/src/landing-designs.mjs";
import { poolAuthDb, signupWithPassword, loginWithPassword } from "../../../artifacts/api-server/src/lib/module-auth-service";
import { totpGenerate } from "../../../artifacts/api-server/src/lib/totp";
import { FAKE_WA } from "../../../artifacts/api-server/src/lib/webauthn-test-double";
import * as V2 from "../../../artifacts/api-server/src/lib/module-auth-v2-service";

V2.setWebAuthnForTests(FAKE_WA); // the real signature checks live in @simplewebauthn/server (not installed in this sandbox)
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
for (const m of ["125_module_accounts.sql", "126_module_credentials_sessions.sql", "127_module_oidc_audit_events.sql", "128_module_external_identities.sql", "129_module_auth_v2.sql", "130_module_passkeys.sql"]) await pool.query(mig(m));

// ── API stand-in (one per module; same service calls and JSON contract as routes/module-auth-v2.ts) ──
const CLIENT = { ip: "127.0.0.1", userAgent: "e2e", deviceLabel: "e2e" };
const ok = (res: http.ServerResponse, code: number, body: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
const STATUS: Record<string, number> = { PASSKEY_INVALID: 401, WORKSPACE_TAKEN: 409, TOTP_NOT_STARTED: 409, INVALID_CODE: 400, CHALLENGE_INVALID: 400, INVALID_CREDENTIALS: 401, TOO_MANY_CODES: 429, USERNAME_TAKEN: 409, MAIL_TAKEN: 409 };
const bad = (res: http.ServerResponse, f: any) => ok(res, STATUS[f.code] ?? 400, { error: "Request rejected", code: f.code, solution: f.code === "PASSWORD_TOO_SHORT" ? "Use at least 10 characters." : undefined });
const sess = (s: any, email?: string) => ({ token: "tok." + s.jti, account: { module: s.module, moduleUid: s.moduleUid, identifier: email } });
type Served = { origin: string; outbox: Array<{ to: string; code: string; what: string }>; hits: string[]; close: () => void };
async function serve(MODULE: any): Promise<Served> {
  const outbox: Served["outbox"] = [], hits: string[] = [];
  const api = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", req.headers.origin ?? "*"); res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "content-type, authorization"); res.setHeader("access-control-allow-methods", "POST,GET,PUT,OPTIONS");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", async () => {
      hits.push(`${req.method} ${req.url}`);
      try {
        const b = raw ? JSON.parse(raw) : {}; const p = req.url!.replace(/^\/api\/auth\/module\/v2/, "");
        if (p === "/captcha") return ok(res, 200, V2.newCaptcha(MODULE));
        if (p === "/username/check") { const r: any = await V2.isUsernameFree(db.query, MODULE, b.username); return r.ok ? ok(res, 200, { available: r.available }) : bad(res, r); }
        if (p === "/mail/check") { const r: any = await V2.isMailLocalFree(db.query, MODULE, b.mail); return r.ok ? ok(res, 200, { available: r.available }) : bad(res, r); }
        if (p === "/referral/check") return ok(res, 200, { valid: await V2.isReferralValid(db.query, b.code) });
        if (p === "/signup/verify") { const r: any = await V2.checkSignupCode(db, { module: MODULE, email: b.email, code: b.code }); return r.ok ? ok(res, 200, { valid: true }) : bad(res, r); }
        if (p === "/signup/start") { const r: any = await V2.startSignup(db, { module: MODULE, email: b.email, captchaId: b.captcha?.id, captchaAnswer: b.captcha?.answer, client: CLIENT }); if (!r.ok) return bad(res, r); if (r.send) outbox.push({ ...r.send, what: "signup" }); return ok(res, 202, {}); }
        if (p === "/signup/complete") { const r: any = await V2.completeSignup(db, { module: MODULE, email: b.email, code: b.code, password: b.password, username: b.username, mail: b.mail, referral: b.referral, profile: b.profile, client: CLIENT }); return r.ok ? ok(res, 201, sess(r, b.email)) : bad(res, r); }
        if (p === "/login") { const r: any = await V2.startLogin(db, { module: MODULE, email: b.email, password: b.password, client: CLIENT, requireCode: b.requireCode === true }); if (!r.ok) return bad(res, r); if (r.stepUp) { if (r.stepUp.send) outbox.push({ ...r.stepUp.send, what: "login" }); return ok(res, 200, { stepUp: { challenge: r.stepUp.challenge, methods: r.stepUp.methods, emailSent: !!r.stepUp.send } }); } return ok(res, 200, sess(r, b.email)); }
        if (p === "/login/email-code") { const r: any = await V2.sendLoginEmailCode(db, { module: MODULE, challenge: b.challenge, client: CLIENT }); if (!r.ok) return bad(res, r); outbox.push({ ...r.send, what: "login" }); return ok(res, 202, {}); }
        if (p === "/login/verify") { const r: any = await V2.completeLogin(db, { module: MODULE, challenge: b.challenge, code: b.code, client: CLIENT }); return r.ok ? ok(res, 200, sess(r)) : bad(res, r); }
        if (p === "/reset/request") { const r = await V2.startCodeReset(db, { module: MODULE, email: b.email, client: CLIENT }); if (r.send) outbox.push({ ...r.send, what: "reset" }); return ok(res, 202, {}); }
        if (p === "/reset/confirm") { const r: any = await V2.completeCodeReset(db, { module: MODULE, email: b.email, code: b.code, newPassword: b.password, client: CLIENT }); return r.ok ? ok(res, 200, {}) : bad(res, r); }
        if (p === "/profile" && req.method === "PUT") {
          const jti = String(req.headers.authorization ?? "").replace("Bearer tok.", ""); const a = (await pool.query("SELECT module_account_id FROM user_sessions WHERE jti=$1 AND revoked_at IS NULL", [jti])).rows[0];
          if (!a) return ok(res, 401, { error: "Unauthorized" });
          const r: any = await V2.updateProfile(db, { module: MODULE, moduleAccountId: a.module_account_id, profile: b, client: CLIENT }); return r.ok ? ok(res, 200, {}) : bad(res, r);
        }
        if (p === "/profile" && req.method === "GET") {
          const jti = String(req.headers.authorization ?? "").replace("Bearer tok.", ""); const a = (await pool.query("SELECT module_account_id FROM user_sessions WHERE jti=$1 AND revoked_at IS NULL", [jti])).rows[0];
          if (!a) return ok(res, 401, { error: "Unauthorized" });
          return ok(res, 200, { profile: await V2.getProfile(db.query, a.module_account_id) });
        }
        if (p === "/login/passkey/options" || p === "/login/passkey/verify") {
          const o = new URL(String(req.headers.origin)); const rp = { rpID: o.hostname, rpName: "AYZEN", origin: o.origin };
          if (p.endsWith("options")) { const r: any = await V2.passkeyLoginOptions(db, { module: MODULE, challenge: b.challenge, rp }); return r.ok ? ok(res, 200, { options: r.options, token: r.token }) : bad(res, r); }
          const r: any = await V2.passkeyLoginVerify(db, { module: MODULE, challenge: b.challenge, token: b.token, response: b.response, rp, client: CLIENT }); return r.ok ? ok(res, 200, sess(r)) : bad(res, r);
        }
        if (p === "/passkey/register/options" || p === "/passkey/register/verify") {
          const jti = String(req.headers.authorization ?? "").replace("Bearer tok.", ""); const a = (await pool.query("SELECT module_account_id FROM user_sessions WHERE jti=$1 AND revoked_at IS NULL", [jti])).rows[0];
          if (!a) return ok(res, 401, { error: "Unauthorized" });
          const o = new URL(String(req.headers.origin)); const rp = { rpID: o.hostname, rpName: "AYZEN", origin: o.origin };
          if (p.endsWith("options")) { const r: any = await V2.passkeyRegisterOptions(db, { module: MODULE, moduleAccountId: a.module_account_id, rp }); return r.ok ? ok(res, 200, { options: r.options, token: r.token }) : bad(res, r); }
          const r: any = await V2.passkeyRegisterVerify(db, { module: MODULE, moduleAccountId: a.module_account_id, rp, token: b.token, response: b.response, name: b.name, client: CLIENT }); return r.ok ? ok(res, 201, { id: r.id, name: r.name }) : bad(res, r);
        }
        if (p === "/workspace/check") { const r: any = await V2.isWorkspaceSlugFree(db.query, MODULE, b.slug); return r.ok ? ok(res, 200, { available: r.available }) : bad(res, r); }
        if (p === "/totp/enrol" || p === "/totp/confirm") {
          const jti = String(req.headers.authorization ?? "").replace("Bearer tok.", ""); const a = (await pool.query("SELECT module_account_id FROM user_sessions WHERE jti=$1 AND revoked_at IS NULL", [jti])).rows[0];
          if (!a) return ok(res, 401, { error: "Unauthorized" });
          if (p === "/totp/enrol") { const r: any = await V2.beginTotpEnrol(db, { module: MODULE, moduleAccountId: a.module_account_id, client: CLIENT }); return r.ok ? ok(res, 200, { secret: r.secret, uri: r.uri }) : bad(res, r); }
          const r: any = await V2.confirmTotpEnrol(db, { module: MODULE, moduleAccountId: a.module_account_id, code: b.code, client: CLIENT }); return r.ok ? ok(res, 200, { enabled: true }) : bad(res, r);
        }
        ok(res, 404, { error: "no route " + req.url });
      } catch (e) { console.error(e); ok(res, 500, { error: "boom" }); }
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const apiOrigin = `http://127.0.0.1:${(api.address() as any).port}`;
  const site = http.createServer((req, res) => {
    const pth = new URL(req.url!, "http://x").pathname;
    if (pth.startsWith("/landing-assets/")) { // the design's own css/js/fonts, straight from the registry
      const f = path.join(designRoot(), pth.slice("/landing-assets/".length));
      if (!f.startsWith(designRoot()) || !existsSync(f) || !statSync(f).isFile()) { res.statusCode = 404; return res.end(); }
      const ext = path.extname(f); res.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" } as any)[ext] ?? "application/octet-stream");
      return res.end(readFileSync(f));
    }
    res.setHeader("content-type", "text/html");
    if (isPortal(MODULE) && pth === "/") return res.end(designedLandingHtml(MODULE, { apiOrigin })!);
    if (isPortal(MODULE) && pth === "/register") return res.end(designedRegisterHtml(MODULE)!);
    res.end(pth === "/login" ? designedLoginHtml(MODULE, { apiOrigin })! : `<!doctype html><title>stub ${pth}</title>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(site.address() as any).port}`, outbox, hits, close: () => { api.close(); site.close(); } };
}
const fyra = await serve("fyra"), wisp = await serve("wisp"), verve = await serve("verve"), ryft = await serve("ryft"), zynth = await serve("zynth"), skarn = await serve("skarn");

// ── browser ──
const browser = await chromium.launch();
async function fresh(sv: Served = fyra, qs = "?next=/finance/dashboard") {
  const ctx = await browser.newContext(); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage(); await page.goto(`${sv.origin}/login${qs}`); return { ctx, page };
}
const digits = async (page: any, code: string, scope = "") => { const boxes = page.locator(`${scope} .otp input`); for (let i = 0; i < 6; i++) await boxes.nth(i).fill(code[i]); };
const lastCode = (to: string, what: string, sv: Served = fyra) => [...sv.outbox].reverse().find((m) => m.to === to && m.what === what)?.code ?? fail(`no ${what} mail for ${to}`);
const tokenOf = (page: any) => page.evaluate(() => localStorage.getItem("ayzen_token") || sessionStorage.getItem("ayzen_token"));

try {
  if (!process.env.E2E_ONLY) {
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
  // 5) wisp: five-step sign-up (captcha, referral, code, identity, profile), sign-in with code, forgot password
  {
    await pool.query("INSERT INTO users (username,email,password_hash,referral_code) VALUES ('refu','refu@x.test','h','AYZ-WISP1')");
    const { ctx, page } = await fresh(wisp, "?tab=signup&next=/mailbox"); const em = `w.${randomBytes(3).toString("hex")}@example.test`; const mail = `box${randomBytes(2).toString("hex")}`;
    await page.fill("#email", em); await page.fill("#pw", "short"); await page.click("#f .zp-btn"); // 10-char minimum is enforced up front
    if (!(await page.locator("#pw").count())) fail("short password advanced the sign-up");
    await page.fill("#pw", PW); await page.click("#f .zp-btn"); await page.waitForSelector("text=One quick check");
    await page.waitForFunction(() => /\d \+ \d/.test(document.body.innerText)); // the question comes from the server
    const q = await page.locator("label[for=cap]").innerText(); const [a, b2] = q.match(/(\d+) \+ (\d+)/)!.slice(1).map(Number);
    await page.fill("#ref", "AYZ-NOPE"); await page.fill("#cap", String(a + b2)); await page.click("#f .zp-btn");
    await page.waitForSelector(".zp-toast.bad"); if (await page.locator("text=Verify your email").count()) fail("bad referral advanced");
    await page.fill("#ref", "AYZ-WISP1"); await page.fill("#cap", String(a + b2 + 1)); await page.click("#f .zp-btn"); await page.waitForTimeout(400);
    if (await page.locator("text=Verify your email").count()) fail("wrong captcha advanced");
    await page.waitForFunction(() => /\d \+ \d/.test(document.body.innerText));
    const q2 = await page.locator("label[for=cap]").innerText(); const [a2, b3] = q2.match(/(\d+) \+ (\d+)/)!.slice(1).map(Number);
    await page.fill("#ref", "AYZ-WISP1"); await page.fill("#cap", String(a2 + b3)); await page.click("#f .zp-btn"); await page.waitForSelector("text=Verify your email");
    await page.fill("#code", "000000"); await page.click("#f .zp-btn"); await page.waitForSelector(".zp-toast.bad");
    await page.fill("#code", lastCode(em, "signup", wisp)); await page.click("#f .zp-btn"); await page.waitForSelector("text=Choose your identity");
    await page.fill("#user", "wisp_ada"); await page.waitForSelector("#us.ok"); await page.fill("#name", "Ada Lovelace"); await page.fill("#mail", mail); await page.waitForSelector("#ms.ok");
    await page.click("#go"); await page.waitForSelector("text=Finish your profile");
    const tok = await tokenOf(page); if (!String(tok).startsWith("tok.")) fail("wisp sign-up stored no token");
    await page.fill("#loc", "Dhaka"); await page.fill("#x", "@ada"); await page.fill("#web", "https://ada.test"); await page.click("#f .zp-btn");
    await page.waitForFunction(() => location.pathname === "/mailbox", null, { timeout: 8000 });
    const row = (await pool.query("SELECT username,mail_local,first_name,last_name,location,referral_code_used,extra,links FROM module_profiles WHERE username_norm='wisp_ada'")).rows[0];
    if (!row || row.mail_local !== mail || row.first_name !== "Ada" || row.last_name !== "Lovelace" || row.location !== "Dhaka" || row.referral_code_used !== "AYZ-WISP1" || row.extra.x !== "@ada" || row.links[0] !== "https://ada.test") fail("wisp profile wrong: " + JSON.stringify(row));
    await ctx.close();
    // taken username / mail are reported live
    const t = await fresh(wisp, "?tab=signup"); await t.page.fill("#email", `z.${randomBytes(3).toString("hex")}@example.test`); await t.page.fill("#pw", PW); await t.page.click("#f .zp-btn");
    await t.page.waitForSelector("text=One quick check"); await t.page.waitForFunction(() => /\d \+ \d/.test(document.body.innerText));
    const qq = await t.page.locator("label[for=cap]").innerText(); const [x1, x2] = qq.match(/(\d+) \+ (\d+)/)!.slice(1).map(Number);
    await t.page.fill("#cap", String(x1 + x2)); await t.page.click("#f .zp-btn"); await t.page.waitForSelector("text=Verify your email");
    const em2 = [...wisp.outbox].reverse()[0]; await t.page.fill("#code", em2.code); await t.page.click("#f .zp-btn"); await t.page.waitForSelector("text=Choose your identity");
    await t.page.fill("#user", "wisp_ada"); await t.page.waitForSelector("#us.bad"); await t.page.fill("#mail", mail); await t.page.waitForSelector("#ms.bad");
    await t.ctx.close();
    console.log("ok  wisp: 5-step sign-up on the real backend (captcha, referral, emailed code, username+mail, profile) lands on ?next=");
  }
  {
    const em = `wl.${randomBytes(3).toString("hex")}@example.test`; const NEW = "a-brand-new-passphrase";
    await signupWithPassword(db, { module: "wisp", identifier: em, password: PW, client: CLIENT });
    const { ctx, page } = await fresh(wisp, "?next=/mailbox");
    await page.fill("#email", em); await page.fill("#pw", "wrong-password-x"); await page.click("#f .zp-btn"); await page.waitForSelector(".zp-toast.bad");
    if (await tokenOf(page)) fail("wisp stored a token after a wrong password");
    await page.fill("#email", em); await page.fill("#pw", PW); await page.click("#f .zp-btn"); await page.waitForSelector("text=Verify it");
    if (await tokenOf(page)) fail("wisp stored a token before the code");
    await page.fill("[data-code]", "111111"); await page.click("[data-v]"); await page.waitForSelector(".zp-toast.bad");
    await page.fill("[data-code]", lastCode(em, "login", wisp)); await page.click("[data-v]");
    await page.waitForFunction(() => location.pathname === "/mailbox", null, { timeout: 8000 });
    if (!String(await tokenOf(page)).startsWith("tok.")) fail("wisp: no token after the code");
    await ctx.close();
    const r = await fresh(wisp);
    await r.page.click("#forgot"); await r.page.fill("#email", em); await r.page.click("#f .zp-btn"); await r.page.waitForSelector("text=Choose a new password");
    await r.page.fill("#code", lastCode(em, "reset", wisp)); await r.page.fill("#pw", NEW); await r.page.click("#f .zp-btn"); await r.page.waitForSelector("#forgot");
    if ((await loginWithPassword(db, { module: "wisp", identifier: em, password: NEW, client: CLIENT })).ok !== true) fail("wisp: new password does not work");
    await r.ctx.close(); console.log("ok  wisp: sign-in needs the emailed code; forgot-password works");
  }
  // 6) verve: sign-up (referral+captcha, emailed code, username, profile), sign-in with code, forgot password
  {
    const STRONG = "Correct-Horse-9!", NEWP = "Another-Strong-Pass-7#";
    await pool.query("INSERT INTO users (username,email,password_hash,referral_code) VALUES ('refv','refv@x.test','h','AYZVRV01')");
    const sol = async (page: any) => { await page.waitForFunction(() => /\d+ \+ \d+ = \?/.test(document.querySelector("#cqt")?.textContent ?? "")); const [a, b] = (await page.locator("#cqt").innerText()).match(/(\d+) \+ (\d+)/)!.slice(1).map(Number); return String(a + b); };
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const em = `v.${randomBytes(3).toString("hex")}@example.test`;
    await page.goto(`${verve.origin}/login?next=/marketplace/hub#signup`);
    await page.fill("#e", em); await page.fill("#p", STRONG); await page.check("#tc"); await page.click("#sb");
    await page.waitForSelector("#rc");
    await page.fill("#rc", "NOTAREAL1"); await page.fill("#cq", await sol(page)); await page.click("#nx"); await page.waitForSelector("#rh.bad");
    await page.fill("#rc", "AYZVRV01"); await page.fill("#cq", "999"); await page.click("#nx"); await page.waitForSelector("#ch.bad");
    if (await page.locator("text=Verify your email").count()) fail("verve: wrong captcha advanced");
    await page.fill("#cq", await sol(page)); await page.click("#nx"); await page.waitForSelector("text=Verify your email");
    await digits(page, "000000"); await page.click("#vb"); await page.waitForSelector("#er:not(:empty)");
    await digits(page, lastCode(em, "signup", verve)); await page.click("#vb"); await page.waitForSelector(".mo button"); await page.click(".mo button");
    await page.waitForSelector("#u"); await page.fill("#fn", "Ada"); await page.fill("#ln", "Lovelace"); await page.fill("#u", "verve.ada"); await page.waitForSelector("#uh.ok");
    await page.click("#nx"); await page.waitForSelector("text=Connect your tools");
    if (!String(await tokenOf(page)).startsWith("tok.")) fail("verve: sign-up stored no token");
    await page.click('[data-act="to"][data-s="prof"] >> nth=1'); await page.waitForSelector("#dn");
    await page.fill("#hl", "Founder"); await page.fill("#bio", "Hello"); await page.click("#fm .b1");
    await page.waitForFunction(() => location.pathname === "/marketplace/hub", null, { timeout: 8000 });
    const row = (await pool.query("SELECT mail_local,first_name,last_name,bio,extra,referral_code_used FROM module_profiles WHERE username_norm='verve.ada'")).rows[0];
    if (!row || row.mail_local !== "verve.ada" || row.first_name !== "Ada" || row.bio !== "Hello" || row.extra.headline !== "Founder" || row.referral_code_used !== "AYZVRV01") fail("verve profile wrong: " + JSON.stringify(row));
    await ctx.close();
    // sign in: password, then the emailed code, then the session
    const c2 = await browser.newContext(); const p2 = await c2.newPage();
    await p2.goto(`${verve.origin}/login?next=/marketplace/hub#signin`);
    await p2.fill("#e", em); await p2.fill("#p", "wrong-Password-1!"); await p2.click("#fm .b1"); await p2.waitForSelector("#er:not(:empty)");
    if (await tokenOf(p2)) fail("verve stored a token after a wrong password");
    await p2.fill("#p", STRONG); await p2.click("#fm .b1"); await p2.waitForSelector("text=Verify it");
    if (await tokenOf(p2)) fail("verve stored a token before the code");
    await digits(p2, "111111"); await p2.waitForSelector("#er:not(:empty)");
    await digits(p2, lastCode(em, "login", verve)); await p2.waitForSelector(".fx.ok"); await p2.click("#vb");
    await p2.waitForFunction(() => location.pathname === "/marketplace/hub", null, { timeout: 8000 });
    if (!String(await tokenOf(p2)).startsWith("tok.")) fail("verve: no token after the code");
    await c2.close();
    // forgot password
    const c3 = await browser.newContext(); const p3 = await c3.newPage(); await p3.goto(`${verve.origin}/login#signin`);
    await p3.click("text=Forgot password?"); await p3.fill("#e", em); await p3.click("#fm .b1"); await p3.waitForSelector("text=Choose a new password");
    await digits(p3, lastCode(em, "reset", verve)); await p3.fill("#p", NEWP); await p3.click("#vb"); await p3.waitForSelector("text=Password updated");
    if ((await loginWithPassword(db, { module: "verve", identifier: em, password: NEWP, client: CLIENT })).ok !== true) fail("verve: new password does not work");
    await c3.close();
    // social buttons never fake a login
    const c4 = await browser.newContext(); const p4 = await c4.newPage(); await p4.goto(`${verve.origin}/login#signin`); await p4.click('[data-act="oa"][data-p="Google"]'); await p4.waitForSelector("text=not enabled");
    if (await tokenOf(p4)) fail("verve: Google button created a session"); await c4.close();
    { // passkey: toggle at sign-up creates one (virtual authenticator), sign-in then offers the passkey button
      const base = verve.origin.replace("127.0.0.1", "localhost"), em2 = `vp.${randomBytes(3).toString("hex")}@example.test`;
      const mkCtx = async () => { const c = await browser.newContext(); const pg = await c.newPage(); const cdp = await c.newCDPSession(pg); await cdp.send("WebAuthn.enable");
        const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); return { c, pg, cdp, authenticatorId }; };
      const A1 = await mkCtx(); const pg1 = A1.pg;
      await pg1.goto(`${base}/login?next=/marketplace/hub#signup`);
      await pg1.fill("#e", em2); await pg1.fill("#p", STRONG); await pg1.check("#tc"); await pg1.click("#sb"); await pg1.waitForSelector("#rc");
      await pg1.fill("#rc", "AYZVRV01"); await pg1.fill("#cq", await sol(pg1)); await pg1.click("#nx"); await pg1.waitForSelector("text=Verify your email");
      await digits(pg1, lastCode(em2, "signup", verve)); await pg1.click("#vb"); await pg1.waitForSelector(".mo button"); await pg1.click(".mo button");
      await pg1.waitForSelector("#u"); await pg1.fill("#fn", "Pk"); await pg1.fill("#ln", "User"); await pg1.fill("#u", "verve.pk"); await pg1.waitForSelector("#uh.ok"); await pg1.click("#nx");
      await pg1.waitForSelector("text=Connect your tools"); await pg1.click('[data-act="to"][data-s="prof"] >> nth=1'); await pg1.waitForSelector("#dn");
      await pg1.check("#s2"); await pg1.click("#fm .b1"); await pg1.waitForFunction(() => location.pathname === "/marketplace/hub", null, { timeout: 8000 });
      const creds = (await A1.cdp.send("WebAuthn.getCredentials", { authenticatorId: A1.authenticatorId })).credentials; if (creds.length !== 1) fail("verve: no passkey was created");
      if (!(await pool.query("SELECT 1 FROM module_passkeys WHERE module='verve'")).rows.length) fail("verve: passkey row missing");
      const A2 = await mkCtx(); await A2.cdp.send("WebAuthn.addCredential", { authenticatorId: A2.authenticatorId, credential: creds[0] });
      await A2.pg.goto(`${base}/login?next=/marketplace/hub#signin`); await A2.pg.fill("#e", em2); await A2.pg.fill("#p", STRONG); await A2.pg.click("#fm .b1");
      await A2.pg.waitForSelector('[data-act="pk"]'); if (await tokenOf(A2.pg)) fail("verve: token before the passkey"); await A2.pg.click('[data-act="pk"]');
      await A2.pg.waitForFunction(() => location.pathname === "/marketplace/hub", null, { timeout: 8000 }); if (!String(await tokenOf(A2.pg)).startsWith("tok.")) fail("verve: no token after the passkey");
      await A1.c.close(); await A2.c.close();
    }
    console.log("ok  verve: sign-up (referral, captcha, emailed code, username, profile), sign-in with code, forgot-password");
  }
  // 4) the design never talks to the legacy central auth API

  }
  // 6) embedded portals (ryft, zynth, skarn): the landing's own sign-up (5 steps) and sign-in (3 steps) against the real service
  {
    const STRONG = "Correct-Horse-9!", NEWP = "Another-Strong-Pass-7#";
    const sol = async (page: any) => { await page.waitForFunction(() => /\d+ \+ \d+ = \?/.test(document.querySelector("#cqt")?.textContent ?? "")); const [a, b] = (await page.locator("#cqt").innerText()).match(/(\d+) \+ (\d+)/)!.slice(1).map(Number); return String(a + b); };
    const ctxFor = async () => { const c = await browser.newContext(); await c.route(/fonts\.(googleapis|gstatic)\.com|api\.binance|coingecko/, (r) => r.abort()); return c; };
    await pool.query("INSERT INTO users (username,email,password_hash,referral_code) VALUES ('refp','refp@x.test','h','AYZPRT01')");
    for (const [sv, name] of [[ryft, "ryft"], [zynth, "zynth"]] as const) {
      const em = `${name}.${randomBytes(3).toString("hex")}@example.test`, un = `${name}.ada`; let totpSecret = ""; const base = name === "zynth" ? sv.origin.replace("127.0.0.1", "localhost") : sv.origin; let pkCreds: any[] = [];
      const attach = async (ctx: any, pg: any) => { const cdp = await ctx.newCDPSession(pg); await cdp.send("WebAuthn.enable"); const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); return { cdp, authenticatorId }; };
      // redirect pages keep ?next=
      { const c = await ctxFor(); const pg = await c.newPage(); await pg.goto(`${sv.origin}/login?next=/portal/next`); await pg.waitForFunction(() => location.hash === "#login" && location.search.includes("next=%2Fportal%2Fnext")); await c.close(); }
      // sign-up
      const c1 = await ctxFor(); const page = await c1.newPage(); const auth1 = name === "zynth" ? await attach(c1, page) : null;
      await page.goto(`${base}/?next=/portal/next#login`);
      if (name === "zynth") await page.click('[data-w="up"]'); else await page.click('[data-act="tab"][data-v="up"]');
      await page.fill("#e", em); await page.fill("#p", STRONG); await page.check(name === "ryft" ? "#tos" : "#tc"); await page.click("#sb");
      await page.waitForSelector("#rc");
      await page.fill("#rc", "NOTAREAL1"); await page.fill("#cq", await sol(page)); await page.click("#nx"); await page.waitForSelector("#rh.bad");
      await page.fill("#rc", "AYZPRT01"); await page.fill("#cq", "999"); await page.click("#nx"); await page.waitForSelector("#ch.bad");
      if (await page.locator("text=Verify your email").count()) fail(`${name}: wrong captcha advanced`);
      await page.fill("#cq", await sol(page)); await page.click("#nx"); await page.waitForSelector("text=Verify your email");
      await digits(page, "000000"); await page.click("#vb"); await page.waitForSelector("#er:not(:empty)");
      await digits(page, lastCode(em, "signup", sv)); await page.click("#vb"); await page.waitForSelector(".mo button"); await page.click(".mo button");
      await page.waitForSelector("#u"); await page.fill("#fn", "Ada"); await page.fill("#ln", "Lovelace"); await page.fill("#u", un);
      if (name === "ryft") await page.selectOption("#co", "Bangladesh");
      await page.waitForSelector("#uh.ok"); await page.click("#nx");
      await page.waitForFunction(() => String(localStorage.getItem("ayzen_token") || "").startsWith("tok."), null, { timeout: 8000 }).catch(() => fail(`${name}: sign-up stored no token`));
      if (name === "ryft") {
        await page.waitForSelector("#s1"); await page.check("#s1"); await page.click('[data-act="finish"][data-save="1"]'); await page.waitForSelector("#tqc");
        await page.fill("#tqc", "000000"); await page.click("#tqb"); await page.waitForTimeout(1500); await page.waitForSelector("#tqe:not(:empty)");
        const sec = (await page.locator(".mo p").nth(1).innerText()).trim(); totpSecret = sec;
        await page.fill("#tqc", totpGenerate(sec)); await page.click("#tqb"); await page.waitForSelector("text=Account created"); await page.click(".mo button");
      }
      else { await page.waitForSelector("text=Connect your tools"); await page.click('[data-act="to"][data-s="prof"] >> nth=1'); await page.waitForSelector("#dn"); await page.fill("#hl", "Founder"); await page.fill("#bio", "Hello"); await page.check("#s2"); await page.click("#fm .b1"); await page.waitForFunction(() => location.pathname === "/portal/next", null, { timeout: 8000 }); pkCreds = (await auth1!.cdp.send("WebAuthn.getCredentials", { authenticatorId: auth1!.authenticatorId })).credentials; if (pkCreds.length !== 1) fail("zynth: no passkey was created"); }
      await page.waitForFunction(() => location.pathname === "/portal/next", null, { timeout: 8000 });
      const row = (await pool.query("SELECT first_name,last_name,extra,referral_code_used,mail_local FROM module_profiles WHERE username_norm=$1 AND module=$2", [un, name])).rows[0];
      if (!row || row.first_name !== "Ada" || row.referral_code_used !== "AYZPRT01" || row.mail_local !== un) fail(`${name}: profile row wrong ` + JSON.stringify(row));
      if (name === "ryft" && row.extra.country !== "Bangladesh") fail("ryft: country not stored");
      if (name === "ryft" && !(await pool.query("SELECT 1 FROM module_credentials WHERE identifier_norm=$1 AND mfa_enabled", [em])).rows.length) fail("ryft: authenticator not enabled after confirm");
      if (name === "zynth" && row.extra.headline !== "Founder") fail("zynth: headline not stored");
      if (name === "zynth" && !(await pool.query("SELECT 1 FROM module_passkeys WHERE module='zynth'")).rows.length) fail("zynth: passkey row missing");
      const cr = (await pool.query("SELECT identifier_verified_at FROM module_credentials WHERE identifier_norm=$1", [em])).rows[0]; if (!cr?.identifier_verified_at) fail(`${name}: mailbox not verified`);
      await c1.close();
      // sign-in: wrong password, then password + (ryft: slider) + emailed code
      const c2 = await ctxFor(); const p2 = await c2.newPage();
      if (name === "zynth") { const a2 = await attach(c2, p2); await a2.cdp.send("WebAuthn.addCredential", { authenticatorId: a2.authenticatorId, credential: pkCreds[0] }); }
      await p2.goto(`${base}/?next=/portal/next#login`); if (name === "zynth") await p2.click('[data-w="in"]');
      await p2.fill("#e", em); await p2.fill("#p", "wrong-password-123");
      if (name === "ryft") { await p2.click("#fm .b1"); await p2.waitForSelector("#sk"); const b = (await p2.locator("#sk").boundingBox())!, t = (await p2.locator("#sl").boundingBox())!; await p2.mouse.move(b.x + 5, b.y + 5); await p2.mouse.down(); await p2.mouse.move(t.x + t.width, b.y + 5, { steps: 12 }); await p2.mouse.up(); }
      else await p2.click("#fm .b1");
      await p2.waitForSelector("#er:not(:empty)"); if (await tokenOf(p2)) fail(`${name}: token after wrong password`);
      await p2.fill("#e", em); await p2.fill("#p", STRONG);
      if (name === "ryft") { await p2.click("#fm .b1"); await p2.waitForSelector("#sk"); const b = (await p2.locator("#sk").boundingBox())!, t = (await p2.locator("#sl").boundingBox())!; await p2.mouse.move(b.x + 5, b.y + 5); await p2.mouse.down(); await p2.mouse.move(t.x + t.width, b.y + 5, { steps: 12 }); await p2.mouse.up(); }
      else await p2.click("#fm .b1");
      await p2.waitForSelector(".fx"); if (await tokenOf(p2)) fail(`${name}: token before the code`);
      if (name === "zynth") { await p2.waitForSelector('[data-act="pk"]'); await p2.click('[data-act="pk"]'); }
      else { await digits(p2, totpSecret ? totpGenerate(totpSecret) : lastCode(em, "login", sv)); await p2.waitForSelector(".fx.ok"); await p2.click("#vb"); }
      await p2.waitForFunction(() => location.pathname === "/portal/next", null, { timeout: 8000 });
      if (!String(await tokenOf(p2)).startsWith("tok.")) fail(`${name}: no token after the code`);
      await c2.close();
      // forgot password
      const c3 = await ctxFor(); const p3 = await c3.newPage(); await p3.goto(`${sv.origin}/#login`); if (name === "zynth") await p3.click('[data-w="in"]');
      await p3.click('[data-act="to"][data-m="rst"]'); await p3.fill("#e", em); await p3.click("#fm .b1"); await p3.waitForSelector("#vb");
      await digits(p3, lastCode(em, "reset", sv)); await p3.fill("#p", NEWP); await p3.click("#vb"); await p3.waitForSelector("text=Password updated");
      if ((await loginWithPassword(db, { module: name, identifier: em, password: NEWP, client: CLIENT })).ok !== true) fail(`${name}: new password not accepted`);
      await c3.close();
      // fake social login is gone
      const c4 = await ctxFor(); const p4 = await c4.newPage(); await p4.goto(`${sv.origin}/#login`); if (name === "zynth") await p4.click('[data-w="in"]');
      await p4.click('[data-act="oa"][data-p="Google"]'); await p4.waitForTimeout(900); if (await tokenOf(p4)) fail(`${name}: Google button created a session`); await c4.close();
      console.log(`ok  ${name}: portal sign-up (referral, captcha, emailed code, username, profile), sign-in with code, forgot-password`);
    }
    { // skarn: its own engine (hash routes, workspace step, no captcha/referral)
      const name = "skarn", sv = skarn, em = `skarn.${randomBytes(3).toString("hex")}@example.test`;
      { const c = await ctxFor(); const pg = await c.newPage(); await pg.goto(`${sv.origin}/register?next=/portal/next`); await pg.waitForFunction(() => location.hash === "#/up/cred" && location.search.includes("next=%2Fportal%2Fnext")); await c.close(); }
      const c1 = await ctxFor(); const page = await c1.newPage(); await page.goto(`${sv.origin}/?next=/portal/next#/up/cred`);
      const D = (sel: string) => page.locator("#portal-host").locator(sel);
      await D("#e").fill(em); await D("#p").fill(STRONG); await D("#tc").check(); await D("#sb").click();
      await D(".otp input").first().waitFor(); for (let i = 0; i < 6; i++) await D(".otp input").nth(i).fill("000000"[i]);
      await D("#er:not(:empty)").waitFor();
      const code = lastCode(em, "signup", sv); for (let i = 0; i < 6; i++) await D(".otp input").nth(i).fill(code[i]);
      await D("#u").waitFor(); await D("#fn").fill("Ada"); await D("#ln").fill("Lovelace"); await D("#u").fill("skarn.ada"); await D("#uh.ok").waitFor(); await D("#nx").click();
      await D("#wn").waitFor(); await D("#wn").fill("Acme Product Team"); await D("#wh.ok").waitFor(); await D("#nx:not([disabled])").waitFor(); await D("#nx").click();
      await page.waitForFunction(() => location.pathname === "/portal/next" || !!document.querySelector("#portal-host") , null, { timeout: 8000 });
      await page.waitForFunction(() => String(localStorage.getItem("ayzen_token") || "").startsWith("tok."), null, { timeout: 8000 }).catch(() => fail("skarn: sign-up stored no token"));
      await page.waitForFunction(() => location.pathname === "/portal/next", null, { timeout: 8000 });
      const row = (await pool.query("SELECT first_name,extra FROM module_profiles WHERE username_norm='skarn.ada' AND module='skarn'")).rows[0];
      if (!row || row.first_name !== "Ada" || row.extra.workspace !== "Acme Product Team" || row.extra.workspaceSlug !== "acme-product-team") fail("skarn: profile/workspace wrong " + JSON.stringify(row));
      await c1.close();
      const c2 = await ctxFor(); const p2 = await c2.newPage(); await p2.goto(`${sv.origin}/?next=/portal/next#/in/cred`);
      const E = (sel: string) => p2.locator("#portal-host").locator(sel);
      await E("#e").fill(em); await E("#p").fill("wrong-password-123"); await E("#sb").click(); await E("#er:not(:empty)").waitFor(); if (await tokenOf(p2)) fail("skarn: token after wrong password");
      await E("#p").fill(STRONG); await E("#sb").click(); await E(".fx").first().waitFor(); if (await tokenOf(p2)) fail("skarn: token before the code");
      const lc = lastCode(em, "login", sv); for (let i = 0; i < 6; i++) await E(".otp input").nth(i).fill(lc[i]);
      await p2.waitForFunction(() => location.pathname === "/portal/next", null, { timeout: 8000 });
      if (!String(await tokenOf(p2)).startsWith("tok.")) fail("skarn: no token after the code");
      await c2.close();
      const c3 = await ctxFor(); const p3 = await c3.newPage(); await p3.goto(`${sv.origin}/#/rst/email`);
      const F = (sel: string) => p3.locator("#portal-host").locator(sel);
      await F("#e").fill(em); await F("#sb").click(); await F(".otp input").first().waitFor();
      const rc = lastCode(em, "reset", sv); for (let i = 0; i < 6; i++) await F(".otp input").nth(i).fill(rc[i]); await F("#p").fill(NEWP); await F("#vb:not([disabled])").waitFor(); await F("#vb").click(); await F("text=Password updated").waitFor();
      if ((await loginWithPassword(db, { module: "skarn", identifier: em, password: NEWP, client: CLIENT })).ok !== true) fail("skarn: new password not accepted");
      await c3.close();
      console.log("ok  skarn: portal sign-up (emailed code, username, workspace), sign-in with code, forgot-password");
    }
  }
  for (const sv of [fyra, wisp, verve, ryft, zynth, skarn]) if (sv.hits.some((h) => !h.includes("/api/auth/module/v2/"))) fail("a request bypassed the module API: " + sv.hits.filter((h) => !h.includes("/module/v2/")).join(", "));
  console.log("ok  every call went to /api/auth/module/v2/*");
  console.log("PASS login e2e (fyra, wisp, verve, ryft, zynth, skarn)");
} finally {
  await browser.close(); fyra.close(); wisp.close(); verve.close(); ryft.close(); zynth.close(); skarn.close(); await pool.end(); await admin.query(`DROP DATABASE ${dbName}`); await admin.end();
}
