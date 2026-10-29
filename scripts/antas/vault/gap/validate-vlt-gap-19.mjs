#!/usr/bin/env node
// VLT-GAP-19 — Runtime / chaos / recovery gate (Hardening H2). One script, runs the REAL Vault code (transpiled from source)
// against an in-memory database / network / clock with fault injection at EVERY I/O point:
//   crash      the process dies at I/O point k, either before the operation applied or after it applied (ack lost). Every later
//              I/O from that run throws (a dead process writes nothing). The "restart" is a fresh module graph over the surviving
//              state, 61 minutes later (past the schedule stale-lock window), which runs the normal recovery path / client retry.
//   error      the operation at point k fails once (not applied / applied-but-reported-failed) and the process keeps running.
//   outage     every database call (DB loss) or every network call (storage / provider failure) fails for a whole run, then heals.
// Scenarios (roadmap tasks 1-12): seed reveal request (1,11), scheduled backup worker incl. overlapping ticks (2,9,10,12),
// secret write + event/audit side effects (3,4,11,12), DB loss (5), storage/provider failure (6), key rotation, automatic and manual (7,9,10,12),
// restore incl. retry (8,9,12). After every fault the invariants are checked: no corruption, no duplicate critical side effect,
// no plaintext leak, no missing critical audit event, no unrecoverable state.
// Mutations: planted defects in the real source (and reverts of the three fixes this gate drove) must each be caught.
// Usage: node validate-vlt-gap-19.mjs        Writes reports/antas/vault/gap/VLT-GAP-19/gate.json (status written by this script only).
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { ROOT, rejectBypass, binding, sha256, sha256File } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const CLIENT = "artifacts/ayzen/src/pages/user/vault.tsx";
const GAP = "VLT-GAP-19", VERSION = "19.1";
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
const bad = rejectBypass([]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const ts = loadTs(ROOT);
if (!ts) fail("typescript compiler not found (fail closed)");

const SRC = path.join(ROOT, "artifacts/api-server/src");
const OUT_DIR = path.join(ROOT, "reports/antas/vault/gap", GAP);
const SELF = "scripts/antas/vault/gap/validate-vlt-gap-19.mjs";
for (const [k, v] of Object.entries({
  VAULT_FIELD_ENCRYPTION_KEY: "F".repeat(48), VAULT_MASTER_KEY: "M-chaos-master-key-".padEnd(48, "m"), VAULT_SEED_ENCRYPTION_KEY: "S".repeat(48),
})) process.env[k] = v;
const AES = await import(path.join(ROOT, "packages/vault-crypto/src/aes-gcm.mjs"));

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0), MIN = 60_000, DAY = 86_400_000;
const CANARY = { payload: "CANARY-PAYLOAD-9f2c41d7", pw: "CANARY-PASSWORD-31b7e0aa", seed: "CANARY-SEED-abandon-ability-able-5d1e", user: "CANARY-USERNAME-77c0" };
const SECRET_STRINGS = [CANARY.payload, CANARY.pw, CANARY.seed, process.env.VAULT_MASTER_KEY, process.env.VAULT_FIELD_ENCRYPTION_KEY, process.env.VAULT_SEED_ENCRYPTION_KEY];
const PAYLOAD_JSON = JSON.stringify({ vault: [{ projectName: "p1", note: CANARY.payload }], wallets: [] });

