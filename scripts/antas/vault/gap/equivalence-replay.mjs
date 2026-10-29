// VLT-GAP-15 shared replay engine (used by 15-B to record and by 15-C to compare).
// Executes the FROZEN pre-extraction route files and the CURRENT route files (+ every vault/ module they pull in) under
// identical, deterministic fakes. Every DB call, event, audit write, notification/provider call, encrypt/decrypt call,
// authorization decision, response status/body/header is recorded in call order. No network, no real DB.
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { ROOT } from "./gap-common.mjs";
const BOUNDARY_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/antas/vault/gap/gap-configs/vault-equivalence-replay.json"), "utf8"));
import { loadTs, createEnv, createLoader, summ } from "./harness.mjs";

export const SRC = path.join(ROOT, "artifacts/api-server/src");
export const ts = loadTs(ROOT);

// ── deterministic world ───────────────────────────────────────────────────────────────────────────────────────
const FIXED = 1_700_000_000_000;
export function freezeWorld() {
  const RealDate = globalThis.__RealDate ?? Date; globalThis.__RealDate = RealDate;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [FIXED])); } static now() { return FIXED; } };
  let seed = 1; Math.random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const detCrypto = () => { let n = 0; return { ...nodeCrypto, randomBytes: (k) => Buffer.alloc(k, ++n & 255), randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, randomInt: () => 4 }; };

export const ROW = {
  id: 1, team_id: 5, user_id: 10, userId: 10, owner_id: 10, ownerId: 10, shared_with_user_id: 11, sharedWithUserId: 11, entity_type: "entity", entityType: "entity",
  entity_id: 1, entityId: 1, vault_entry_id: 1, username: "bob", email: "bob@example.test", name: "N", label: "L", title: "T", project_name: "P",
  permission: "view", is_active: true, isActive: true, status: "active", role: "user", category: "c", platform: "p", field_permissions: null,
  visible_fields: null, deleted_at: null, deletedAt: null, created_at: "2023-11-14T22:13:20.000Z", updated_at: "2023-11-14T22:13:20.000Z",
  createdAt: "2023-11-14T22:13:20.000Z", updatedAt: "2023-11-14T22:13:20.000Z", filename: "f.txt", mime_type: "text/plain", size: 3, size_bytes: 3,
  storage_key: "k", data: "ZGF0YQ==", content: "ZGF0YQ==", blob: "AAAA", version: 1, balance: "1000", price: "10", amount: "10", seller_id: 20, buyer_id: 10,
  count: "1", cnt: "1", total: "1", password: "pw", account_password: "pw", twofa: "t", pin_hash: "h", pin: null, secret: "s", key: "k", value: "v", ip: "127.0.0.1",
};
const ROW2 = { ...ROW, id: 2, entity_id: 2, entityId: 2, is_active: false, isActive: false, deleted_at: "2023-11-01T00:00:00.000Z", deletedAt: "2023-11-01T00:00:00.000Z" };

export const BODY_RICH = {
  entityType: "entity", entity_type: "entity", entityId: 1, entity_id: 1, username: "bob", permission: "view", fieldPermissions: { password: true }, isActive: false,
  ids: [1, 2], items: [{ entityType: "entity", entityId: 1 }, { entityType: "kyc", entityId: 2 }], name: "N", title: "T", label: "L", note: "n", description: "d",
  password: "pw", pin: "1234", currentPin: "1234", code: "123456", token: "tok", email: "bob@example.test", filename: "f.txt", mimeType: "text/plain", data: "ZGF0YQ==",
  price: 10, listing_id: 5, project_name: "P", category: "c", platform: "p", account_type: "a", vault_type: "entity",
};
const WITHOUT = (k) => { const b = { ...BODY_RICH }; delete b[k]; return b; };
const BAD_TYPES = { ...BODY_RICH, entityType: "nope", entity_type: "nope", permission: "admin", ids: "x", items: "x", entityId: "abc" };

