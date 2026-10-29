#!/usr/bin/env node
// VLT-GAP-11 differential: the sealed pre-extraction lib/vault-health-scan.ts, lib/vault-health-cron.ts and routes/vault.ts#toHealthInput
// (11 census baseline) vs the extracted vault/application/health-{scan,cron}.ts + health.ts#toHealthInput, executed against the same
// scripted I/O. DB operations (table, where shape, values, raw SQL), notifications, telegram, email, logger/logBus calls, the returned
// scan result, cron schedule/validation/guard behavior and toHealthInput outputs must all match. Mutated copies of the new owners must be caught.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { ROOT, rejectBypass } from "./gap-common.mjs";
const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL — bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const SRC = ROOT + "/artifacts/api-server/src";
const APP = `${SRC}/vault/application`;
const BASE_DIR = `${ROOT}/reports/antas/vault/gap/VLT-GAP-11/baseline/sources/`;
const bsrc = (p) => fs.readFileSync(BASE_DIR + p.replace(/[^a-zA-Z0-9]+/g, "__"), "utf8");
const BASE_SCAN = bsrc("artifacts/api-server/src/lib/vault-health-scan.ts");
const BASE_CRON = bsrc("artifacts/api-server/src/lib/vault-health-cron.ts");
const BASE_ROUTE = bsrc("artifacts/api-server/src/routes/vault.ts");
const NEW_SCAN = fs.readFileSync(`${APP}/health-scan.ts`, "utf8");
const NEW_CRON = fs.readFileSync(`${APP}/health-cron.ts`, "utf8");
const HEALTH = `${APP}/health.ts`;

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const NOW = 1_700_000_000_000;
{ const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }; }
const DAY = 86_400_000;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// Baseline toHealthInput, lifted verbatim from the sealed routes/vault.ts by AST.
function liftFunction(text, name) {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true);
  let out = null;
  sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n.getText(sf); });
  assert(out, `baseline ${name} not found`);
  return "export " + out.replace(/^export\s+/, "");
}
const BASE_TO_INPUT = liftFunction(BASE_ROUTE, "toHealthInput");