// ───────────────────────────── fault engine ─────────────────────────────
class Crash extends Error {}
const unhandled = [];
process.on("unhandledRejection", (e) => { if (!(e instanceof Crash)) unhandled.push(String(e?.message ?? e)); });
const mkR = (o = {}) => ({ pt: 0, crashAt: 0, errAt: 0, dead: false, outage: {}, logs: [], effects: [], trace: [], now: T0, ...o });
function op(R, kind, label, apply) {
  return Promise.resolve().then(() => {
    if (R.dead) throw new Crash("dead");
    if (R.outage[kind]) throw new Error(`${kind} outage (injected)`);
    R.pt++;
    if (R.pt === R.crashAt) { R.dead = true; throw new Crash(`${label}:pre`); }
    if (R.pt === R.errAt) { R.errLabel = `${label}:pre`; throw new Error(`transient failure of ${label} (not applied)`); }
    const out = apply();
    R.trace.push(label);
    R.pt++;
    if (R.pt === R.crashAt) { R.dead = true; throw new Crash(`${label}:post`); }
    if (R.pt === R.errAt) { R.errLabel = `${label}:post`; throw new Error(`transient failure of ${label} (applied, ack lost)`); }
    return out;
  });
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// ───────────────────────────── in-memory database ─────────────────────────────
const colOf = (t, p) => ({ __c: p, __t: t });
const tableProxy = (name) => new Proxy({ __t: name }, { get: (t, p) => (p === "__t" ? name : typeof p === "symbol" ? undefined : colOf(name, p)) });
const val = (v) => (v instanceof Date ? +v : v);
const ORM = {
  eq: (c, v) => ({ f: (r) => val(r[c.__c]) === val(v) }),
  and: (...p) => ({ f: (r) => p.filter(Boolean).every((x) => x.f(r)) }),
  or: (...p) => ({ f: (r) => p.filter(Boolean).some((x) => x.f(r)) }),
  isNull: (c) => ({ f: (r) => r[c.__c] == null }),
  isNotNull: (c) => ({ f: (r) => r[c.__c] != null }),
  gt: (c, v) => ({ f: (r) => r[c.__c] != null && val(r[c.__c]) > val(v) }),
  lt: (c, v) => ({ f: (r) => r[c.__c] != null && val(r[c.__c]) < val(v) }),
  lte: (c, v) => ({ f: (r) => r[c.__c] != null && val(r[c.__c]) <= val(v) }),
  inArray: (c, a) => ({ f: (r) => a.includes(r[c.__c]) }),
  desc: (c) => ({ desc: c }),
};
function sqlTag(strs, ...vals) {
  let text = ""; const out = [];
  strs.forEach((s, i) => {
    text += s;
    if (i < vals.length) { const v = vals[i]; if (v && v.__sql) { text += v.text; out.push(...v.vals); } else if (v && v.__c) text += `<col:${v.__c}>`; else { text += "?"; out.push(v); } }
  });
  text = text.replace(/\s+/g, " ").trim();
  const o = { __sql: true, text, vals: out }; let m;
  if ((m = /^<col:(\w+)> IS NULL$/.exec(text))) { const c = m[1]; o.f = (r) => r[c] == null; }
  if ((m = /^<col:(\w+)> >= \?$/.exec(text))) { const c = m[1]; o.f = (r) => r[c] >= out[0]; }
  if ((m = /^<col:(\w+)> ([+-]) \?$/.exec(text))) { const c = m[1], sg = m[2]; o.expr = (r) => (sg === "+" ? r[c] + out[0] : r[c] - out[0]); }
  return o;
}
sqlTag.raw = (s) => ({ __sql: true, text: s.replace(/\s+/g, " ").trim(), vals: [] });
sqlTag.join = (arr, sep) => ({ __sql: true, text: arr.map((a) => a.text).join(sep.text), vals: arr.flatMap((a) => a.vals) });
ORM.sql = sqlTag;

const newD = () => ({ tables: {}, seq: {}, keys: [], raw: {}, userActivity: [], charges: [] });
const rowsOf = (store, t) => (store.tables[t] ??= []);
function makeDb(D, R) {
  const now = () => new Date(R.now);
  const project = (row, proj) => {
    if (!proj || proj === true) return structuredClone(row);
    const o = {}; for (const [k, c] of Object.entries(proj)) o[k] = row[c.__c]; return o;
  };
  function builders(store, tx) {
    const guard = () => { if (tx?.aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block"); };
    const run = (label, apply) => op(R, "db", label, () => { guard(); return apply(); }).catch((e) => { if (tx && !(e instanceof Crash)) tx.aborted = true; throw e; });
    const mkQuery = (kind, proj, tbl = null) => {
      const q = { t: tbl, pred: null, ord: null, lim: null, ret: null, vals: null, setv: null };
      const apply = () => {
        const name = q.t.__t, rows = rowsOf(store, name);
        if (kind === "select") {
          let r = rows.filter((x) => !q.pred || q.pred.f(x));
          if (q.ord?.[0]?.desc) { const c = q.ord[0].desc.__c; r = [...r].sort((a, b) => (val(b[c]) - val(a[c])) || (b.id - a.id)); }
          if (q.lim != null) r = r.slice(0, q.lim);
          return r.map((x) => project(x, proj));
        }
        if (kind === "insert") {
          const list = Array.isArray(q.vals) ? q.vals : [q.vals], made = [];
          for (const v of list) {
            const row = { id: (store.seq[name] = (store.seq[name] ?? 0) + 1), createdAt: now(), deletedAt: null, ...structuredClone(v) };
            rows.push(row); made.push(row);
          }
          return q.ret ? made.map((x) => project(x, q.ret)) : undefined;
        }
        if (kind === "update") {
          const hit = rows.filter((x) => !q.pred || q.pred.f(x)); for (const x of hit) { const set = {}; for (const [k, v] of Object.entries(q.setv)) set[k] = v && v.__sql ? v.expr(x) : structuredClone(v); Object.assign(x, set); }
          return q.ret ? hit.map((x) => project(x, q.ret)) : undefined;
        }
        if (kind === "delete") { store.tables[name] = rows.filter((x) => q.pred && !q.pred.f(x)); return undefined; }
        throw new Error(`fake db: ${kind}`);
      };
      const api = {
        from(t) { q.t = t; return api; }, where(p) { q.pred = p; return api; }, orderBy(...o) { q.ord = o; return api; },
        limit(n) { q.lim = n; return api; }, for() { return api; }, set(v) { q.setv = v; return api; }, values(v) { q.vals = v; return api; },
        returning(p) { q.ret = p || true; return api; },
        then(res, rej) { return run(`db:${kind} ${q.t.__t}`, apply).then(res, rej); },
      };
      return api;
    };
    return {
      select: (p) => mkQuery("select", p),
      insert: (t) => mkQuery("insert", undefined, t),
      update: (t) => mkQuery("update", undefined, t),
      delete: (t) => mkQuery("delete", undefined, t),
      execute: (s) => run(`db:execute ${s.text.slice(0, 48)}`, () => execSql(s)),
    };
  }
  function execSql(s) {
    const { text, vals } = s;
    let m;
    if (/^SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = \? ORDER BY version ASC$/.test(text))
      return { rows: D.keys.filter((k) => k.namespace === vals[0]).sort((a, b) => a.version - b.version).map(({ version, wrapped_dek, active }) => ({ version, wrapped_dek, active })) };
    if (/^INSERT INTO encryption_keys \(namespace, version, wrapped_dek, active\) VALUES \(\?, 1, \?, TRUE\) ON CONFLICT \(namespace, version\) DO NOTHING$/.test(text)) {
      if (!D.keys.some((k) => k.namespace === vals[0] && k.version === 1)) D.keys.push({ namespace: vals[0], version: 1, wrapped_dek: vals[1], active: true, created_at: new Date(R.now) });
      return { rows: [] };
    }
    if (/^UPDATE encryption_keys SET active = FALSE WHERE namespace = \?$/.test(text)) { for (const k of D.keys) if (k.namespace === vals[0]) k.active = false; return { rows: [] }; }
    if (/^INSERT INTO encryption_keys \(namespace, version, wrapped_dek, active\) VALUES \(\?, \?, \?, TRUE\)$/.test(text)) {
      if (D.keys.some((k) => k.namespace === vals[0] && k.version === vals[1])) throw new Error("duplicate key value violates unique constraint (namespace, version)");
      D.keys.push({ namespace: vals[0], version: vals[1], wrapped_dek: vals[2], active: true, created_at: new Date(R.now) });
      return { rows: [] };
    }
    if (/^SELECT version, created_at FROM encryption_keys WHERE namespace = 'vault-backup' AND active = TRUE LIMIT 1$/.test(text))
      return { rows: D.keys.filter((k) => k.namespace === "vault-backup" && k.active).slice(0, 1).map(({ version, created_at }) => ({ version, created_at })) };
    if (/^SELECT version, active, created_at FROM encryption_keys WHERE namespace = 'vault-backup' ORDER BY version ASC$/.test(text))
      return { rows: D.keys.filter((k) => k.namespace === "vault-backup").sort((a, b) => a.version - b.version).map(({ version, active, created_at }) => ({ version, active, created_at })) };
    if ((m = /^INSERT INTO user_activity \(user_id, action, .*? VALUES \((\d+), '([^']*)'/.exec(text))) { D.userActivity.push({ userId: +m[1], action: m[2], text }); return { rows: [] }; }
    if ((m = /^SELECT team_id FROM vault_entries WHERE id = \?/i.exec(text)) || /FROM vault_entries/i.test(text)) return { rows: [{}] };
    if (/^INSERT INTO vault_create_idempotency \(user_id, idem_key, entity_serial\) VALUES \(\?, \?, \?\) ON CONFLICT \(user_id, idem_key\) DO NOTHING RETURNING entity_serial$/.test(text)) {
      D.idem ??= []; if (D.idem.some((k) => k.u === vals[0] && k.k === vals[1])) return { rows: [] };
      D.idem.push({ u: vals[0], k: vals[1], serial: vals[2] }); return { rows: [{ entity_serial: vals[2] }] };
    }
    if (/^SELECT entity_serial FROM vault_create_idempotency WHERE user_id = \? AND idem_key = \?$/.test(text)) return { rows: (D.idem ?? []).filter((k) => k.u === vals[0] && k.k === vals[1]).map((k) => ({ entity_serial: k.serial })) };
    if (/^SELECT 1 FROM organization_members/.test(text)) return { rows: [] };
    if (/^SELECT .* FROM (\w+) WHERE user_id = \d+/.test(text)) return { rows: [] };
    if (/^SELECT .* FROM (\w+) WHERE user_id = \?/.test(text)) return { rows: [] };
    throw new Error(`fake db: unrecognised SQL ${text}`);
  }
  const root = builders(D, null);
  root.transaction = async (fn) => {
    const store = { tables: structuredClone(D.tables), seq: { ...D.seq } }, tx = { aborted: false };
    await op(R, "db", "db:tx.begin", () => {});
    const b = builders(store, tx);
    b.transaction = async (fn) => { // SAVEPOINT: only the nested scope rolls back and the outer transaction stays usable
      const saved = structuredClone(store.tables), seq = { ...store.seq };
      try { return await fn(b); } catch (e) { if (!(e instanceof Crash)) { store.tables = saved; store.seq = seq; tx.aborted = false; } throw e; }
    }; b.execute = (s) => op(R, "db", `db:execute ${s.text.slice(0, 48)}`, () => { if (tx.aborted) throw new Error("current transaction is aborted"); return execSql(s); });
    const out = await fn(b);
    // pg semantics: COMMIT of an aborted transaction silently rolls back.
    await op(R, "db", "db:tx.commit", () => { if (!tx.aborted) { D.tables = store.tables; D.seq = store.seq; } });
    return out;
  };
  return root;
}

// ───────────────────────────── module world (real TS, fake edges) ─────────────────────────────
const tsCache = new Map();
const transpile = (file, text) => {
  const k = sha256(file + "\0" + text);
  if (!tsCache.has(k)) tsCache.set(k, ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  return tsCache.get(k);
};
const safeJson = (a) => { try { return JSON.stringify(a, (k, v) => (v instanceof Error ? v.message : typeof v === "bigint" ? String(v) : v)); } catch { return "[unserialisable]"; } };

function makeWorld(D, R, patches = {}) {
  const W = { D, R, cron: [], timers: [], mods: new Map() };
  const log = (src, a) => { if (!R.dead) R.logs.push(`${src}: ${safeJson(a)}`); };
  const db = makeDb(D, R);
  const fdb = new Proxy({ db, ...ORM }, { get: (t, p) => (p in t ? t[p] : typeof p === "string" && p.endsWith("Table") ? (t[p] ??= tableProxy(p)) : undefined) });
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [R.now])); }
    static now() { return R.now; }
    toLocaleString() { return "WHEN"; } toLocaleDateString() { return "DAY"; }
  }
  const fakeFetch = async (url, init = {}) => op(R, "net", "net:fetch", () => {
    if (D.fetchHandler) return D.fetchHandler(String(url), init); // provider model (Drive/Dropbox) for the real cloud-upload scenario
    R.effects.push({ t: "fetch", url: String(url), body: String(init.body ?? ""), blobHash: blobHashOf(init.body), idem: init.headers?.["Idempotency-Key"] }); return { ok: true, status: 200, type: "basic" };
  });
  const cons = { log: (...a) => log("console.log", a), error: (...a) => log("console.error", a), warn: (...a) => log("console.warn", a), info: (...a) => log("console.info", a), debug: () => {} };
  const shadow = { Date: FakeDate, fetch: fakeFetch, console: cons };
  const sink = (name, kind = "net") => async (...a) => op(R, kind, `net:${name}`, () => { R.effects.push({ t: name, a: safeJson(a) }); });
  const mocks = {
    "@workspace/db": fdb, "drizzle-orm": ORM, crypto: nodeCrypto, "node:crypto": nodeCrypto,
    "node-cron": { schedule: (expr, fn) => { W.cron.push(fn); return { stop() {} }; }, validate: () => true },
  };
  const lib = {
    "lib/logger": () => ({ logger: Object.fromEntries(["error", "warn", "info", "debug"].map((l) => [l, (...a) => log(`logger.${l}`, a)])) }),
    "lib/log-bus": () => ({ logBus: Object.fromEntries(["system", "error", "warn"].map((l) => [l, (...a) => log(`logBus.${l}`, a)])) }),
    "lib/email": () => ({ sendEmail: async (m) => op(R, "net", "net:email", () => { R.effects.push({ t: "email", to: m.to, subject: m.subject, text: m.text, html: m.html, idem: m.messageId, blobHash: blobHashOf(m.attachments?.[0]?.content?.toString?.("utf8")) }); return { success: true }; }) }),
    "lib/ssrf-guard": () => ({ assertPublicHttpsUrl: async () => {} }),
    "lib/activity-log": () => ({ logSubjectActivity: sink("subject-activity", "db") }),
    "services/credit-meter": () => ({ chargeCredits: async (u, k, o) => op(R, "db", "db:charge", () => {
      // contract of the real chargeCredits (exercised for real by the credit-ledger scenario): atomic debit + ledger row; a charge with the same
      // referenceId inside dedupeWithinMs is a retry and is not charged again
      const prior = o?.referenceId && o.dedupeWithinMs ? D.charges.find((c) => c.u === u && c.k === k && c.ref === o.referenceId && R.now - c.t < o.dedupeWithinMs) : null;
      if (prior) return { ok: true, charged: 0, newBalance: 99, txId: 1, duplicate: true };
      D.charges.push({ u, k, ref: o?.referenceId, t: R.now }); return { ok: true, charged: 1, newBalance: 99 };
    }) }),
    "lib/jwt": () => ({ signOAuthState: () => "state", verifyOAuthState: () => null }),
    "vault/crypto/field-encryption": () => ({ encryptField: (x) => x, decryptField: (x) => x }), // only reached by the real-cloud scenario (see OFF_WHEN)
    "routes/events": () => ({ broadcastEvent: () => {} }),
    "middlewares/auth": () => ({ getRequestUser: () => null }),
    "vault/infrastructure/backup/alerts": () => ({ alertUserOfScheduledBackupResult: sink("alert-run"), alertUserOfMissedBackup: sink("alert-missed"), alertAdminsOfStaleKeyRotation: sink("alert-stale-key") }),
    "vault/infrastructure/backup/cloud": () => ({ uploadToGoogleDrive: async (u, f, blob) => op(R, "net", "net:drive", () => { R.effects.push({ t: "drive", blobHash: blobHashOf(blob) }); }), uploadToDropbox: sink("dropbox") }),
    "services/sync": () => ({ syncOnVaultUpdate: async () => {}, syncOnVaultStatusChange: async () => {} }),
    "vault/infrastructure/jobs/cron-scheduler": () => ({ scheduleCronJob: (expr, fn) => { W.cron.push(fn); }, validateCronExpression: () => true }),
    "vault/application/snapshot": () => ({
      buildVaultSnapshotPayload: async (uid) => op(R, "db", "db:build-payload", () => ({ json: PAYLOAD_JSON, vaultCount: 1, walletsCount: 0 })),
      get storeSnapshotRow() { return W.load("vault/application/snapshot/store.ts").storeSnapshotRow; },
    }),
    "vault/application/entity": () => ({ get logVaultActivity() { return W.load("vault/application/entity/activity.ts").logVaultActivity; }, get logVaultActivityStrict() { return W.load("vault/application/entity/activity.ts").logVaultActivityStrict; } }),
  };
  const resolve = (spec, from) => {
    if (mocks[spec] !== undefined) return { mock: mocks[spec] };
    if (/aes-gcm\.mjs$/.test(spec)) return { mock: AES };
    if (!spec.startsWith(".")) throw new Error(`unmocked bare import ${spec} from ${path.relative(SRC, from)}`);
    const abs = path.resolve(path.dirname(from), spec), rel = path.relative(SRC, abs).split(path.sep).join("/");
    if (lib[rel] && !(OFF_WHEN[rel] && D[OFF_WHEN[rel]]) && !(rel === "vault/crypto/field-encryption" && !D.realCloud)) return { mock: (W.mods.get(`mock:${rel}`) ?? (W.mods.set(`mock:${rel}`, lib[rel]()), W.mods.get(`mock:${rel}`))) };
    for (const e of [".ts", "/index.ts"]) if (fs.existsSync(abs + e)) return { file: abs + e };
    if (/^(lib|services|routes|middlewares)\//.test(rel)) throw new Error(`unmocked non-vault import ${rel}`);
    throw new Error(`unresolved ${spec} from ${from}`);
  };
  W.load = (relFile) => {
    const file = path.join(SRC, relFile);
    if (W.mods.has(file)) return W.mods.get(file).exports;
    let text = fs.readFileSync(file, "utf8");
    if (patches[relFile]) { const t = patches[relFile](text); if (t === text) throw new Error(`mutation did not change ${relFile} (fail closed)`); text = t; }
    const code = transpile(file, text), m = { exports: {} };
    W.mods.set(file, m);
    const names = Object.keys(shadow);
    new Function("require", "module", "exports", "__filename", ...names, code)((s) => { const r = resolve(s, file); return "mock" in r ? r.mock : W.load(path.relative(SRC, r.file)); }, m, m.exports, file, ...names.map((n) => shadow[n]));
    return m.exports;
  };
  W.load("vault/infrastructure/crypto-key-stores.ts"); // composition root: registers the key stores behind the crypto ports
  return W;
}
const OFF_WHEN = { "services/credit-meter": "realCredit", "vault/infrastructure/backup/cloud": "realCloud" }; // scenarios that run the REAL module instead of its mock
const blobHashOf = (b) => (typeof b === "string" && b.length ? sha256(/"blob":"([^"]+)"/.exec(b)?.[1] ?? b) : null);

// ───────────────────────────── sweep driver ─────────────────────────────
const SCEN = [];
async function sweep(s, patches = {}) {
  const families = s.families ?? ["crash", "error"];
  const out = { name: s.name, tasks: s.tasks, points: 0, runs: 0, violations: [], residuals: {}, stats: {} };
  const note = (v, ctx) => out.violations.push({ ...v, at: ctx });
  let curFam = "none";
  const res = (id, n = 1) => { if (curFam === "none") out.violations.push({ rule: "residual-without-fault", message: `${id} occurred in a fault-free run`, at: { fam: "none", cp: 0, label: null } }); out.residuals[id] = (out.residuals[id] ?? 0) + n; };
  // dry run (no fault) fixes the number of I/O points and must itself satisfy the invariants
  const R0 = mkR({ outage: s.outage ?? {} }), D0 = await s.setup(); const o0 = await s.action(makeWorld(D0, R0, patches), R0);
  out.points = R0.pt;
  const modes = [{ fam: "none", cp: 0 }, ...families.flatMap((fam) => Array.from({ length: R0.pt }, (_, i) => ({ fam, cp: i + 1 })))];
  for (const { fam, cp } of modes) {
    curFam = fam;
    const D = fam === "none" ? D0 : await s.setup(), R1 = fam === "none" ? R0 : mkR({ outage: s.outage ?? {}, ...(fam === "crash" ? { crashAt: cp } : { errAt: cp }) });
    const u0 = unhandled.length;
    const run1 = fam === "none" ? o0 : await s.action(makeWorld(D, R1, patches), R1);
    await settle();
    const midD = structuredClone({ tables: D.tables, keys: D.keys, userActivity: D.userActivity, charges: D.charges });
    const R2 = mkR({ now: R1.now + (s.retryAfterMs ?? 61 * MIN) });
    const run2 = await s.recover(makeWorld(D, R2, patches), R2, { run1, R1, midD, fam, cp });
    await settle();
    out.runs++;
    const ctx = { fam, cp, fault: R1.dead ? "crash" : R1.errLabel ?? "none", label: R1.errLabel ?? R1.trace[Math.max(0, R1.trace.length - 1)] ?? null };
    const newUnhandled = unhandled.slice(u0);
    if (newUnhandled.length) note({ rule: "unhandled-rejection", message: `an unhandled promise rejection would terminate the process: ${newUnhandled[0]}` }, ctx);
    await s.check({ D, R1, R2, run1, run2, midD, fam, cp, note: (v) => note(v, ctx), res, stat: (k, n = 1) => { out.stats[k] = (out.stats[k] ?? 0) + n; } }, ctx);
  }
  return out;
}
const leaks = (R1, R2, D) => {
  const hay = [...R1.logs, ...R2.logs, safeJson(R1.effects.filter((e) => e.t !== "fetch" && e.t !== "email" && e.t !== "drive").map((e) => ({ ...e }))), safeJson(R2.effects.filter((e) => e.t !== "fetch" && e.t !== "email" && e.t !== "drive")),
    safeJson(D.tables), safeJson(D.keys), safeJson(D.userActivity), ...[...R1.effects, ...R2.effects].filter((e) => e.t === "email").map((e) => `${e.subject}${e.text}${e.html}`),
    ...[...R1.effects, ...R2.effects].filter((e) => e.t === "fetch").map((e) => e.body)].join("\n");
  return SECRET_STRINGS.filter((s) => hay.includes(s));
};


// ───────────────────────────── shared invariants ─────────────────────────────
const D_ROWS = (D, t) => D.tables[t] ?? [];
function keyChainViolations(D, note, { expectSingleActive = true } = {}) {
  const ks = D.keys.filter((k) => k.namespace === "vault-backup"), vs = ks.map((k) => k.version);
  if (new Set(vs).size !== vs.length) note({ rule: "corruption", message: `duplicate key versions ${vs}` });
  if (expectSingleActive) {
    const act = ks.filter((k) => k.active);
    if (act.length !== 1 || (ks.length && act[0].version !== Math.max(...vs))) note({ rule: "unrecoverable", message: `key chain not healed: active versions [${act.map((k) => k.version)}] of [${vs}]` });
  }
}
async function snapshotIntegrity(D, R2) {
  const W = makeWorld(D, mkR({ now: R2.now })), env = W.load("vault/crypto/backup-envelope.ts"), st = W.load("vault/application/snapshot/store.ts"), bad = [];
  for (const row of D_ROWS(D, "vaultSnapshotsTable")) {
    try { st.verifyStoredChecksum(row); } catch { bad.push(`snapshot ${row.id}: checksum mismatch`); }
    try { if ((await env.envelopeDecryptBackup(row.blob, row.userId)) !== PAYLOAD_JSON) bad.push(`snapshot ${row.id}: decrypts to a different payload`); } catch (e) { bad.push(`snapshot ${row.id}: undecryptable (${e.message})`); }
    if (row.blob.includes(CANARY.payload)) bad.push(`snapshot ${row.id}: plaintext in stored blob`);
  }
  return bad;
}

// ───────────────────────────── scenario: scheduled backup worker ─────────────────────────────
const cronWorld = async (W, mod, starter) => { W.load(mod)[starter](); return W.cron.at(-1); };
function backupScenario(destination, outage) {
  return {
    name: `backup-worker:${destination}${outage ? `:${Object.keys(outage)[0]}-outage` : ""}`, tasks: outage?.db ? [5, 9, 12] : outage?.net ? [6, 9, 10, 12] : [2, 9, 10, 11, 12],
    outage, families: outage ? [] : ["crash", "error"],
    async setup() {
      const D = newD();
      D.tables.vaultBackupSchedulesTable = [{ id: 1, userId: 7, enabled: true, frequency: "daily", dayOfWeek: 1, dayOfMonth: 1, hourOfDay: 3, includeAttachments: false, destination, destinationEmail: "owner@example.test", webhookUrl: "https://hooks.example.test/in", webhookSecret: "whsec", nextRunAt: new Date(T0 - 1000), runningSince: null, lastRunStatus: null, lastRunError: null }];
      D.tables.usersTable = [{ id: 7, email: "owner@example.test" }]; D.seq.vaultBackupSchedulesTable = 1; return D;
    },
    async action(W) { const tick = await cronWorld(W, "vault/application/backup/schedule-cron.ts", "startVaultBackupScheduleCron"); tick(); tick(); await settle(); return {}; }, // two overlapping ticks
    async recover(W2) { const tick = await cronWorld(W2, "vault/application/backup/schedule-cron.ts", "startVaultBackupScheduleCron"); tick(); await settle(); tick(); await settle(); return {}; },
    async check({ D, R1, R2, midD, note, res, stat }) {
      const sch = D.tables.vaultBackupSchedulesTable[0];
      if (sch.runningSince || !["success", "failed"].includes(sch.lastRunStatus) || +new Date(sch.nextRunAt) <= R2.now)
        note({ rule: "unrecovered", message: `schedule not recovered after restart: runningSince=${sch.runningSince} status=${sch.lastRunStatus} nextRunAt=${sch.nextRunAt}` });
      if (sch.lastRunStatus === "failed" && !sch.lastRunError) note({ rule: "hidden-failure", message: "run marked failed without an error recorded" });
      for (const b of await snapshotIntegrity(D, R2)) note({ rule: "corruption", message: b });
      const n1 = D_ROWS(midD, "vaultSnapshotsTable").length, n = D_ROWS(D, "vaultSnapshotsTable").length;
      if (n > Math.max(n1, 1)) note({ rule: "duplicate-side-effect", message: `${n} snapshots after ${n1} before recovery: the retry stored another one instead of finishing the interrupted run` });
      if (n === 0 && sch.lastRunStatus !== "failed") note({ rule: "lost-backup", message: "no snapshot stored although the run reports success" });
      if (R1.trace.filter((t) => t === "db:build-payload").length > 1) note({ rule: "duplicate-side-effect", message: "two overlapping ticks both built a backup (claim guard failed)" });
      // A crash between "the receiver accepted the copy" and "the delivery was recorded" makes the resumed run send the same snapshot again. Exactly-once on the wire
      // is impossible, so the requirement is: at most twice, only after a fault, and every send carries the same identity the receiver can dedupe on.
      const sends = {}; for (const e of [...R1.effects, ...R2.effects]) if (e.blobHash) (sends[e.blobHash] ??= []).push(e);
      for (const list of Object.values(sends)) {
        if (list.length > 2 || (list.length > 1 && !(R1.crashAt || R1.errAt))) note({ rule: "duplicate-side-effect", message: "the same backup blob was delivered off-vault more than twice, or twice without a fault" });
        else if (list.length === 2) {
          const ids = new Set(list.map((e) => e.idem));
          if (ids.size !== 1 || ids.has(undefined)) note({ rule: "duplicate-side-effect", message: "the same snapshot was delivered twice without a shared identity (Idempotency-Key / Message-ID) the receiver can dedupe on" });
          else stat("redeliveries_carrying_the_same_identity");
        }
        if (list.some((e) => e.idem !== undefined && e.idem !== `vault-snapshot-${D_ROWS(D, "vaultSnapshotsTable")[0]?.id}` && !String(e.idem).includes(`vault-snapshot-${D_ROWS(D, "vaultSnapshotsTable")[0]?.id}@`))) note({ rule: "corruption", message: `delivery identity ${list[0].idem} is not derived from the snapshot id` });
      }
      const okDel = {}; for (const d of D_ROWS(D, "vaultBackupDeliveriesTable")) if (d.status === "success") okDel[`${d.snapshotId}/${d.destination}`] = (okDel[`${d.snapshotId}/${d.destination}`] ?? 0) + 1;
      if (Object.values(okDel).some((c) => c > 1)) note({ rule: "duplicate-side-effect", message: "a snapshot has two successful delivery records for one destination" });
      keyChainViolations(D, note);
      const lk = leaks(R1, R2, D); if (lk.length) note({ rule: "plaintext-leak", message: `secret material found outside the encrypted blob: ${lk.map((x) => x.slice(0, 12) + "…")}` });
      for (const r of D_ROWS(D, "vaultSnapshotsTable")) if (!D.userActivity.some((a) => new RegExp(`'vault_snapshot', ${r.id},`).test(a.text))) note({ rule: "missing-audit", message: `snapshot ${r.id} has no vault_backup_scheduled_run activity entry` });
      if (!R1.crashAt && !R1.errAt && !outage?.db) {
        if (n !== 1) note({ rule: "vacuous", message: `fault-free run stored ${n} snapshots, expected exactly 1` });
        if (destination !== "store" && !outage?.net && ![...R1.effects, ...R2.effects].some((e) => e.blobHash)) note({ rule: "vacuous", message: "fault-free run never delivered the backup off-vault" });
      }
      if (destination !== "store" && outage?.net && !(sch.lastRunError ?? "").includes("delivery failed") && D_ROWS(D, "vaultSnapshotsTable").length) note({ rule: "hidden-failure", message: "storage outage during delivery was not surfaced on the schedule" });
      if (outage?.net && !D_ROWS(D, "vaultBackupDeliveriesTable").some((d) => d.status === "failed") && destination === "webhook") note({ rule: "hidden-failure", message: "failed delivery was not recorded" });
    },
  };
}


// ───────────────────────────── scenario: off-vault cloud delivery (real delivery.ts + cloud.ts against a Drive/Dropbox model) ─────────────────────────────
const CLOUD_SNAP = { id: 5, label: null, blob: "ENCRYPTED-BLOB-5", sizeBytes: 16, entriesCount: 1, walletsCount: 0, createdAt: new Date(T0) };
const cloudFileName = `ayzen-vault-backup-${+new Date(T0)}.ayzenbak`;
function cloudScenario(provider) {
  return {
    name: `cloud-delivery:${provider}`, tasks: [6, 9, 10, 12], families: ["crash", "error"],
    async setup() {
      const D = newD(); D.realCloud = true; D.cloudFiles = [];
      D.tables.vaultBackupCloudConnectionsTable = [{ id: 1, userId: 7, provider, accessToken: "tok", refreshToken: null, expiresAt: null, folderId: provider === "google_drive" ? "F" : null }]; D.seq.vaultBackupCloudConnectionsTable = 1;
      const J = (o, status = 200) => ({ ok: status < 300, status, type: "basic", json: async () => o, text: async () => JSON.stringify(o) });
      D.fetchHandler = (url, init) => {
        if (provider === "google_drive") {
          if (init.method !== "POST" && /drive\/v3\/files\?q=/.test(url)) {
            const q = decodeURIComponent(/q=([^&]+)/.exec(url)[1]);
            if (/mimeType=/.test(q)) return J({ files: [{ id: "F" }] });
            const name = /name='([^']+)'/.exec(q)?.[1];
            return J({ files: D.cloudFiles.filter((f) => f.name === name).map((f) => ({ id: f.id })) });
          }
          if (/upload\/drive\/v3\/files\?uploadType=multipart/.test(url)) {
            const body = String(init.body), name = /"name":"([^"]+)"/.exec(body)[1], blob = /octet-stream\r\n\r\n([\s\S]*)\r\n--ayzen-backup-boundary--/.exec(body)[1];
            D.cloudFiles.push({ id: `f${D.cloudFiles.length + 1}`, name, blob }); return J({ id: `f${D.cloudFiles.length}` });
          }
        } else if (/content\.dropboxapi\.com\/2\/files\/upload/.test(url)) {
          const arg = JSON.parse(init.headers["Dropbox-API-Arg"]), name = arg.path.split("/").pop(), blob = String(init.body), i = D.cloudFiles.findIndex((f) => f.name === name);
          if (i >= 0 && arg.mode === "overwrite") { D.cloudFiles[i].blob = blob; return J({}); }
          if (i >= 0 && arg.mode === "add") { if (!arg.autorename) return J({ error: "path/conflict" }, 409); D.cloudFiles.push({ id: `f${D.cloudFiles.length + 1}`, name: `${name} (1)`, blob }); return J({}); }
          D.cloudFiles.push({ id: `f${D.cloudFiles.length + 1}`, name, blob }); return J({});
        }
        throw new Error(`cloud model: unexpected request ${init.method ?? "GET"} ${url}`);
      };
      return D;
    },
    async action(W) { try { return { out: await W.load("vault/infrastructure/backup/delivery.ts").deliverSnapshot(7, { destination: provider }, CLOUD_SNAP) }; } catch (e) { return { thrown: e.message }; } finally { await settle(); } },
    async recover(W2) { try { return { out: await W2.load("vault/infrastructure/backup/delivery.ts").deliverSnapshot(7, { destination: provider }, CLOUD_SNAP) }; } catch (e) { return { thrown: e.message }; } finally { await settle(); } },
    async check({ D, run2, note }) {
      if (!run2.out?.ok) note({ rule: "unrecoverable", message: `re-delivery after the interruption failed: ${JSON.stringify(run2.out ?? run2.thrown)}` });
      const same = D.cloudFiles.filter((f) => f.name === cloudFileName), other = D.cloudFiles.filter((f) => f.name !== cloudFileName);
      if (same.length === 0) note({ rule: "lost-backup", message: "the snapshot is not in the provider after the retry" });
      if (same.length + other.length > 1) note({ rule: "duplicate-side-effect", message: `${same.length + other.length} copies of one snapshot in the provider (${D.cloudFiles.map((f) => f.name.slice(-22))})` });
      if (D.cloudFiles.some((f) => f.blob !== CLOUD_SNAP.blob)) note({ rule: "corruption", message: "a stored copy differs from the snapshot blob" });
    },
  };
}

