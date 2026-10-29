// Differential test harness for VLT-GAP extraction phases.
// Executes OLD (frozen baseline) and NEW (current) TypeScript side by side under
// identical stubbed dependencies, records every DB/provider/event interaction,
// and lets validators compare results + call logs. No network, no real DB.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

export function loadTs(root) {
  const tries = [
    () => createRequire(path.join(root, "package.json"))("typescript"),
    () => { const g = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }); return createRequire(path.join(g.stdout.trim(), "x.js"))("typescript"); },
  ];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  return null;
}

// ── safe summariser for call-log entries ─────────────────────────────────
export function summ(v, depth = 0) {
  if (depth > 6) return "[depth]";
  if (v === null || v === undefined) return v === undefined ? "[undefined]" : null;
  if (typeof v === "function") return `[fn ${v.name || "anon"}${v.__stub ? ":" + v.__stub : ""}]`;
  if (typeof v !== "object") return v;
  if (v instanceof Date) return `[date]`;
  if (Array.isArray(v)) return v.map((x) => summ(x, depth + 1));
  if (typeof v.__table === "string") return `table(${v.__table})`;
  if (typeof v.__col === "string") return `col(${v.__col})`;
  if (v.__sql) return { sql: v.__sql.map((s) => s.replace(/\s+/g, " ")), values: v.values.map((x) => summ(x, depth + 1)) };
  if (v.__raw !== undefined) return { raw: String(v.__raw).replace(/\s+/g, " ").trim() };
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = summ(v[k], depth + 1);
  return out;
}