// ── scenario families (generic, every route) ──────────────────────────────────────────────────────────────────
export const SCENARIOS = [
  { id: "empty-db", db: "empty", body: BODY_RICH },
  { id: "row-db", db: "row", body: BODY_RICH },
  { id: "row-db-empty-body", db: "row", body: {} },
  { id: "row-db-bad-types", db: "row", body: BAD_TYPES },
  { id: "row-db-two-rows", db: "rows", body: BODY_RICH },
  { id: "row-db-other-user", db: "row", body: BODY_RICH, user: { userId: 99, role: "user" } },
  { id: "row-db-admin", db: "row", body: BODY_RICH, user: { userId: 10, role: "admin" } },
  { id: "db-throws", db: "throw", body: BODY_RICH },
  ...["entityType", "entityId", "username", "ids", "items", "permission", "password"].map((k) => ({ id: `row-db-missing-${k}`, db: "row", body: WITHOUT(k) })),
];

// ── fake world (extends harness env) ─────────────────────────────────────────────────────────────────────────────
export function makeEnv(scn) {
  const env = createEnv({});
  const mode = scn.db;
  const rowOf = () => (mode === "rows" ? [ROW, ROW2] : [ROW]);
  const dfl = (key, d) => {
    if (mode === "throw") throw new Error("db down");
    if (mode === "empty") return d;
    const rows = rowOf();
    return key.startsWith("db.execute") ? { rows, rowCount: rows.length } : rows;
  };
  // harness `next()` falls back to env.dflt for empty channels (see harness.mjs)
  env.dflt = dfl;
  // fire-and-forget collaborators are awaited / .catch()-ed by callers; a bare `undefined` would crash both sides identically and hide the code under test
  env.autoReturn = (name) => (/^(publish|emit|send|notify|create[A-Z]|log|record|audit|sync|delist|alert|schedule|enqueue|track)/.test(name) ? Promise.resolve(undefined) : undefined);
  const orig = env.stubs["@workspace/db"];
  env.stubs["@workspace/db"] = new Proxy(orig, {
    get: (t, p) => {
      if (p === "__esModule") return false;
      if (p in t) return t[p];
      if (typeof p === "symbol" || p === "then") return undefined;
      if (p in (BOUNDARY_CFG.db_constants ?? {})) return BOUNDARY_CFG.db_constants[p];
      if (p === "pool") return (t.pool ??= { query: async (q, v) => { env.log.push(["pool.query", summ([String(q).replace(/\s+/g, " ").trim(), v])]); if (mode === "throw") throw new Error("db down"); return { rows: mode === "empty" ? [] : rowOf(), rowCount: mode === "empty" ? 0 : rowOf().length }; }, connect: async () => ({ query: async (q, v) => { env.log.push(["client.query", summ([String(q).replace(/\s+/g, " ").trim(), v])]); if (mode === "throw" && !/^(BEGIN|COMMIT|ROLLBACK)$/.test(String(q))) throw new Error("db down"); return { rows: mode === "empty" ? [] : rowOf(), rowCount: mode === "empty" ? 0 : rowOf().length }; }, release: () => env.log.push(["client.release"]) }) });
      if (/Table$/.test(String(p))) return (t[p] ??= new Proxy({ __table: String(p) }, { get: (tt, pp) => (pp === "__table" ? String(p) : typeof pp === "symbol" || pp === "then" ? undefined : { __col: `${String(p)}.${String(pp)}` }) }));
      return undefined;
    },
  });
  const ex = (name) => Object.assign(function () {}, {});
  const mw = (name) => { const f = (...a) => {}; Object.defineProperty(f, "name", { value: name }); f.__stub = name; return f; };
  const expressFn = Object.assign(() => ({}), { Router: env.stubs.express.Router, json: () => mw("express.json"), raw: () => mw("express.raw"), urlencoded: () => mw("express.urlencoded") });
  expressFn.default = expressFn;
  env.stubs.express = expressFn;
  env.stubs["lib/policy/pep"].authorize = async (a) => { env.log.push(["authorize", summ({ action: a?.action, resource: a?.resource })]); return { decision: { effect: BOUNDARY_CFG.authorize_effect ?? "ALLOW" } }; };
  env.stubs.crypto = detCrypto(); env.stubs.crypto.default = env.stubs.crypto; env.stubs["node:crypto"] = env.stubs.crypto;
  env.stubs["lib/market-config"] = { getMarketConfig: async () => ({ enabled: true, feePct: 5 }) };
  // encryption boundary: record every encrypt/decrypt/mask call with its arguments, identity transform
  const fe = new Proxy({}, { get: (t, p) => (p === "__esModule" ? false : typeof p === "symbol" || p === "then" ? undefined : (t[p] ??= (...a) => { env.log.push([`call:${String(p)}`, summ(a)]); return /^(decrypt|encrypt|mask|redact)/i.test(String(p)) ? a[0] : undefined; })) });
  // every moved module is replaced, under BOTH its old and its new path, by one shared recording fake
  for (const [name, b] of Object.entries(BOUNDARY_CFG.boundaries)) {
    const impl = b.kind === "encryption" ? fe : new Proxy({}, { get: (t, p) => {
      if (p === "__esModule") return false;
      if (typeof p === "symbol" || p === "then") return undefined;
      const k = String(p);
      if (b.constants && k in b.constants) return b.constants[k];
      return (t[k] ??= (...a) => { env.log.push([`call:${k}`, summ(a)]); return b.returns && k in b.returns ? b.returns[k] : env.autoReturn(k); });
    } });
    for (const pth of b.paths) env.stubs[pth] = impl;
  }
  delete env.stubs["vault/domain/secret-fields"]; delete env.stubs["vault/domain/serial"]; delete env.stubs["vault/application/health"]; // load the real constants for old AND new
  // the harness' plain-object stubs only list a few names; any other named import must still be a callable recorder, not
  // `undefined`, or the handler dies in a TypeError identically on both sides and the replay proves nothing.
  const reqUser = (req) => req?.user?.userId ?? req?.user?.id ?? null;
  Object.assign(env.stubs["middlewares/auth"], {
    getRequestUserId: (req) => reqUser(req), getRequestUser: (req) => req?.user ?? null, getUserId: (req) => reqUser(req),
    requireSessionAuth: mw("requireSessionAuth"), requireDev: mw("requireDev"), requireRoles: () => mw("requireRoles"),
  });
  for (const k of Object.keys(env.stubs)) {
    const v = env.stubs[k];
    if (v && typeof v === "object" && !["express", "crypto", "node:crypto", "@workspace/db", ...Object.values(BOUNDARY_CFG.boundaries).flatMap((b) => b.paths)].includes(k)) {
      env.stubs[k] = new Proxy(v, { get: (t, p) => (p in t ? t[p] : p === "__esModule" ? false : typeof p === "symbol" || p === "then" ? undefined : (t[p] = Object.assign((...a) => { env.log.push([`autostub:${k}.${String(p)}`, summ(a)]); return env.autoReturn(String(p)); }, { __stub: `${k}.${String(p)}` }))) });
    }
  }
  // sleep-free timers
  env.scn = scn;
  return env;
}