// ───────────────────────────── scenario: key rotation ─────────────────────────────
function rotationScenario(manual) {
  return {
    name: `key-rotation:${manual ? "manual-admin" : "automatic-cron"}`, tasks: [7, 9, 10, 12], families: ["crash", "error"],
    async setup() {
      const D = newD(), R = mkR({ now: T0 - 100 * DAY }), W = makeWorld(D, R), env = W.load("vault/crypto/backup-envelope.ts");
      await env.loadBackupEnvelopeKeyManager(); D.blobs = [{ blob: (await env.envelopeEncryptBackup(PAYLOAD_JSON, 7)).blob, user: 7 }]; return D;
    },
    async action(W, R) {
      if (manual) { try { await W.load("vault/application/backup/key.ts").rotateBackupKey(1, { ip: "203.0.113.9", headers: {} }); } catch (e) { return { thrown: e.message }; } return {}; }
      const tick = await cronWorld(W, "vault/infrastructure/backup/key-rotation-cron.ts", "startVaultBackupKeyRotationCron"); tick(); await settle(); return {};
    },
    async recover(W2) { const tick = await cronWorld(W2, "vault/infrastructure/backup/key-rotation-cron.ts", "startVaultBackupKeyRotationCron"); tick(); await settle(); return {}; },
    async check({ D, R1, R2, note }) {
      const W = makeWorld(D, mkR({ now: R2.now })), env = W.load("vault/crypto/backup-envelope.ts");
      try {
        await env.loadBackupEnvelopeKeyManager();
        for (const b of D.blobs) if ((await env.envelopeDecryptBackup(b.blob, b.user)) !== PAYLOAD_JSON) note({ rule: "corruption", message: "a backup written before the rotation no longer decrypts to its payload" });
        const fresh = await env.envelopeEncryptBackup(PAYLOAD_JSON, 7); if ((await env.envelopeDecryptBackup(fresh.blob, 7)) !== PAYLOAD_JSON) note({ rule: "corruption", message: "new backup does not round-trip" });
      } catch (e) { note({ rule: "unrecoverable", message: `key manager cannot load or use the chain after the fault: ${e.message}` }); }
      keyChainViolations(D, note);
      const aud = D_ROWS(D, "vaultBackupAuditLogTable").filter((a) => a.eventType === "key_rotated");
      for (const v of D.keys.map((k) => k.version).filter((v) => v > 1)) {
        const c = aud.filter((a) => a.keyVersion === v).length;
        if (c === 0) note({ rule: "missing-audit", message: `key v${v} exists but has no key_rotated audit event` });
        if (c > 1) note({ rule: "duplicate-side-effect", message: `key v${v} has ${c} key_rotated audit events` });
      }
      const wrapped = D.keys.map((k) => k.wrapped_dek), hay = safeJson(D.tables) + R1.logs.join("") + R2.logs.join("");
      if (wrapped.some((w) => hay.includes(w))) note({ rule: "plaintext-leak", message: "wrapped key material appears in audit/log output" });
      const lk = leaks(R1, R2, { tables: {}, keys: [], userActivity: [] }); if (lk.length) note({ rule: "plaintext-leak", message: `secret in logs: ${lk.map((x) => x.slice(0, 12) + "…")}` });
    },
  };
}