// ── fake environment ─────────────────────────────────────────────────────
// `script` maps a channel key -> array of results consumed FIFO per channel:
//   "db.select:vaultEntriesTable", "db.update:vaultEntriesTable", "db.execute:SELECT TEAM_ID FROM", ...
// Items: { value } or { throw }. Empty channel => default ([] / {rows: []}).
// Keying by channel keeps results independent of microtask interleaving.
export function createEnv(script = {}) {
  const log = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const next = (key, dflt) => {
    const q = queues.get(key);
    if (!q || !q.length) { log.push(["await", key, "default"]); return typeof env !== "undefined" && env.dflt ? env.dflt(key, dflt) : dflt; }
    const item = q.shift();
    log.push(["await", key, item.throw ? { throw: String(item.throw) } : "ok"]);
    if (item.throw) throw new Error(item.throw);
    return item.value;
  };
  const chain = (label, tableKey) => {
    const state = { table: tableKey };
    const p = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") return (res, rej) => { try { res(next(`${label}:${state.table ?? ""}`, [])); } catch (e) { rej(e); } };
        if (typeof prop === "symbol") return undefined;
        return (...args) => {
          if (prop === "from" && args[0]?.__table) state.table = args[0].__table;
          log.push([`${label}.${prop}`, summ(args)]);
          return p;
        };
      },
    });
    return p;
  };
  const sqlKey = (q) => {
    const text = q?.__raw !== undefined ? String(q.__raw) : q?.__sql ? q.__sql.join(" ") : "";
    return text.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ").toUpperCase();
  };
  const db = {
    select: (...a) => { log.push(["db.select", summ(a)]); return chain("db.select"); },
    selectDistinct: (...a) => { log.push(["db.selectDistinct", summ(a)]); return chain("db.selectDistinct"); },
    insert: (t) => { log.push(["db.insert", summ(t)]); return chain("db.insert", t?.__table); },
    update: (t) => { log.push(["db.update", summ(t)]); return chain("db.update", t?.__table); },
    delete: (t) => { log.push(["db.delete", summ(t)]); return chain("db.delete", t?.__table); },
    execute: (q) => { log.push(["db.execute", summ(q)]); try { return Promise.resolve(next(`db.execute:${sqlKey(q)}`, { rows: [] })); } catch (e) { return Promise.reject(e); } },
  };
  const table = (name) => new Proxy({ __table: name }, { get: (t, p) => (p === "__table" ? name : typeof p === "symbol" || p === "then" ? undefined : { __col: `${name}.${String(p)}` }) });
  const sql = (strings, ...values) => ({ __sql: [...strings], values });
  sql.raw = (s) => ({ __raw: s });
  sql.join = (arr, sep) => ({ __sql: ["JOIN"], values: [arr, sep] });
  const op = (n) => (...args) => ({ __sql: [n], values: args });
  const drizzle = { eq: op("eq"), and: op("and"), or: op("or"), inArray: op("inArray"), desc: op("desc"), asc: op("asc"), sql, isNull: op("isNull"), like: op("like"), ne: op("ne"), gt: op("gt"), lt: op("lt"), gte: op("gte"), lte: op("lte"), count: op("count") };
  const tables = ["vaultEntriesTable", "vaultEntityLinksTable", "vaultActivityLogTable", "usersTable", "vaultFieldHistoryTable"];
  const workspaceDb = { db, ...Object.fromEntries(tables.map((t) => [t, table(t)])) };
  const named = (name, fn) => { Object.defineProperty(fn, "name", { value: name }); fn.__stub = name; return fn; };
  const routes = [];
  const Router = () => {
    const r = {};
    for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (p, ...stack) => { routes.push({ method: m.toUpperCase(), path: p, stack }); return r; };
    r.use = () => r;
    return r;
  };
  const rec = (label, ret) => (...a) => { log.push([label, summ(a)]); return typeof ret === "function" ? ret(...a) : ret; };
  const stubs = {
    "@workspace/db": workspaceDb,
    "drizzle-orm": drizzle,
    express: { Router },
    "middlewares/auth": {
      requireAuth: named("requireAuth", () => {}),
      requireAdmin: named("requireAdmin", () => {}),
      pepDecisionObserver: named("pepDecisionObserver", () => {}),
    },
    "lib/policy/pep/middleware": {
      requireOwnership: (action, builder, opts) => { const m = named("ownershipMiddleware", () => {}); m.__ownership = { action, builder, opts }; return m; },
      requirePublicAudit: () => named("publicAudit", () => {}),
    },
    "lib/policy/pep": { authorizeMany: async (args) => { log.push(["authorizeMany", summ({ action: args.action, engine: args.engine?.__engine, items: args.items })]); return []; } },
    "lib/policy/policy-engine": { PolicyEngine: class { constructor(o) { this.__engine = { rules: [], onDecision: summ(o?.onDecision) }; } registerRule(n, r) { this.__engine.rules.push([n, summ(r)]); log.push(["registerRule", n]); } } },
    "lib/policy/resource": { createResourceOwnershipRule: () => ({ __rule: "resource-ownership" }) },
    "services/sync": {
      syncOnVaultDelete: (id) => { log.push(["syncOnVaultDelete", id]); return env.syncDeleteRejects ? Promise.reject(new Error("sync")) : Promise.resolve(); },
      delistVaultMarketplaceListings: (id, why) => { log.push(["delistVaultMarketplaceListings", [id, why]]); return Promise.resolve({}); },
    },
    "services/credit-meter": {
      chargeCredits: async (...a) => { log.push(["chargeCredits", summ(a)]); return { ok: true, charged: 5, newBalance: 95 }; },
      requireCreditBalance: (k) => named(`requireCreditBalance(${k})`, () => {}),
    },
    "lib/activity-log": { logSubjectActivity: async (...a) => { log.push(["logSubjectActivity", summ(a)]); } },
    "lib/vault-trash-purge": { VAULT_TRASH_RETENTION_DAYS: 30 },
    "routes/events": { broadcastEvent: named("broadcastEvent", rec("broadcastEvent")) },
    // heavy real modules replaced by deterministic stand-ins (identical for OLD and NEW)
    "vault/application/entity/representation": { formatVaultEntry: (e) => ({ id: e.id, formatted: true, deletedAt: e.deletedAt ?? e.deleted_at ?? null }) },
    "vault/application/health": {}, "vault/domain/secret-fields": {}, "vault/domain/serial": {}, "vault/crypto/seed-phrase": {}, "vault/crypto/field-encryption": {},
  };
  const env = { log, db, stubs, routes, syncDeleteRejects: false, overrides: new Map() };
  return env;
}