// middleware chain description (names + ownership config) so route wiring is compared too
function describeStack(stack, env) {
  return stack.slice(0, -1).map((m) => (m?.__ownership ? { ownership: summ({ action: m.__ownership.action, opts: Object.keys(m.__ownership.opts ?? {}) }) } : { mw: m?.__stub ?? m?.name ?? "anon" }));
}
function canon(log) {
  return log.map(([label, ...rest]) => {
    let l = String(label);
    const m = l.match(/^autostub:(.*)\.([A-Za-z0-9_$]+)$/); if (m) l = `call:${m[2]}`;
    return [l, ...rest];
  }).filter((e) => !(e[0] === "await"));
}

const mkRes = (log) => {
  const r = { statusCode: undefined, body: undefined, headers: {}, ended: false, sent: undefined, calls: [] };
  const px = new Proxy(r, {
    get: (t, p) => {
      if (p === "then") return undefined;
      if (p === "statusCode") return t.statusCode;
      if (typeof p === "symbol" || p in t) return t[p];
      return (...a) => {
        t.calls.push([String(p), summ(a)]);
        if (p === "status") t.statusCode = a[0];
        else if (p === "json") t.body = a[0];
        else if (p === "send" || p === "end") { t.sent = a[0]; t.ended = true; }
        else if (p === "setHeader" || p === "set" || p === "header") { if (typeof a[0] === "string") t.headers[a[0].toLowerCase()] = a[1]; }
        else if (p === "sendStatus") t.statusCode = a[0];
        else if (p === "redirect") t.redirect = a;
        return px;
      };
    },
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return px;
};
const mkReq = (route, scn, env) => {
  const params = {}; for (const m of route.path.matchAll(/:([A-Za-z0-9_]+)/g)) params[m[1]] = /Type$/.test(m[1]) ? "entity" : "1";
  const user = scn.user === undefined ? { userId: 10, id: 10, role: "user", username: "alice", email: "alice@example.test" } : scn.user ? { id: scn.user.userId, username: "alice", email: "alice@example.test", ...scn.user } : undefined;
  return { method: route.method, path: route.path, originalUrl: route.path, params, query: {}, body: scn.body, headers: { "user-agent": "replay" }, user, ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }, get: () => undefined, header: () => undefined, on: () => {}, correlationId: "corr-1", log: { info() {}, warn() {}, error() {} } };
};

// the last element of a route stack is the business handler; earlier ones are middleware (recorded, not executed)
export async function runRoutes({ files, texts, scn, bind = {} }) {
  const env = makeEnv(scn);
  const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  const loadErrors = [];
  // OLD files import sibling route modules (e.g. ./vault-entity-links); bind that import to the frozen OLD sibling, not an autostub
  const bound = new Set(Object.values(bind));
  const order = [...files.filter((f) => bound.has(f)), ...files.filter((f) => !bound.has(f))];
  for (const f of order) {
    try {
      const exp = texts?.[f] ? loader.loadText(texts[f], f, path.join(SRC, "routes")) : loader.loadFile(path.join(SRC, f));
      for (const [relKey, tgt] of Object.entries(bind)) if (f === tgt) env.stubs[relKey] = exp;
    } catch (e) { loadErrors.push(`${f}: ${String(e.message ?? e).slice(0, 200)}`); }
  }
  const out = {};
  const routes = env.routes.slice().sort((a, b) => (`${a.method} ${a.path}` < `${b.method} ${b.path}` ? -1 : 1));
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (out[key]) continue;
    env.log.length = 0; env.syncDeleteRejects = false;
    const res = mkRes(env.log), req = mkReq(r, scn, env);
    const handler = r.stack[r.stack.length - 1];
    let threw = null;
    // ownership gate is resolved the way the PEP would: run the builder, record the ResourceRef it returns
    const gates = [];
    for (const m of r.stack.slice(0, -1)) if (m?.__ownership?.builder) { try { gates.push(summ(await m.__ownership.builder(req))); } catch (e) { gates.push({ threw: String(e.message ?? e).slice(0, 80) }); } }
    let timer;
    try {
      await Promise.race([Promise.resolve(handler(req, res, () => env.log.push(["next"]))), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("REPLAY_TIMEOUT")), 400); })]);
      await new Promise((r2) => setImmediate(r2));
    } catch (e) { threw = String(e?.message ?? e).slice(0, 120); } finally { clearTimeout(timer); }
    out[key] = { stack: describeStack(r.stack, env), gates, status: res.statusCode ?? (res.calls.some(([c]) => c !== "status") ? 200 : null), body: summ(res.body ?? null), sent: summ(res.sent ?? null), headers: res.headers, res_calls: res.calls.map((c) => c[0]).filter((c) => c !== "status"), threw, log: canon(env.log) };
  }
  return { routes: out, loadErrors };
}
export const stable = (o) => JSON.stringify(o);