// ───────────────────────────── scenario: restore ─────────────────────────────
const SNAP = { vault: [{ projectName: "Existing" }, { projectName: "Alpha", username: CANARY.user, accountPassword: CANARY.pw }, { projectName: "Beta", emailPassword: `${CANARY.pw}-e` }], wallets: [{ chain: "eth", address: "0xabc" }] };
const restoreScenario = {
  name: "snapshot-restore", tasks: [8, 9, 11, 12], families: ["crash", "error"],
  async setup() { const D = newD(); D.tables.vaultEntriesTable = [{ id: 1, userId: 7, projectName: "Existing", deletedAt: null }]; D.seq.vaultEntriesTable = 1; return D; },
  async action(W) { try { return { r: await W.load("vault/application/snapshot/restore.ts").applyRestoreDiff(7, structuredClone(SNAP)) }; } catch (e) { return { thrown: e.message }; } },
  async recover(W2) {
    const { applyRestoreDiff } = W2.load("vault/application/snapshot/restore.ts"), out = {};
    out.r2 = await applyRestoreDiff(7, structuredClone(SNAP)); out.r3 = await applyRestoreDiff(7, structuredClone(SNAP)); return out;
  },
  async check({ D, R1, R2, run1, run2, midD, fam, note, res }) {
    const added = D_ROWS(midD, "vaultEntriesTable").length - 1 + D_ROWS(midD, "walletsTable").length;
    // A crash is all-or-nothing (one transaction). A transient error on one row skips just that row (savepoint) and says so; the retry adds it.
    const reportedSkip = fam === "error" && run1.r && run1.r.skipped > 0 && run1.r.restored === added;
    if (added !== 0 && added !== 3 && !reportedSkip) note({ rule: "corruption", message: `partial restore left ${added} of 3 rows behind without reporting a skipped row` });
    const names = D_ROWS(D, "vaultEntriesTable").map((r) => r.projectName).sort().join(","), wallets = D_ROWS(D, "walletsTable").length;
    if (names !== "Alpha,Beta,Existing" || wallets !== 1) note({ rule: "corruption", message: `after retry the vault holds [${names}] + ${wallets} wallet(s); expected exactly one of each` });
    if (run2.r3.restored !== 0) note({ rule: "duplicate-side-effect", message: `third restore of the same snapshot inserted ${run2.r3.restored} rows (not idempotent)` });
    for (const r of D_ROWS(D, "vaultEntriesTable").filter((x) => x.projectName !== "Existing")) {
      for (const f of ["accountPassword", "emailPassword"]) if (r[f] != null && !String(r[f]).startsWith("enc:")) note({ rule: "plaintext-leak", message: `restored ${f} stored without field encryption` });
    }
    const lk = leaks(R1, R2, D); if (lk.length) note({ rule: "plaintext-leak", message: `secret found in state/logs: ${lk.map((x) => x.slice(0, 12) + "…")}` });
    if (run1.r && run1.r.restored !== added) note({ rule: "misreported-restore", message: `response reports ${run1.r.restored} rows restored but ${added} are committed` });
  },
};

