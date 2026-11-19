#!/usr/bin/env node
/**
 * scripts/validate-w3-auth-v2.mjs — module auth v2 (designed login steps on real backend routes). Install-free.
 *   node scripts/validate-w3-auth-v2.mjs              # validate
 *   node scripts/validate-w3-auth-v2.mjs --self-test  # each rule must fail on a deliberate breakage
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = {
  sql: "migrations/129_module_auth_v2.sql", boot: "artifacts/api-server/src/lib/schema-migrations.ts",
  svc: "artifacts/api-server/src/lib/module-auth-v2-service.ts", route: "artifacts/api-server/src/routes/module-auth-v2.ts",
  index: "artifacts/api-server/src/routes/index.ts", adapters: "packages/module-registry/src/login-adapters.mjs",
  designs: "packages/module-registry/src/landing-designs.mjs", wisp: "packages/module-registry/landings/wisp/login.html", verve: "packages/module-registry/landings/verve/assets/js/pages/login.js", ci: ".github/workflows/ci.yml", pkg: "artifacts/api-server/package.json",
};
const load = (over = {}) => Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, over[k] ?? readFileSync(join(ROOT, f), "utf8")]));
const norm = (s) => s.replace(/\s+/g, " ").trim();

const RULES = [
  ["migration 129 creates module_otps and module_profiles with a composite FK to module_accounts(id, module)", (t) =>
    /CREATE TABLE IF NOT EXISTS module_otps/.test(t.sql) && /CREATE TABLE IF NOT EXISTS module_profiles/.test(t.sql) && /FOREIGN KEY \(module_account_id, module\)\s+REFERENCES module_accounts\s*\(id, module\)/.test(t.sql) ? null : "tables or composite FK missing"],
  ["usernames are unique per module and constrained in SQL", (t) => /module_profiles_username_idx[\s\S]*?\(module, username_norm\)/.test(t.sql) && /\^\[a-z0-9._\]\{3,30\}\$/.test(t.sql) ? null : "unique index or CHECK missing"],
  ["the boot-time schema mirror carries every migration 129 table", (t) => ["module_otps", "module_profiles", "module_profiles_username_idx", "module_otps_lookup_idx"].every((n) => norm(t.boot).includes(n)) ? null : "schema-migrations.ts lacks a 129 object"],
  ["codes are stored only as HMAC hashes and compared in constant time", (t) => /code_hash/.test(t.svc) && /createHmac/.test(t.svc) && /timingSafeEqual/.test(t.svc) && !/INSERT INTO module_otps[^;]*\$\d,\s*\$\d,\s*\$\d,\s*code[,)]/.test(t.svc) ? null : "codes may be stored or compared in clear"],
  ["codes are single-use with an attempt cap and an hourly issue cap", (t) => /OTP_MAX_ATTEMPTS/.test(t.svc) && /OTP_MAX_PER_HOUR/.test(t.svc) && /used_at = NOW\(\)/.test(t.svc) ? null : "caps or single-use missing"],
  ["sign-up checks cheap inputs before consuming the code, and creates account+profile in one transaction", (t) => /afterCreate/.test(t.svc) && t.svc.indexOf("checkPasswordPolicy") < t.svc.indexOf("consume: false") ? null : "order or atomicity broken"],
  ["every v2 route is module-gated, JSON-only and rate limited", (t) => {
    const routes = t.route.match(/router\.(get|post|put)\("\/auth\/module\/v2[^\n]*/g) ?? [];
    const bad = routes.filter((r) => !/moduleGate/.test(r) || (/router\.(post|put)/.test(r) && !/jsonOnly/.test(r)) || !/(authLimiter|otpLimiter)/.test(r) && !/profile"/.test(r) && !/captcha/.test(r));
    return routes.length >= 11 && !bad.length ? null : `${routes.length} routes; unguarded: ${bad.join(" | ")}`;
  }],
  ["the module is never read from the request body in v2 routes", (t) => /req\.body\??\.module|req\.query\??\.module|req\.headers\[["']x-module/i.test(t.route) ? "module taken from the client" : null],
  ["the emailed code is never logged", (t) => /logger\.\w+\([^)]*code/.test(t.route) ? "a log line includes the code" : null],
  ["v2 router is mounted after the module router", (t) => /router\.use\(moduleAuthV2Router\)/.test(t.index) ? null : "not mounted"],
  ["the login adapter only maps the legacy /api/auth calls to /api/auth/module/v2 and passes everything else through", (t) => /\/api\/auth\/module\/v2/.test(t.adapters) && /return F\.apply\(this,arguments\)\};/.test(t.adapters) && !/localStorage/.test(t.adapters) ? null : "adapter overreaches"],
  ["the adapter is injected into the served login page", (t) => /loginAdapterScript\(id\)/.test(t.designs) ? null : "designedLoginHtml does not inject it"],
  ["wisp and verve login designs call the module v2 API natively, keep no demo accounts/codes, and never fake a social login", (t) => {
    for (const [id, src] of [["wisp", t.wisp], ["verve", t.verve]]) {
      if (!/\/api\/auth\/module\/v2|B='\/api\/auth\/module\/v2'|B="\/api\/auth\/module\/v2"/.test(src)) return `${id}: does not call /api/auth/module/v2`;
      if (/Demo code|any 6 digits|verve-demo-accounts|Design preview|MEM\[/.test(src)) return `${id}: demo code or demo accounts left in`;
    }
    return /function oauth\(p\)\{toast\(/.test(t.verve) ? null : "verve social buttons are not neutralised";
  }],
  ["CI runs this validator, its self-test and the v2 DB tests", (t) => /validate-w3-auth-v2\.mjs --self-test/.test(t.ci) && /module-auth-v2-service\.db\.test/.test(t.pkg) ? null : "CI step missing"],
];

const MUTANTS = [
  ["no composite FK", { sql: (s) => s.replace(/FOREIGN KEY \(module_account_id, module\)/, "-- fk") }],
  ["no username unique index", { sql: (s) => s.replace(/module_profiles_username_idx/g, "x_idx").replace(/\(module, username_norm\)/g, "(username_norm)") }],
  ["boot mirror lacks module_otps", { boot: (s) => s.replace(/module_otps/g, "module_xxx") }],
  ["clear-text code compare", { svc: (s) => s.replace(/timingSafeEqual/g, "Object.is") }],
  ["no attempt cap", { svc: (s) => s.replace(/OTP_MAX_ATTEMPTS/g, "99") }],
  ["no afterCreate transaction hook", { svc: (s) => s.replace(/afterCreate/g, "later") }],
  ["route without moduleGate", { route: (s) => s.replace('router.post("/auth/module/v2/login", moduleGate,', 'router.post("/auth/module/v2/login",') }],
  ["module from body", { route: (s) => s + "\nconst m = req.body?.module;" }],
  ["code logged", { route: (s) => s + "\nlogger.info({ code }, 'x');" }],
  ["router not mounted", { index: (s) => s.replace("router.use(moduleAuthV2Router);", "") }],
  ["adapter swallows unknown calls", { adapters: (s) => s.replace("return F.apply(this,arguments)};", "return J(200,{})};") }],
  ["adapter not injected", { designs: (s) => s.replace("loginAdapterScript(id),", "") }],
  ["wisp demo code left in", { wisp: (s) => s + "\nDemo: any 6 digits work." }],
  ["verve demo accounts left in", { verve: (s) => s + "\nlocalStorage.getItem('verve-demo-accounts')" }],
  ["verve fake social login", { verve: (s) => s.replace("function oauth(p){toast(", "function oauth(p){A.d={email:p};go('up','oa');toast(") }],
  ["wisp not calling the API", { wisp: (s) => s.replace(/\/api\/auth\/module\/v2/g, "/x") }],
  ["CI step removed", { ci: (s) => s.replace(/validate-w3-auth-v2\.mjs --self-test/g, "nothing") }],
];

const run = (t) => RULES.map(([name, fn]) => [name, fn(t)]);
if (process.argv.includes("--self-test")) {
  let bad = 0;
  const base = load();
  for (const [name, m] of MUTANTS) {
    const [k, f] = Object.entries(m)[0]; const failed = run({ ...base, [k]: f(base[k]) }).some(([, r]) => r);
    if (!failed) { bad++; console.error(`MUTANT SURVIVED: ${name}`); }
  }
  if (bad) process.exit(1);
  console.log(`W3 auth v2 self-test: ${MUTANTS.length}/${MUTANTS.length} mutants caught`);
} else {
  const res = run(load()); let fails = 0;
  for (const [n, r] of res) { if (r) { fails++; console.error(`FAIL  ${n}: ${r}`); } else console.log(`ok    ${n}`); }
  console.log(`W3 auth v2: ${res.length - fails}/${res.length} rules pass`); process.exit(fails ? 1 : 0);
}