// first path at which two recordings differ (for reports and for human triage)
export function firstDiff(a, b, p = "") {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return `${p || "$"}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`;
  const ks = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of ks) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  return null;
}

// ── module-level replay (groups with no HTTP routes: health scan + cron) ─────────────────────────────────────────
const recorder = (env, label) => new Proxy({}, { get: (t, p) => (typeof p === "symbol" || p === "then" ? undefined : (t[p] ??= (...a) => { env.log.push([`${label}.${String(p)}`, summ(a.map((x) => (x instanceof Error ? `Error:${x.message}` : x && typeof x === "object" && x.err instanceof Error ? { ...x, err: `Error:${x.err.message}` } : x)))]); })) });
export const HEALTH_SCENARIOS = [
  { id: "empty-db", db: "empty" }, { id: "row-db", db: "row" }, { id: "two-rows", db: "rows" }, { id: "db-throws", db: "throw" },
];
export async function runHealthModules({ oldScanText, oldCronText, oldRoutesVaultText, scn }) {
  const out = {};
  for (const side of ["old", "new"]) {
    const env = makeEnv(scn);
    env.stubs["lib/logger"] = { logger: recorder(env, "logger") }; env.stubs["lib/log-bus"] = { logBus: recorder(env, "logBus") };
    env.stubs["vault/application/entity/representation"] = { formatVaultEntry: (e) => ({ ...e, id: e.id, userId: e.userId ?? e.user_id, projectName: e.project_name ?? e.projectName, category: e.category, deletedAt: e.deletedAt ?? e.deleted_at ?? null }) };
    env.stubs["lib/telegram"] = { sendToUser: async (...a) => { env.log.push(["call:sendToUser", summ(a)]); return true; } };
    env.stubs["lib/email"] = { sendVaultHealthDigestEmail: async (...a) => { env.log.push(["call:sendVaultHealthDigestEmail", summ(a)]); return true; }, sendEmail: async (...a) => { env.log.push(["call:sendEmail", summ(a)]); return true; } };
    const cronJobs = [];
    const nodeCron = { validate: (e) => { env.log.push(["cron.validate", e]); return e !== "invalid"; }, schedule: (e, cb) => { env.log.push(["cron.schedule", e]); cronJobs.push(cb); return { stop() {} }; } };
    env.stubs["node-cron"] = { default: nodeCron, ...nodeCron };
    const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    let scan, cron;
    if (side === "old") {
      env.stubs["lib/vault-health"] = loader.loadFile(path.join(SRC, "vault/application/health.ts")); // old lib/vault-health was moved here verbatim (GAP-11); both sides score with the same code
      env.stubs["routes/vault"] = loader.loadText(oldRoutesVaultText, "routes/__old__vault.ts", path.join(SRC, "routes"));
      scan = loader.loadText(oldScanText, "lib/__old__vault-health-scan.ts", path.join(SRC, "lib"));
      env.stubs["lib/vault-health-scan"] = scan;
      cron = loader.loadText(oldCronText, "lib/__old__vault-health-cron.ts", path.join(SRC, "lib"));
    } else {
      scan = loader.loadFile(path.join(SRC, "vault/application/health-scan.ts"));
      cron = loader.loadFile(path.join(SRC, "vault/application/health-cron.ts"));
    }
    const rec = {};
    env.log.length = 0;
    try { rec.scan = { result: summ(await scan.runDailyHealthScan()), threw: null }; } catch (e) { rec.scan = { result: null, threw: String(e?.message ?? e).slice(0, 120) }; }
    rec.scan.log = canon(env.log); env.log.length = 0;
    for (const cenv of [undefined, "invalid", "*/5 * * * *"]) {
      if (cenv === undefined) delete process.env.VAULT_HEALTH_SCAN_CRON; else process.env.VAULT_HEALTH_SCAN_CRON = cenv;
      const env2 = makeEnv(scn); // fresh module state so the `scheduled` guard does not leak between variants
      Object.assign(env2.stubs, { "lib/logger": { logger: recorder(env2, "logger") }, "lib/log-bus": { logBus: recorder(env2, "logBus") }, "node-cron": { default: { validate: (e) => { env2.log.push(["cron.validate", e]); return e !== "invalid"; }, schedule: (e, cb) => { env2.log.push(["cron.schedule", e]); cronJobs.push(cb); return {}; } } } });
      env2.stubs["vault/application/entity/representation"] = env.stubs["vault/application/entity/representation"]; env2.stubs["lib/telegram"] = env.stubs["lib/telegram"]; env2.stubs["lib/email"] = env.stubs["lib/email"];
      const l2 = createLoader({ ts, root: ROOT, srcDir: SRC, env: env2 });
      let c2;
      if (side === "old") { env2.stubs["lib/vault-health"] = l2.loadFile(path.join(SRC, "vault/application/health.ts")); env2.stubs["routes/vault"] = env.stubs["routes/vault"]; const s2 = l2.loadText(oldScanText, "lib/__old__vault-health-scan.ts", path.join(SRC, "lib")); env2.stubs["lib/vault-health-scan"] = s2; c2 = l2.loadText(oldCronText, "lib/__old__vault-health-cron.ts", path.join(SRC, "lib")); }
      else c2 = l2.loadFile(path.join(SRC, "vault/application/health-cron.ts"));
      cronJobs.length = 0; env2.log.length = 0;
      let threw = null; try { c2.startVaultHealthCron(); c2.startVaultHealthCron(); for (const cb of cronJobs) await cb(); await new Promise((r) => setImmediate(r)); } catch (e) { threw = String(e?.message ?? e).slice(0, 100); }
      rec[`cron:${cenv ?? "default"}`] = { threw, log: canon(env2.log) };
    }
    out[side] = rec;
  }
  return out;
}