// ───────────────────────────── scenario: secret write + events ─────────────────────────────
const BODY = { projectName: "Acme", username: CANARY.user, accountPassword: CANARY.pw, emailPassword: `${CANARY.pw}-e`, seedPhrase: CANARY.seed, email: "a@b.test", notes: "n" };
const entityComplete = (r) => r.encryptedSeedPhrase && String(r.accountPassword ?? "").startsWith("enc:") && String(r.emailPassword ?? "").startsWith("enc:") && r.username === CANARY.user;
function createScenario(eventFaults, keyed = false) {
  return {
    name: `entity-create${eventFaults ? ":event-faults" : ""}${keyed ? ":idempotency-key" : ""}`, tasks: eventFaults ? [4, 9, 12] : [3, 9, 11, 12], families: ["crash", "error"],
    async setup() { return newD(); },
    async action(W) {
      const { createEntity } = W.load("vault/application/entity/create.ts");
      const deps = { broadcastEvent: () => { if (eventFaults) throw new Error("sse hub: socket closed"); }, autoCreateLocalAccounts: async () => { if (eventFaults) throw new Error("bridge down"); } };
      try { const out = await createEntity(7, structuredClone(BODY), deps, keyed ? "key-1" : undefined); await settle(); return { out }; } catch (e) { await settle(); return { thrown: e.message }; }
    },
    async recover(W2) { const { createEntity } = W2.load("vault/application/entity/create.ts"); try { return { out: await createEntity(7, structuredClone(BODY), { broadcastEvent() {}, autoCreateLocalAccounts: async () => {} }, keyed ? "key-1" : undefined) }; } catch (e) { return { thrown: e.message }; } },
    async check({ D, R1, R2, run1, run2, midD, fam, note, res }) {
      const mid = D_ROWS(midD, "vaultEntriesTable");
      if (mid.length > 1) note({ rule: "duplicate-side-effect", message: `one create request produced ${mid.length} entities` });
      for (const r of mid) if (!entityComplete(r)) note({ rule: "corruption", message: "stored entity is missing sealed fields (seed phrase / passwords / username) although the request was acknowledged or retried as complete" });
      if (run1.out?.status === 201 && mid.length !== 1) note({ rule: "corruption", message: "201 returned without a stored entity" });
      if (eventFaults && fam === "none" && run1.out?.status !== 201) note({ rule: "event-failure-breaks-write", message: `an event/bridge failure after commit turned the request into ${run1.out?.status ?? `an exception (${run1.thrown})`}` });
      if (run2.out?.status !== 201) note({ rule: "unrecoverable", message: "client retry after the fault could not create the entity" });
      const final = D_ROWS(D, "vaultEntriesTable"); for (const r of final) if (!entityComplete(r)) note({ rule: "corruption", message: "entity row incomplete after retry" });
      if (keyed && final.length !== 1) note({ rule: "duplicate-side-effect", message: `a retry with the same Idempotency-Key left ${final.length} entities` });
      if (!keyed && mid.length === 1 && final.length === 2 && run1.out?.status !== 201) res("create-client-retry-duplicate");
      const lk = leaks(R1, R2, D); if (lk.length) note({ rule: "plaintext-leak", message: `secret found in state/logs: ${lk.map((x) => x.slice(0, 12) + "…")}` });
    },
  };
}