const LOGICAL = [
  [/lib\/logger$/, "logger"], [/lib\/log-bus$/, "logBus"], [/entity\/representation$|vault\/application\/entity$/, "repr"],
  [/repositories\/entity-repository$/, "repo"], [/routes\/notifications$/, "notif"], [/lib\/telegram$/, "tg"], [/lib\/email$/, "email"],
  [/vault\/application\/health-scan$|lib\/vault-health-scan$/, "scan"],
];
function makeRuntime(S) {
  const cache = new Map();
  const log = S.log = [];
  const rec = (...a) => log.push(JSON.parse(JSON.stringify(a)));
  const tbl = (n) => new Proxy({ __t: n }, { get: (t, p) => (p === "__t" ? n : { t: n, c: String(p) }) });
  const chain = (kind, table, extra = {}) => {
    const op = { kind, table, ...extra };
    const o = { from: (t) => { op.table = t.__t; return o; }, set: (v) => { op.set = v; return o; }, where: (w) => { op.where = w; return o; },
      then: (r, j) => {
        try {
          rec("db", op);
          if (kind === "update" && S.failUpdate) throw new Error("update failed");
          if (kind === "update" && op.table === "usersTable" && S.failUserUpdate) throw new Error("user update failed");
          const res = kind === "select" ? (S.selects[op.table] ?? []) : [];
          return Promise.resolve(res).then(r, j);
        } catch (e) { return Promise.reject(e).then(r, j); }
      } };
    return o;
  };
  const dbMod = new Proxy({}, { get: (t, p) => p === "db" ? {
    select: (c) => chain("select", null, { cols: c ? Object.keys(c) : null }),
    update: (t_) => chain("update", t_.__t),
    execute: async (q) => {
      rec("execute", q);
      const s = q.raw;
      if (/^UPDATE /.test(s)) { if (S.failRaw) throw new Error("raw update failed"); return { rows: [] }; }
      if (/FROM kyc_entries\s*$/.test(s.trim())) return { rows: S.kyc };
      if (/FROM local_accounts\s*$/.test(s.trim())) return { rows: S.local };
      if (/FROM kyc_data_entities d/.test(s)) return { rows: S.data };
      throw new Error("unexpected sql " + s);
    } } : tbl(String(p)) });
  const mocks = {
    "@workspace/db": dbMod,
    "drizzle-orm": { eq: (c, v) => ["eq", c.c, v], and: (...a) => ["and", ...a], inArray: (c, v) => ["inArray", c.c, v], sql: { raw: (s) => ({ raw: s }) } },
    logger: { logger: { warn: (...a) => rec("warn", ...a.map((x) => (x && x.err ? { ...x, err: String(x.err.message ?? x.err) } : x))), info: (...a) => rec("info", ...a), error: (...a) => rec("error", ...a.map((x) => (x && x.err ? { ...x, err: String(x.err.message ?? x.err) } : x))) } },
    logBus: { logBus: { system: (m) => rec("bus.system", m), warn: (m) => rec("bus.warn", m), error: (m) => rec("bus.error", m) } },
    repr: { formatVaultEntry: (raw) => { if (raw.__boom) throw new Error("format failed"); return { ...raw }; } },
    repo: { selectAllVaultEntries: async () => S.entries },
    notif: { createNotification: (...a) => { rec("notify", ...a); if (S.notifySyncThrow?.includes(a[0])) throw new Error("notify sync"); return S.notifyReject ? Promise.reject(new Error("n")) : Promise.resolve(); } },
    tg: { sendToUser: (...a) => { rec("telegram", ...a); return S.tgReject ? Promise.reject(new Error("t")) : Promise.resolve(); } },
    email: { sendVaultHealthDigestEmail: (...a) => { rec("email", ...a); return S.mailReject ? Promise.reject(new Error("m")) : Promise.resolve(); } },
    scan: { runDailyHealthScan: async () => { rec("scan.run"); if (S.scanFail) throw S.scanFail; return { entriesScanned: 0, entriesFlagged: 0, usersAlerted: 0 }; } },
    "node-cron": { default: { validate: (e) => { rec("cron.validate", e); return /^[\d*\/,\- ]+$/.test(e) && e.trim().split(/\s+/).length === 5; },
      schedule: (e, fn) => { rec("cron.schedule", e); S.scheduled.push(fn); } } },
    baselineRoute: null,
  };
  mocks["node-cron"].__esModule = true;
  const find = (spec, from) => {
    if (!spec.startsWith(".")) return { mock: mocks[spec] };
    const abs = path.resolve(path.dirname(from), spec);
    const rel = path.relative(SRC, abs).split(path.sep).join("/");
    if (/(^|\/)vault\/application\/health$|(^|\/)lib\/vault-health$/.test(rel)) return { file: HEALTH };
    if (/^routes\/vault$/.test(rel)) return { virtual: BASE_TO_INPUT };
    // GAP-12 moved this module's infrastructure access behind vault/infrastructure; the executed comparison runs those owners against the same mocks.
    if (/vault\/infrastructure\/repositories\/vault-health-repository$/.test(rel)) return { file: `${SRC}/vault/infrastructure/repositories/vault-health-repository.ts` };
    if (/vault\/infrastructure\/providers\/provider-ports$/.test(rel)) return { mock: { sendTelegramToUserProvider: mocks.tg.sendToUser, sendVaultHealthDigestEmailProvider: mocks.email.sendVaultHealthDigestEmail, createNotificationProvider: mocks.notif.createNotification } };
    if (/vault\/infrastructure\/jobs\/cron-scheduler$/.test(rel)) return { mock: { validateCronExpression: mocks["node-cron"].default.validate, scheduleCronJob: mocks["node-cron"].default.schedule } };
    for (const [re, name] of LOGICAL) if (re.test(rel)) return { mock: mocks[name] };
    throw new Error(`unresolved ${spec} from ${from} (${rel})`);
  };
  const load = (file, text) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(text ?? fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cache.set(file, m);
    new Function("require", "module", "exports", "__filename", code)((s) => { const r = find(s, file); if (r.mock) return r.mock; if (r.virtual) return load(`${SRC}/routes/vault.ts`, r.virtual); return load(r.file); }, m, m.exports, file);
    return m.exports;
  };
  return { load };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const base = () => ({ entries: [], kyc: [], local: [], data: [], selects: { walletsTable: [], usersTable: [] }, scheduled: [] });

// ── scan scenarios ──────────────────────────────────────────────────────────
const healthyEntity = { id: 1, userId: 10, score: 9, lastLoginAt: iso(1), twitterUsername: "t", twitter2fa: true, email: "a@x", email2fa: true, accountPassword: "p", status: "active", emailRecovery: "r@x", category: "Social", projectName: "Alpha" };
const riskyEntity = { id: 2, userId: 10, score: 2, lastLoginAt: iso(400), twitterUsername: "t2", twitter2fa: false, discordUsername: "d", discord2fa: false, email: "b@x", email2fa: false, status: "banned", category: "Game", projectName: "Beta" };
const riskyEntity2 = { id: 3, userId: 11, score: 4, lastLoginAt: null, telegramUsername: "tg", telegram2fa: false, status: "suspended", category: "Node", projectName: "Gamma" };
const SCEN = {
  empty: () => base(),
  mixed: () => ({ ...base(),
    entries: [healthyEntity, riskyEntity, riskyEntity2, { id: 4, userId: 12, __boom: true }],
    kyc: [{ id: 5, user_id: 10, name: "K1", email_2fa: false, account_2fa: false, last_login_at: iso(500), status: "active" }, { id: 6, user_id: 13, username: "kyc-u", email_2fa: true, account_2fa: true, email_backup_code: "x", account_backup_code: "y", email_recovery: "e@x", last_login_at: iso(2) }, { id: 7, user_id: 11 }],
    local: [{ id: 8, user_id: 11, label: "L1", twofa: false, backup_codes: null, recovery_email: null, account_last_login_date: iso(300), status: "banned" }, { id: 9, user_id: 14, email: "l@x", twofa: "1", backup_codes: "1", recovery_email: "r", account_last_login_date: iso(1), status: "active" }],
    data: [{ id: 10, user_id: 10, name: "D1", nid_number: null, birth_date: null, photo1_url: null, photo2_url: null, used: false, created_at: iso(200) }, { id: 11, user_id: 15, name: "D2", nid_number: "n", birth_date: "b", photo1_url: "p1", photo2_url: "p2", used: true, created_at: iso(1) }],
    selects: { walletsTable: [{ id: 20, userId: 10, label: "W1", chain: "eth", encryptedPhrase: null, lastSyncedAt: iso(900) }, { id: 21, userId: 16, label: "W2", chain: "sol", encryptedPhrase: "enc", lastSyncedAt: iso(1) }],
      usersTable: [
        { id: 10, username: "u10", email: "u10@x", telegramChatId: "tg10", digestFrequency: "daily", lastDigestSentAt: null },
        { id: 11, username: "u11", email: "", telegramChatId: null, digestFrequency: "weekly", lastDigestSentAt: iso(3) },
        { id: 12, username: "u12", email: "u12@x", telegramChatId: null, digestFrequency: "monthly", lastDigestSentAt: iso(40) },
        { id: 13, username: "u13", email: "u13@x", telegramChatId: "tg13", digestFrequency: null, lastDigestSentAt: iso(2) },
        { id: 99, username: "ghost", email: "g@x", telegramChatId: null, digestFrequency: "daily", lastDigestSentAt: null }] } }),
  persistFailures: () => ({ ...SCEN.mixed(), failUpdate: true, failRaw: true }),
  digestFailures: () => ({ ...SCEN.mixed(), notifySyncThrow: [10], failUserUpdate: true }),
  asyncSinkRejections: () => ({ ...SCEN.mixed(), notifyReject: true, tgReject: true, mailReject: true }),
  noUsersFound: () => ({ ...SCEN.mixed(), selects: { walletsTable: [], usersTable: [] } }),
  unknownFrequency: () => { const s = SCEN.mixed(); s.selects.usersTable = s.selects.usersTable.map((u) => ({ ...u, digestFrequency: "hourly", lastDigestSentAt: iso(0.5) })); return s; },
};
async function runScan(scanText, name, mk, scanPath = `${APP}/health-scan.ts`) {
  const S = clone(mk()); for (const u of S.selects.usersTable) if (u.lastDigestSentAt) u.lastDigestSentAt = new Date(u.lastDigestSentAt); const rt = makeRuntime(S);
  const mod = rt.load(scanPath, scanText);
  const result = await mod.runDailyHealthScan();
  await new Promise((r) => setImmediate(r));
  return { result, log: S.log };
}
// ── cron scenarios ───────────────────────────────────────────────────────────
const CRON_SCEN = {
  defaultExpr: { env: undefined, starts: 1 }, customExpr: { env: "*/5 * * * *", starts: 1 }, invalidExpr: { env: "nope", starts: 1 },
  doubleInit: { env: undefined, starts: 2 }, scanRejects: { env: undefined, starts: 1, fail: new Error("boom") }, scanRejectsNoMessage: { env: undefined, starts: 1, fail: "plain" },
};
async function runCron(cronText, name, sc, cronPath = `${APP}/health-cron.ts`) {
  const prev = process.env.VAULT_HEALTH_SCAN_CRON;
  if (sc.env === undefined) delete process.env.VAULT_HEALTH_SCAN_CRON; else process.env.VAULT_HEALTH_SCAN_CRON = sc.env;
  try {
    const S = { ...base(), scanFail: sc.fail }; const rt = makeRuntime(S);
    const mod = rt.load(cronPath, cronText);
    for (let i = 0; i < sc.starts; i++) mod.startVaultHealthCron();
    for (const fn of S.scheduled) fn();
    await new Promise((r) => setImmediate(r));
    return { log: S.log, scheduled: S.scheduled.length };
  } finally { if (prev === undefined) delete process.env.VAULT_HEALTH_SCAN_CRON; else process.env.VAULT_HEALTH_SCAN_CRON = prev; }
}
// ── toHealthInput ────────────────────────────────────────────────────────────
const INPUTS = [healthyEntity, riskyEntity, riskyEntity2, {}, { score: null, email: "", twitterUsername: "x" }, { score: "7", status: null, emailRecovery: "", accountPassword: 0, discordUsername: "d", discord2fa: 1 }, { telegramUsername: "t", telegram2fa: undefined, lastLoginAt: undefined }];

let scenarios = 0;
const cmp = (label, a, b) => { assert.deepStrictEqual(b, a, `${label} diverged`); assert.strictEqual(unhandled.length, 0, `${label}: unhandled rejection`); scenarios++; };
for (const [name, mk] of Object.entries(SCEN)) {
  const a = await runScan(BASE_SCAN, "b-" + name, mk, `${SRC}/lib/vault-health-scan.ts`), b = await runScan(NEW_SCAN, "n-" + name, mk);
  cmp(`scan:${name}`, a, b);
  if (name === "mixed") { assert(a.result.entriesFlagged > 0 && a.result.usersAlerted > 0, "mixed scenario must exercise flagging + delivery"); assert(a.log.some((l) => l[0] === "notify") && a.log.some((l) => l[0] === "email") && a.log.some((l) => l[0] === "telegram"), "mixed must hit all digest sinks"); }
  if (name === "persistFailures") assert(a.log.filter((l) => l[0] === "warn").length >= 4, "persist failures must be logged");
}
for (const [name, sc] of Object.entries(CRON_SCEN)) cmp(`cron:${name}`, await runCron(BASE_CRON, "b-" + name, sc, `${SRC}/lib/vault-health-cron.ts`), await runCron(NEW_CRON, "n-" + name, sc));
{
  const rtB = makeRuntime({ ...base() }), rtN = makeRuntime({ ...base() });
  const fb = rtB.load(`${SRC}/routes/vault.ts`, BASE_TO_INPUT).toHealthInput, fn = rtN.load(HEALTH).toHealthInput;
  INPUTS.forEach((inp, i) => cmp(`toHealthInput:${i}`, fb(clone(inp)), fn(clone(inp))));
}
// ── self-test: the differential must catch mutated owners ────────────────────
const MUTANTS = [
  ["scan:flag-count", "scan", (t) => t.replace("entriesFlagged++;", "entriesFlagged += 0;")],
  ["scan:alert-clause", "scan", (t) => t.replace(`", last_health_alert_at = NOW()"`, `""`)],
  ["scan:digest-gate", "scan", (t) => t.replace("if (!isDigestDue(user.digestFrequency, user.lastDigestSentAt)) continue;", "")],
  ["scan:label", "scan", (t) => t.replace("`Wallet — ${w.label} (${w.chain})`", "`Wallet — ${w.label}`")],
  ["scan:swallow-removed", "scan", (t) => t.replace(".catch(() => {});\n\n  // Telegram", ";\n\n  // Telegram")],
  ["cron:default-expr", "cron", (t) => t.replace("0 */6 * * *", "0 */4 * * *")],
  ["cron:guard", "cron", (t) => t.replace("if (scheduled) return;", "")],
  ["tohealth:status-default", "health", (t) => t.replace(`status: (formatted as any).status ?? "active"`, `status: (formatted as any).status ?? "inactive"`)],
];
let caught = 0;
for (const [label, kind, mutate] of MUTANTS) {
  const src = kind === "scan" ? NEW_SCAN : kind === "cron" ? NEW_CRON : fs.readFileSync(HEALTH, "utf8");
  const mutated = mutate(src);
  assert.notStrictEqual(mutated, src, `mutant ${label} did not change the source`);
  let diverged = false;
  try {
    if (kind === "scan") { for (const [n, mk] of Object.entries(SCEN)) { const a = await runScan(BASE_SCAN, "mb-" + label + n, mk, `${SRC}/lib/vault-health-scan.ts`), b = await runScan(mutated, "mm-" + label + n, mk); assert.deepStrictEqual(b, a); assert.strictEqual(unhandled.length, 0); } }
    else if (kind === "cron") { for (const [n, sc] of Object.entries(CRON_SCEN)) assert.deepStrictEqual(await runCron(mutated, "mm-" + label + n, sc), await runCron(BASE_CRON, "mb-" + label + n, sc, `${SRC}/lib/vault-health-cron.ts`)); }
    else { const rt = makeRuntime(base()); const f = rt.load(HEALTH, mutated).toHealthInput; const rb = makeRuntime(base()).load(`${SRC}/routes/vault.ts`, BASE_TO_INPUT).toHealthInput; INPUTS.forEach((i) => assert.deepStrictEqual(f(clone(i)), rb(clone(i)))); }
  } catch { diverged = true; }
  unhandled.length = 0;
  assert(diverged, `differential failed to catch mutant ${label}`);
  caught++;
}
console.log(`VLT-GAP-11 differential PASS — ${scenarios} executed comparisons (scan ${Object.keys(SCEN).length}, cron ${Object.keys(CRON_SCEN).length}, toHealthInput ${INPUTS.length}), ${caught}/${MUTANTS.length} mutants caught`);