// ── module-pair replay: moved-verbatim modules called with no arguments (trash purges) ───────────────────────────
export const PURGE_PAIRS = [
  { name: "purgeExpiredVaultTrash", oldFile: "VLT-GAP-09/baseline/sources/artifacts__api__server__src__lib__vault__trash__purge__ts", virtualDir: "lib", newFile: "vault/infrastructure/trash/entry-trash-purge.ts" },
  { name: "purgeExpiredVaultSnapshotTrash", oldFile: "VLT-GAP-09/baseline/sources/artifacts__api__server__src__lib__vault__snapshot__trash__purge__ts", virtualDir: "lib", newFile: "vault/infrastructure/trash/snapshot-trash-purge.ts" },
];
export async function runPurgePair(pair, scn) {
  const out = {};
  for (const side of ["old", "new"]) {
    const env = makeEnv(scn);
    env.stubs["lib/logger"] = { logger: recorder(env, "logger") }; env.stubs["lib/log-bus"] = { logBus: recorder(env, "logBus") };
    for (const b of Object.values(BOUNDARY_CFG.boundaries)) for (const pth of b.paths) if (/trash-purge$/.test(pth)) delete env.stubs[pth]; // the module under test is loaded for real
    const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    const mod = side === "old" ? loader.loadText(fs.readFileSync(path.join(ROOT, "reports/antas/vault/gap", pair.oldFile), "utf8"), `${pair.virtualDir}/__old__${pair.name}.ts`, path.join(SRC, pair.virtualDir)) : loader.loadFile(path.join(SRC, pair.newFile));
    env.log.length = 0; let result = null, threw = null;
    try { result = summ(await mod[pair.name]()); } catch (e) { threw = String(e?.message ?? e).slice(0, 100); }
    out[side] = { result, threw, log: canon(env.log) };
  }
  return out;
}