// ───────────────────────────── scenario: secret update (PATCH) ─────────────────────────────
const PATCH = { username: "renamed-user", accountPassword: `${CANARY.pw}-n`, seedPhrase: CANARY.seed, notes: "n2", tags: ["t1"] };
const updateScenario = {
  name: "entity-update", tasks: [3, 9, 11, 12], families: ["crash", "error"],
  async setup() {
    const D = newD(), W = makeWorld(D, mkR());
    D.tables.vaultEntriesTable = [{ id: 1, userId: 7, projectName: "Acme", username: "old-user", notes: "n", deletedAt: null, encryptedSeedPhrase: W.load("vault/crypto/seed-phrase.ts").encryptSeedPhrase("old-seed") }]; D.seq.vaultEntriesTable = 1; return D;
  },
  async action(W) { return patch(W, false); },
  async recover(W2) { return patch(W2, true); },
  async check({ D, R1, R2, run1, run2, midD, note }) {
    const mid = D_ROWS(midD, "vaultEntriesTable")[0], fin = D_ROWS(D, "vaultEntriesTable")[0], W = makeWorld(D, mkR()), seed = W.load("vault/crypto/seed-phrase.ts");
    const full = (r) => r.username === "renamed-user" && String(r.accountPassword ?? "").startsWith("enc:") && r.notes === "n2" && r.encryptedSeedPhrase && seed.decryptSeedPhrase(r.encryptedSeedPhrase) === CANARY.seed;
    if (run1.out?.status === 200 && !full(mid)) note({ rule: "corruption", message: "PATCH answered 200 but the stored entity is missing part of the update (seed phrase / credentials silently dropped)" });
    if (run2.out?.status !== 200 || !full(fin)) note({ rule: "unrecoverable", message: "retrying the PATCH after the fault did not converge to the full update" });
    if (D_ROWS(D, "vaultEntriesTable").length !== 1) note({ rule: "duplicate-side-effect", message: "update created or lost an entity row" });
    const lk = leaks(R1, R2, D); if (lk.length) note({ rule: "plaintext-leak", message: `secret found in state/logs: ${lk.map((x) => x.slice(0, 12) + "…")}` });
  },
};
async function patch(W, retry) {
  const { updateEntity } = W.load("vault/application/entity/update.ts");
  try { const out = await updateEntity(7, "1", structuredClone(PATCH), { broadcastEvent() {}, autoCreateLocalAccounts: async () => {}, runHealthCheck: async () => {} }); await settle(); return { out }; } catch (e) { await settle(); return { thrown: e.message }; }
}

// ───────────────────────────── scenario: seed reveal (restart during active request) ─────────────────────────────
const revealSetup = async () => {
  const D = newD(), W = makeWorld(D, mkR());
  D.tables.vaultEntriesTable = [{ id: 1, userId: 7, projectName: "Acme", deletedAt: null, encryptedSeedPhrase: W.load("vault/crypto/seed-phrase.ts").encryptSeedPhrase(CANARY.seed) }]; D.seq.vaultEntriesTable = 1; return D;
};
const revealChecks = (expectedCharges) => async ({ D, R1, R2, run1, run2, midD, fam, note }) => {
  const delivered = [run1, run2].filter((r) => r.out?.status === 200 && r.out.body?.seedPhrase === CANARY.seed).length;
  if (run2.out?.status !== 200) note({ rule: "unrecoverable", message: `reveal after restart + fresh token returned ${run2.out?.status ?? run2.thrown}` });
  const c1 = midD.charges.length, charges = D.charges.length;
  if (run1.out?.status === 200 && c1 !== 1) note({ rule: "duplicate-side-effect", message: `a delivered reveal was charged ${c1} times` });
  if (charges < Math.min(delivered, expectedCharges)) note({ rule: "corruption", message: "a delivered reveal was never charged" });
  if (charges > expectedCharges) note({ rule: "duplicate-side-effect", message: `${charges} charges for one reveal and its retry (expected ${expectedCharges})` });
  const audited = D_ROWS(D, "vaultActivityLogTable").filter((a) => a.action === "seed_revealed").length;
  if (audited < delivered) note({ rule: "missing-audit", message: `${delivered} seed(s) delivered but only ${audited} seed_revealed audit row(s) exist` });
  if (run1.out?.status === 503 && c1 !== 0) note({ rule: "duplicate-side-effect", message: "a reveal refused for lack of an audit row was still charged" });
  const lk = leaks(R1, R2, D); if (lk.length) note({ rule: "plaintext-leak", message: `seed phrase found in state/logs: ${lk.map((x) => x.slice(0, 12) + "…")}` });
};
const revealScenario = {
  name: "seed-reveal-request", tasks: [1, 9, 10, 11], families: ["crash", "error"],
  retryAfterMs: 90 * 1000, // the user re-verifies the PIN and retries within a couple of minutes (inside the 5-minute retry window)
  setup: revealSetup,
  async action(W) { return reveal(W, "tok"); },
  async recover(W2) { return reveal(W2, "tok2"); }, // restart lost the in-memory reveal token: the user re-verifies the PIN
  check: revealChecks(1),
};
// a deliberate second reveal long after the retry window is a new reveal and is charged again (the dedupe must not make reveals free)
const revealLaterScenario = {
  name: "seed-reveal-later", tasks: [1], families: [], retryAfterMs: 61 * MIN,
  setup: revealSetup,
  async action(W) { return reveal(W, "tok"); },
  async recover(W2) { return reveal(W2, "tok2"); },
  async check(ctx) { await revealChecks(2)(ctx); if (ctx.D.charges.length !== 2) ctx.note({ rule: "corruption", message: `a reveal outside the retry window was charged ${ctx.D.charges.length} time(s) in total, expected 2` }); },
};
// the REAL chargeCredits (not the contract mock) against the fake ledger
const CHARGE_ARGS = { referenceId: "seed:1", dedupeWithinMs: 5 * MIN };
const creditScenario = (late) => ({
  name: late ? "credit-charge-later" : "credit-charge-ledger", tasks: late ? [1] : [1, 4, 9, 12], families: late ? [] : ["crash", "error"], retryAfterMs: late ? 61 * MIN : 90 * 1000,
  async setup() { const D = newD(); D.realCredit = true; D.tables.creditsTable = [{ id: 1, userId: 7, balance: 100, totalSpent: 0 }]; D.seq.creditsTable = 1; return D; },
  async action(W) { try { return { out: await W.load("services/credit-meter.ts").chargeCredits(7, "sylo.credential_access", CHARGE_ARGS) }; } catch (e) { return { thrown: e.message }; } finally { await settle(); } },
  async recover(W2) { try { return { out: await W2.load("services/credit-meter.ts").chargeCredits(7, "sylo.credential_access", CHARGE_ARGS) }; } catch (e) { return { thrown: e.message }; } finally { await settle(); } },
  async check({ D, run2, note }) {
    const bal = D_ROWS(D, "creditsTable")[0], led = D_ROWS(D, "creditTransactionsTable").filter((t) => t.type === "usage_debit"), want = late ? 2 : 1;
    if (!run2.out?.ok) note({ rule: "unrecoverable", message: `retry of the charge after the interruption returned ${JSON.stringify(run2.out ?? run2.thrown)}` });
    if (led.length !== want) note({ rule: led.length > want ? "duplicate-side-effect" : "corruption", message: `${led.length} usage_debit ledger row(s) for the charge and its ${late ? "later, separate" : "retry"} call (expected ${want})` });
    const spent = -led.reduce((n, t) => n + t.credits, 0);
    if (bal.balance !== 100 - spent || bal.totalSpent !== spent || spent <= 0) note({ rule: "corruption", message: `balance ${bal.balance}/totalSpent ${bal.totalSpent} do not match the ledger (${spent} credits debited)` });
  },
});
async function reveal(W, token) {
  const { revealSeedPhrase } = W.load("vault/application/secret/reveal.ts"), live = new Set([token]);
  try { return { out: await revealSeedPhrase(7, "1", undefined, token, { hasNoEntityPin: async () => false, consumeRevealToken: (u, t) => live.delete(t) }) }; } catch (e) { return { thrown: e.message }; } finally { await settle(); }
}


// ───────────────────────────── declared residuals (measured, bounded, surfaced — never silently passed) ─────────────────────────────
const ACCEPTED = {
  "create-client-retry-duplicate": "A POST /vault WITHOUT an Idempotency-Key header that committed but whose response was lost is retried by the caller into a second entity. The web client now sends a key on every create (checked statically below) and with a key there is no duplicate in any fault run, but the server cannot tell a header-less retry from a new create, so other API callers that omit the header keep this behaviour. One request never produces two rows.",
};