// ── module loader (TypeScript → CJS via transpileModule) ─────────────────
const TRANSPILE_CACHE = new Map();
export function createLoader({ ts, root, srcDir, env }) {
  const cache = new Map();
  const autoStub = (spec) => new Proxy({}, { get: (t, p) => (p === "__esModule" ? false : typeof p === "symbol" ? undefined : (t[p] ??= Object.assign((...a) => { env.log.push([`autostub:${spec}.${String(p)}`, summ(a)]); return env.autoReturn ? env.autoReturn(String(p)) : undefined; }, { __stub: `${spec}.${String(p)}` }))) });
  function stubFor(spec, abs) {
    if (!abs) return env.stubs[spec] ?? autoStub(spec);
    const rel = path.relative(srcDir, abs).split(path.sep).join("/");
    return env.stubs[rel] ?? autoStub(rel);
  }
  function resolveFile(abs) {
    for (const c of [abs + ".ts", path.join(abs, "index.ts"), abs]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  }
  function run(code, filename, virtualDir) {
    const mod = { exports: {} };
    const req = (spec) => {
      if (spec.startsWith(".")) {
        const abs = path.resolve(virtualDir, spec.replace(/\.(js|ts)$/, ""));
        const rel = path.relative(srcDir, abs).split(path.sep).join("/");
        if (rel.startsWith("vault/") && !env.stubs[rel]) { const f = resolveFile(abs); if (f) return loadFile(f); }
        return stubFor(spec, abs);
      }
      return stubFor(spec, null);
    };
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    return mod.exports;
  }
  function transpile(text, filename) {
    const ck = filename + "|" + crypto.createHash("sha256").update(text).digest("hex");
    if (TRANSPILE_CACHE.has(ck)) return TRANSPILE_CACHE.get(ck);
    const out = ts.transpileModule(text, { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false, verbatimModuleSyntax: false } }).outputText;
    TRANSPILE_CACHE.set(ck, out);
    return out;
  }
  function loadFile(file, virtualDir = path.dirname(file)) {
    const key = file + "|" + virtualDir;
    if (cache.has(key)) return cache.get(key);
    const exp = run(transpile(env.overrides?.get(file) ?? fs.readFileSync(file, "utf8"), file), file, virtualDir);
    cache.set(key, exp);
    return exp;
  }
  // Load TS *text* as if it lived in virtualDir (used for frozen baseline sources).
  function loadText(text, filename, virtualDir) {
    return run(transpile(text, filename), filename, virtualDir);
  }
  return { loadFile, loadText };
}

// ── slice a set of top-level declarations out of a source text ──────────
export function sliceSymbols(ts, text, names, { fileName = "slice.ts" } = {}) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(names);
  const out = [];
  const found = new Set();
  const header = sf.statements.filter((s) => ts.isImportDeclaration(s)).map((s) => s.getText(sf));
  for (const s of sf.statements) {
    let nm = null;
    if (ts.isFunctionDeclaration(s) && s.name) nm = s.name.text;
    else if (ts.isVariableStatement(s)) { const d = s.declarationList.declarations.map((x) => x.name.getText(sf)); nm = d.find((n) => wanted.has(n)) ?? null; }
    if (!nm && ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && ts.isPropertyAccessExpression(s.expression.expression) && ts.isIdentifier(s.expression.expression.expression) && wanted.has(s.expression.expression.expression.text)) {
      out.push(s.getText(sf)); continue; // statements that configure a sliced symbol (e.g. engine.registerRule(...))
    }
    if (nm && wanted.has(nm)) {
      found.add(nm);
      let t = s.getText(sf);
      if (!/^export\s/.test(t)) t = "export " + t;
      out.push(t);
    }
  }
  const missing = names.filter((n) => !found.has(n));
  return { text: [...header, ...out].join("\n"), missing };
}

export const sqlKeyOf = (text) => String(text).replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ").toUpperCase();

export function fakeRes() {
  const r = { statusCode: undefined, body: undefined, calls: [] };
  r.status = (n) => { r.statusCode = n; r.calls.push(["status", n]); return r; };
  r.json = (b) => { r.body = b; r.calls.push(["json", summ(b)]); return r; };
  return r;
}

export async function withConsoleCaptured(log, fn) {
  const orig = { error: console.error, warn: console.warn };
  console.error = (...a) => log.push(["console.error", a.map((x) => (x instanceof Error ? `Error:${x.message}` : typeof x === "string" ? x : "[obj]"))]);
  console.warn = (...a) => log.push(["console.warn", a.length]);
  try { return await fn(); } finally { console.error = orig.error; console.warn = orig.warn; }
}