// ── snapshot blob crypto: private encryptBlob/decryptBlob of the frozen route vs vault/application/snapshot/blob.ts, REAL node crypto ──
export async function runBlobPair() {
  const gcmAbs = path.join(ROOT, "packages/vault-crypto/src/aes-gcm.mjs");
  const gcm = await import(gcmAbs); // the REAL shared AES-256-GCM primitive, used identically by both sides
  const mk = (side) => {
    const env = makeEnv({ db: "empty" });
    for (const k of [path.relative(SRC, gcmAbs), path.relative(SRC, gcmAbs).replace(/\.mjs$/, ""), path.relative(SRC, gcmAbs).split(path.sep).join("/")]) env.stubs[k] = { ...gcm, encryptAes256Gcm: (() => { let n = 0; return (key, plaintext, aad) => { // identical to the real primitive except the IV is a per-env counter, so ciphertexts are comparable
      const iv = Buffer.alloc(12, ++n); const c = nodeCrypto.createCipheriv("aes-256-gcm", key, iv); if (aad) c.setAAD(Buffer.from(aad));
      const encrypted = Buffer.concat([typeof plaintext === "string" ? c.update(plaintext, "utf8") : c.update(plaintext), c.final()]); return { iv, encrypted, authTag: c.getAuthTag() }; }; })() }; const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    if (side === "new") return { env, m: loader.loadFile(path.join(SRC, "vault/application/snapshot/blob.ts")) };
    const t = fs.readFileSync(path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-09/baseline/sources/artifacts__api__server__src__routes__vault__snapshot__ts"), "utf8");
    return { env, m: loader.loadText(t + "\nexport { encryptBlob as __enc, decryptBlob as __dec };", "routes/__old__vault-snapshot.ts", path.join(SRC, "routes")) };
  };
  const S = { old: mk("old"), new: mk("new") };
  const enc = (s, ...a) => (s === "old" ? S.old.m.__enc : S.new.m.encryptBlob)(...a);
  const dec = (s, ...a) => (s === "old" ? S.old.m.__dec : S.new.m.decryptBlob)(...a);
  const run = (f) => { try { return { ok: f() }; } catch (e) { return { err: String(e?.message ?? e).slice(0, 80) }; } };
  const cases = [["short", "pw-correct-123", "hello"], ["unicode", "pw-correct-123", JSON.stringify({ a: "bangla: \u09AC\u09BE\u0982\u09B2\u09BE", n: [1, 2, 3] })], ["empty", "pw-correct-123", ""]];
  const out = { old: [], new: [] };
  for (const side of ["old", "new"]) {
    const other = side === "old" ? "new" : "old";
    for (const [name, pw, pt] of cases) {
      const blob = run(() => enc(side, pw, pt)); out[side].push([`enc:${name}`, blob]);
      out[side].push([`dec-own:${name}`, blob.ok ? run(() => dec(side, pw, blob.ok)) : null]);
      out[side].push([`dec-cross:${name}`, blob.ok ? run(() => dec(other, pw, blob.ok)) : null]); // each side must read the OTHER side's blob
      out[side].push([`dec-wrong-pw:${name}`, blob.ok ? run(() => dec(side, "wrong-pass-999", blob.ok)) : null]);
    }
    for (const bad of ["", "garbage", "AYZENBAK2", "AYZENBAK2:AA:AA", "AYZENBAK9:AA:AA:AA:AA", "AYZENBAK2:!!:!!:!!:!!"]) out[side].push([`dec-malformed:${bad}`, run(() => dec(side, "pw-correct-123", bad))]);
  }
  return out;
}