// ───────────────────────────── scenarios, minimal I/O-point floors, task coverage ─────────────────────────────
const SCENARIOS = () => [
  { s: revealScenario, floor: 8 }, { s: revealLaterScenario, floor: 8 }, { s: creditScenario(false), floor: 10 }, { s: creditScenario(true), floor: 10 },
  ...["store", "webhook", "email"].map((d) => ({ s: backupScenario(d), floor: 20 })),
  { s: backupScenario("webhook", { db: true }), floor: 0 }, { s: backupScenario("store", { db: true }), floor: 0 },
  ...["google_drive", "dropbox"].map((p) => ({ s: cloudScenario(p), floor: 6 })),
  { s: backupScenario("webhook", { net: true }), floor: 20 }, { s: backupScenario("email", { net: true }), floor: 20 },
  { s: createScenario(false), floor: 5 }, { s: createScenario(true), floor: 5 }, { s: createScenario(false, true), floor: 6 }, { s: updateScenario, floor: 5 },
  { s: rotationScenario(false), floor: 10 }, { s: rotationScenario(true), floor: 10 },
  { s: restoreScenario, floor: 30 },
];

// ───────────────────────────── mutations: planted defects must be caught ─────────────────────────────
const sub = (from, to) => (t) => { if (!t.includes(from)) throw new Error(`mutation anchor not found: ${from.slice(0, 60)}`); return t.replace(from, to); };
const MUTATIONS = [
  { name: "revert fix: create falls back to a reduced insert on ANY error", file: "vault/application/entity/create.ts", t: sub("if (!isMissingColumnError(err)) throw err;", ""), scenario: () => createScenario(false), expect: ["corruption", "duplicate-side-effect"] },
  { name: "revert fix: update strips seed/credentials on ANY error and answers 200", file: "vault/application/entity/update.ts", t: sub("if (!isMissingColumnError(err)) throw err;", ""), scenario: () => updateScenario, expect: ["corruption"] },
  { name: "revert fix: a failing event hub fails the committed create", file: "vault/application/entity/create.ts", t: sub('try { deps.broadcastEvent("vault_updated", { action: "created", entryId: entry.id }); } catch (err) { console.error("vault_updated broadcast failed (entity was created):", err); }', 'deps.broadcastEvent("vault_updated", { action: "created", entryId: entry.id });'), scenario: () => createScenario(true), expect: ["event-failure-breaks-write"] },
  { name: "revert fix: rotation sweep no longer reconciles a missing rotation audit", file: "vault/infrastructure/backup/key-rotation-cron.ts", t: sub("  await reconcileRotationAudit();\n", ""), scenario: () => rotationScenario(true), expect: ["missing-audit"] },
  { name: "revert fix: sweep gives up when an interrupted rotation left no active key", file: "vault/infrastructure/backup/key-rotation-cron.ts", t: sub("if (!found && loadedVersion === null) return;", "if (!found) return;"), scenario: () => rotationScenario(false), expect: ["unrecoverable"] },
  { name: "key manager loses its fallback to the newest version when none is active", file: "vault/crypto/backup-envelope.ts", t: sub("if (activeVersion === null) activeVersion = Number(rows[rows.length - 1].version);", ""), scenario: () => rotationScenario(false), expect: ["unrecoverable"] },
  { name: "restore applies rows straight to the pool instead of one transaction", file: "vault/application/snapshot/restore.ts", t: sub("activeDb.transaction(", "((fn: any) => fn(activeDb))("), scenario: () => restoreScenario, expect: ["corruption"] },
  { name: "restore row inserts lose their savepoint (aborted transaction misreports counts)", file: "vault/application/snapshot/restore.ts", t: sub("typeof tx.transaction === \"function\" ? tx.transaction(fn) : fn(tx)", "fn(tx)"), scenario: () => restoreScenario, expect: ["misreported-restore"] },
  { name: "revert fix: seed reveal audit is fire-and-forget again", file: "vault/application/secret/reveal.ts", t: sub("await logVaultActivityStrict(id, userId, \"seed_revealed\");", "void logVaultActivityStrict(id, userId, \"seed_revealed\").catch(() => {});"), scenario: () => revealScenario, expect: ["missing-audit"] },
  { name: "revert fix: an interrupted backup run is re-run from scratch (extra snapshot)", file: "vault/application/backup/schedule-cron.ts", t: sub("await selectInterruptedScheduledSnapshot(s.userId, s.lastRunAt ?? null)", "null"), scenario: () => backupScenario("store"), expect: ["duplicate-side-effect"] },
  { name: "revert fix: Idempotency-Key no longer pins the serial (retry creates a second entity)", file: "vault/application/entity/create.ts", t: sub("serial = await claimCreateIdempotencyKey(userId, idempotencyKey, serial);", ""), scenario: () => createScenario(false, true), expect: ["duplicate-side-effect"] },
  { name: "revert fix: scheduled-run activity entry is written once with no retry", file: "vault/application/backup/schedule-cron.ts", t: sub("attempt <= 3", "attempt <= 1"), scenario: () => backupScenario("store"), expect: ["missing-audit"] },
  { name: "revert fix: seed reveal is charged again on every retry (no charge reference)", file: "vault/application/secret/reveal.ts", t: sub(", { referenceId: `seed:${id}`, dedupeWithinMs: REVEAL_RETRY_WINDOW_MS }", ""), scenario: () => revealScenario, expect: ["duplicate-side-effect"] },
  { name: "revert fix: charge dedupe lookup removed from chargeCredits", file: "services/credit-meter.ts", t: sub("if (prior) {", "if (false as boolean) {"), scenario: () => creditScenario(false), expect: ["duplicate-side-effect"] },
  { name: "charge dedupe ignores the retry window (a later reveal is free)", file: "services/credit-meter.ts", t: sub("          gt(creditTransactionsTable.createdAt, since),\n", ""), scenario: () => creditScenario(true), expect: ["corruption"] },
  { name: "revert fix: balance debit and ledger row are separate statements again", file: "services/credit-meter.ts", t: sub("await db.transaction(async (tx) => {", "await ((fn: any) => fn(db))(async (tx: any) => {"), scenario: () => creditScenario(false), expect: ["corruption", "duplicate-side-effect"] },
  { name: "webhook delivery loses its Idempotency-Key (a redelivery is indistinguishable)", file: "vault/infrastructure/backup/delivery.ts", t: sub(', "Idempotency-Key": snapshotDeliveryKey(snapshot.id) };', ' };'), scenario: () => backupScenario("webhook"), expect: ["duplicate-side-effect"] },
  { name: "email delivery loses its stable Message-ID", file: "vault/infrastructure/backup/delivery.ts", t: sub("messageId: `<${snapshotDeliveryKey(snapshot.id)}@backup.ayzen.tech>`,", ""), scenario: () => backupScenario("email"), expect: ["duplicate-side-effect"] },
  { name: "Dropbox upload adds an auto-renamed copy on every redelivery", file: "vault/infrastructure/backup/cloud.ts", t: sub('mode: "overwrite", autorename: false', 'mode: "add", autorename: true'), scenario: () => cloudScenario("dropbox"), expect: ["duplicate-side-effect"] },
  { name: "Drive upload no longer checks for the file before creating it", file: "vault/infrastructure/backup/cloud.ts", t: sub("existingData.files.length > 0) return;", "existingData.files.length > 99) return;"), scenario: () => cloudScenario("google_drive"), expect: ["duplicate-side-effect"] },
  { name: "reveal logs the decrypted seed phrase", file: "vault/application/secret/reveal.ts", t: sub("  const charge = await chargeCredits(", "  console.error('reveal', plaintext);\n  const charge = await chargeCredits("), scenario: () => revealScenario, expect: ["plaintext-leak"] },
  { name: "backup claim guard removed (overlapping ticks both run)", file: "vault/application/backup/schedule-cron.ts", t: sub("return claimed ?? null;", "return claimed ?? ({ id } as any);"), scenario: () => backupScenario("store"), expect: ["duplicate-side-effect"] },
  { name: "stored backup checksum no longer matches the blob", file: "vault/application/snapshot/store.ts", t: sub('createHash("sha256").update(input.blob, "utf8")', 'createHash("sha256").update(input.blob + "x", "utf8")'), scenario: () => backupScenario("store"), expect: ["corruption"] },
  { name: "backup blob stored without encryption", file: "vault/application/backup/schedule-cron.ts", t: sub("const enc = await envelopeEncryptBackup(json, s.userId);", "const enc = { blob: json, version: 1 };"), scenario: () => backupScenario("store"), expect: ["corruption", "plaintext-leak"] },
];

// ───────────────────────────── run ─────────────────────────────
const started = Date.now();
const results = [], mutationResults = [], findings = [];
for (const { s, floor } of SCENARIOS()) {
  const t = Date.now(), r = await sweep(s);
  r.ms = Date.now() - t; r.floor = floor;
  if (r.points < floor) r.violations.push({ rule: "vacuous", message: `only ${r.points} I/O points exercised (floor ${floor}) — the scenario is not reaching the code under test`, at: { fam: "none", cp: 0, label: null } });
  results.push(r);
  const byRule = {}; for (const v of r.violations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  console.log(`  ${s.name}: ${r.points} I/O points, ${r.runs} fault runs, ${r.violations.length} violation(s)${r.violations.length ? " " + JSON.stringify(byRule) : ""}`);
}
const residualTotals = {};
for (const r of results) for (const [k, n] of Object.entries(r.residuals)) residualTotals[k] = (residualTotals[k] ?? 0) + n;
for (const r of results) for (const v of r.violations) findings.push({ file: r.name, rule: v.rule, message: `${v.at.fam}@${v.at.cp} ${v.at.label ?? ""}: ${v.message}` });
for (const k of Object.keys(residualTotals)) if (!ACCEPTED[k]) findings.push({ file: "residuals", rule: "undeclared-residual", message: `${k} occurred ${residualTotals[k]}x but is not a declared, documented residual` });
const covered = new Set(results.flatMap((r) => r.tasks));
for (let i = 1; i <= 12; i++) if (!covered.has(i)) findings.push({ file: "coverage", rule: "task-uncovered", message: `roadmap task ${i} has no scenario` });

for (const m of MUTATIONS) {
  let r, err = null;
  try { r = await sweep(m.scenario(), { [m.file]: m.t }); } catch (e) { err = e.message; }
  const rules = err ? [] : [...new Set(r.violations.map((v) => v.rule))];
  const caught = !err && m.expect.some((e) => rules.includes(e));
  mutationResults.push({ mutation: m.name, file: m.file, scenario: m.scenario().name, must_be_caught_by_any_of: m.expect, caught_by: rules, caught, error: err });
  console.log(`  mutation ${caught ? "caught " : "MISSED "} ${m.name}${err ? ` (${err})` : ` -> ${rules.join("+") || "nothing"}`}`);
  if (!caught) findings.push({ file: "mutation", rule: "mutation-missed", message: `"${m.name}" ${err ? `could not be applied: ${err}` : `needed one of ${m.expect.join("/")}, got ${rules.join("+") || "nothing"}`}` });
}
// the web client's create flow must send the Idempotency-Key the server honours (a static check: the browser code is not executed here)
const clientSrc = fs.readFileSync(path.join(ROOT, CLIENT), "utf8"), routeSrc = fs.readFileSync(path.join(ROOT, "artifacts/api-server/src/routes/vault.ts"), "utf8");
const clientSendsKey = (t) => /mutationFn:[\s\S]{0,200}customFetch<[^>]*>\("\/api\/vault",\s*\{\s*method:\s*"POST",\s*headers:\s*\{\s*"Idempotency-Key":\s*idempotencyKey/.test(t) && /idempotencyKey:\s*createKeyFor\(/.test(t) && !/useCreateVaultEntry/.test(t) && /createAttempt\.current\s*=\s*null/.test(t);
if (!clientSendsKey(clientSrc)) findings.push({ file: CLIENT, rule: "client-unwired", message: "the web create flow does not send an Idempotency-Key header on POST /api/vault (or does not reset it after success)" });
if (clientSendsKey(clientSrc.replace('"Idempotency-Key": idempotencyKey', '"X-Other": idempotencyKey'))) findings.push({ file: CLIENT, rule: "client-check-vacuous", message: "the client wiring check accepted a client that sends no Idempotency-Key" });
if (!/req\.header\("idempotency-key"\)/.test(routeSrc)) findings.push({ file: "routes/vault.ts", rule: "client-unwired", message: "POST /vault does not read the Idempotency-Key header" });
const status = findings.length ? "FAIL" : "PASS";

const TESTED = [...new Set(["vault/application/backup/schedule-cron.ts", "vault/application/backup/key.ts", "vault/application/entity/create.ts", "vault/application/entity/update.ts", "vault/application/entity/activity.ts", "vault/application/secret/reveal.ts", "vault/application/snapshot/restore.ts", "vault/application/snapshot/store.ts", "vault/crypto/backup-envelope.ts", "vault/crypto/key-store-port.ts", "vault/domain/db-errors.ts", "vault/infrastructure/backup/audit.ts", "vault/infrastructure/backup/delivery.ts", "vault/infrastructure/backup/cloud.ts", "services/credit-meter.ts", "routes/vault.ts", "vault/infrastructure/backup/key-rotation-cron.ts", "vault/infrastructure/crypto-key-stores.ts", "vault/infrastructure/repositories/encryption-key-repository.ts", "vault/infrastructure/repositories/vault-backup-schedule-repository.ts", "vault/infrastructure/repositories/vault-snapshot-repository.ts", "vault/infrastructure/repositories/snapshot-restore-repository.ts"])];
const hashes = Object.fromEntries([SELF, "scripts/antas/vault/gap/gap-common.mjs", "scripts/antas/vault/gap/harness.mjs", CLIENT, ...TESTED.map((f) => `artifacts/api-server/src/${f}`)].map((f) => [f, sha256File(path.join(ROOT, f))]));
const report = {
  phase: GAP, sub_phase: GAP, validator_version: VERSION, checked_at: new Date().toISOString(),
  ...binding(hashes), source_hashes: hashes, duration_ms: Date.now() - started,
  method: "real Vault TypeScript executed against an in-memory database/network/clock; a crash (process dies, later I/O refused) or a transient error injected at every I/O point, before and after the operation applies; restart = fresh module graph over surviving state 61 minutes later, then the normal recovery path/client retry; invariants checked after every run",
  tasks_covered: [...covered].sort((a, b) => a - b),
  invariants: ["no corruption (stored data intact, decryptable, checksum-valid, all-or-nothing)", "no duplicate critical side effect (delivery, charge, key version, restore row, entity row)", "no plaintext leak (logs, alerts, audit, state, stored blobs)", "no missing critical audit event (key rotation)", "no unrecoverable state (restart + retry converges)", "no unhandled promise rejection"],
  scenarios: results.map((r) => ({ name: r.name, tasks: r.tasks, io_points: r.points, fault_runs: r.runs, violations: r.violations.length, violation_sample: r.violations.slice(0, 10), residuals: r.residuals, ...(Object.keys(r.stats).length ? { stats: r.stats } : {}) })),
  client_wiring: { file: CLIENT, sends_idempotency_key_on_create: true, kept_until_success_and_per_distinct_payload: true, note: "static check; the browser code is not executed by this gate" },
  fixes_driven_by_this_gate: [
    "entity create/update fell back to a reduced insert/update on ANY database error: a transient error stored an entity without its seed phrase and credentials (or inserted a second row when the first had committed) and still answered success — now only on a missing-column error (domain/db-errors.ts)",
    "entity create/update turned a failing event hub into an error response after the write had committed (client retry then duplicates) — broadcast is now best-effort",
    "a key rotation interrupted between deactivate and insert left a key chain with no active row that the rotation sweep ignored forever — the sweep now rotates to restore one active key",
    "a seed reveal whose response was lost after the credit charge was charged again on the retry — chargeCredits now takes a (referenceId, window), debits and writes its ledger row in ONE transaction, and a retry inside 5 minutes finds the ledger row and is not charged (a deliberate reveal later is charged normally)",
    "a backup redelivered after a crash between the receiver accepting it and the delivery being recorded was indistinguishable from a new backup: webhook now carries Idempotency-Key, email a stable Message-ID, Dropbox overwrites the same file name and Drive skips a file already in the folder (it used to add an auto-renamed copy / a second file)",
    "the web client did not send the Idempotency-Key the server already honours, so a create whose response was lost was retried into a duplicate — the create flow now sends one per distinct payload and drops it after success",
    "a key rotation interrupted between the key commit and its audit row left a key with no key_rotated audit event, never repaired — the sweep now reconciles the missing audit row (marked trigger=reconciled)",
  ],
  accepted_residuals: Object.fromEntries(Object.entries(ACCEPTED).map(([k, why]) => [k, { measured_occurrences: residualTotals[k] ?? 0, why }])),
  mutations: mutationResults,
  limits: [
    "The database is an in-memory model of the Drizzle query subset and the SQL the repositories issue, with Postgres-style aborted-transaction semantics; no real Postgres, locks, isolation levels or replication are exercised.",
    "Process death is injected at I/O boundaries only (a kill between two statements); a kill inside CPU work or mid-write of a single statement is modelled as that statement applied or not applied.",
    "The snapshot payload builder, alert channels, SMTP/webhook/cloud transports and the SSE hub are fakes; their own failure modes are not part of this gate (the vault code's handling of their failures is).",
    "Covered: seed reveal and the real credit ledger, scheduled backup worker (store/email/webhook, overlapping ticks), real Drive/Dropbox delivery against a provider model, entity create/update, automatic and manual key rotation, snapshot restore. Not covered: share/attachment/KYC/game write paths, health cron, field-key rotation (rotateKey), cloud OAuth flows.",
    "A backup can still be SENT twice (exactly-once to an external system is impossible from this side). Every channel now carries a stable identity so the duplicate is recognisable and harmless IF the receiver honours it: webhook Idempotency-Key, email Message-ID (nodemailer/Resend behaviour on a custom Message-ID is not exercised here), Dropbox same-name overwrite and Drive skip-if-present are modelled, not run against the real providers.",
    "A POST /vault without an Idempotency-Key still duplicates on a lost-response retry; only the web client is wired. The reveal retry window is 5 minutes: a second reveal of the same seed inside it is not charged.",
    "Interrupted rotation is repaired by the daily sweep, not atomically: making deactivate+insert a single transaction needs a key-store port change and re-baselining the 15-backup differential.",
  ],
  findings, status,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "gate.json"), JSON.stringify(report, null, 2) + "\n");
if (status !== "PASS") {
  console.error(`${GAP} FAIL — ${findings.length} finding(s):`);
  for (const x of findings.slice(0, 25)) console.error(`  [${x.rule}] ${x.file}: ${x.message}`);
  process.exit(1);
}
const faultRuns = results.reduce((a, r) => a + r.runs, 0), points = results.reduce((a, r) => a + r.points, 0);
console.log(`${GAP} PASS — ${results.length} scenarios, ${points} I/O points, ${faultRuns} crash/error/outage runs: no corruption, duplicate side effect, plaintext leak, missing key-rotation audit or unrecoverable state; ${mutationResults.length}/${mutationResults.length} planted defects caught; ${Object.keys(residualTotals).length} declared residual(s) measured`);
