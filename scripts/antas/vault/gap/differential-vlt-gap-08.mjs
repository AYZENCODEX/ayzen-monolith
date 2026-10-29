#!/usr/bin/env node
// VLT-GAP-08 differential: each frozen pre-extraction vault-backup-{key,cloud,schedule} route (08 census baseline)
// vs the extracted thin route + application owners + repository, executed against the same mocked I/O.
// Every status code, JSON body, redirect, DB write, audit event, activity entry and delivery/rotation call must match.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { ROOT, rejectBypass } from "./gap-common.mjs";
const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL — bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const SRC = ROOT + "/artifacts/api-server/src";
const BASE = (n) => fs.readFileSync(`${ROOT}/reports/antas/vault/gap/VLT-GAP-08/baseline/sources/${("artifacts/api-server/src/routes/" + n + ".ts").replace(/[^a-zA-Z0-9]+/g, "__")}`, "utf8");
Date.now = () => 1_700_000_000_000;

// logical module name for a resolved path (old and new locations map to the same mock)
const LOGICAL = [
  [/lib\/vault-backup-envelope$|vault\/crypto\/backup-envelope$/, "envelope"],
  [/lib\/vault-backup-audit$|vault\/infrastructure\/backup\/audit$/, "audit"],
  [/lib\/vault-backup-cloud$|vault\/infrastructure\/backup\/cloud$/, "cloud"],
  [/lib\/vault-backup-schedule-cron$|vault\/application\/backup\/schedule-cron$/, "cron"],
  [/lib\/ssrf-guard$/, "ssrf"], [/lib\/activity$/, "activity"], [/lib\/logger$/, "logger"],
  [/middlewares\/auth$/, "auth"], [/middlewares\/security$/, "security"],
];

function makeRuntime(routeFile, routeText) {
  const S = { log: [], schedRows: [], deliveryRows: [], keyRows: [], dbThrow: false, activeVersion: 2, cfg: new Set(["google_drive"]),
    rotateThrow: false, runResult: { ok: true, snapshotId: 11 }, ssrfThrow: null, completeThrow: null, auditThrow: false, state: {}, ops: [] };
  const rec = (...a) => S.log.push(JSON.parse(JSON.stringify(a, (k, v) => (k === "req" ? undefined : v))));
  const cache = new Map();
  const tbl = (n) => new Proxy({ __t: n }, { get: (t, p) => (p === "__t" ? n : { t: n, c: String(p) }) });
  const q = () => { let table = null; const o = { from: (t) => { table = t.__t; return o; }, where: () => o, orderBy: () => o, limit: () => o,
    then: (r, j) => (S.dbThrow ? Promise.reject(new Error("db down")) : Promise.resolve(table === "sched" ? S.schedRows : S.deliveryRows)).then(r, j) }; return o; };
  const mocks = {
    express: Object.assign(() => {}, { json: () => "json-mw", Router: () => { const r = { routes: {} }; for (const m of ["get", "post", "put", "delete"]) r[m] = (p, ...h) => { r.routes[m.toUpperCase() + " " + p] = h[h.length - 1]; }; return r; } }),
    "drizzle-orm": { eq: () => null, desc: () => null, sql: (s, ...v) => ({ sql: s.join("?") }) },
    "@workspace/db": { vaultBackupSchedulesTable: tbl("sched"), vaultBackupDeliveriesTable: tbl("deliv"),
      db: { select: () => q(), execute: async () => { if (S.dbThrow) throw new Error("db down"); return { rows: S.keyRows }; },
        insert: (t) => ({ values: (v) => { S.ops.push(["insert", t.__t, v]); return Promise.resolve(); } }),
        update: (t) => ({ set: (v) => ({ where: () => { S.ops.push(["update", t.__t, v]); return Promise.resolve(); } }) }) } },
    crypto: { randomBytes: (n) => Buffer.alloc(n, 0xab) },
    envelope: { rotateBackupEnvelopeKey: async () => { if (S.rotateThrow) throw new Error("rotate failed"); return 3; }, getActiveBackupEnvelopeVersion: () => S.activeVersion },
    audit: { logBackupAudit: async (i) => { if (S.auditThrow) throw new Error("audit failed"); rec("audit", i); }, redactUrl: (u) => (u ? "R:" + u : null),
      listBackupAuditLogAdmin: async (o) => { if (S.dbThrow) throw new Error("db down"); rec("adminAudit", o); return ["a"]; }, listOwnBackupAuditLog: async (u, l) => { rec("ownAudit", u, l); return ["o"]; } },
    cloud: { CLOUD_PROVIDERS: ["google_drive", "dropbox"], isCloudProviderConfigured: (p) => S.cfg.has(p), buildAuthorizeUrl: (p, u) => `https://auth/${p}/${u}`,
      verifyAuthorizeState: (s) => (s === "good" ? { userId: 5, provider: "google_drive" } : s === "dbx" ? { userId: 5, provider: "dropbox" } : null),
      completeCloudConnect: async (p, u, c) => { if (S.completeThrow) throw new Error(S.completeThrow); rec("connect", p, u, c); }, listCloudConnections: async (u) => [{ u }],
      disconnectCloudProvider: async (u, p) => rec("disconnect", u, p) },
    cron: { computeNextRunAt: (s) => "NEXT:" + JSON.stringify(s), runVaultBackupSchedule: async (r) => { rec("run", r.id); return S.runResult; } },
    ssrf: { assertPublicHttpsUrl: async (u) => { if (S.ssrfThrow !== null) throw new Error(S.ssrfThrow); rec("ssrf", u); } },
    activity: { logActivity: async (...a) => rec("activity", ...a) },
    logger: { logger: { error: (...a) => rec("logger.error", a[1]) } },
    auth: { requireAuth: 1, requireAdmin: 1, getRequestUserId: (r) => r.uid },
    security: { sensitiveWriteLimiter: 1 },
  };
  const find = (spec, from) => {
    if (!spec.startsWith(".")) return { mock: mocks[spec] };
    const abs = path.resolve(path.dirname(from), spec); const rel = path.relative(SRC, abs);
    for (const [re, name] of LOGICAL) if (re.test(rel)) return { mock: mocks[name] };
    for (const ext of [".ts", "/index.ts"]) if (fs.existsSync(abs + ext)) return { file: abs + ext };
    throw new Error("unresolved " + spec + " from " + from);
  };
  const load = (file, text) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(text ?? fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cache.set(file, m);
    new Function("require", "module", "exports", "__filename", code)((s) => { const r = find(s, file); return r.mock ?? load(r.file); }, m, m.exports, file);
    return m.exports;
  };
  return { S, router: load(routeFile, routeText).default };
}

const call = (route, o = {}) => ({ route, uid: 1, body: undefined, query: {}, params: {}, ...o });
const SCHED = { id: 4, userId: 1, enabled: true, frequency: "weekly", dayOfWeek: 2, dayOfMonth: 5, hourOfDay: 6, includeAttachments: true, destination: "store", destinationEmail: null, webhookUrl: null, webhookSecret: "sek", nextRunAt: "N0", lastRunAt: null };
const scenarios = {
  key: [], cloud: [], schedule: [],
};
const add = (g, name, setup, calls) => scenarios[g].push({ name, setup, calls });
// key
add("key", "status rows", (S) => { S.keyRows = [{ version: 1, active: false, created_at: "2026-01-01T00:00:00Z" }, { version: 2, active: true, created_at: "2026-09-01T00:00:00Z" }]; }, [call("GET /admin/vault-backup/key-status")]);
add("key", "status no active", (S) => { S.keyRows = [{ version: 1, active: true, created_at: "2026-09-01T00:00:00Z" }]; S.activeVersion = null; }, [call("GET /admin/vault-backup/key-status")]);
add("key", "status stale", (S) => { S.keyRows = [{ version: 2, active: true, created_at: "2020-01-01T00:00:00Z" }]; }, [call("GET /admin/vault-backup/key-status")]);
add("key", "status db error", (S) => { S.dbThrow = true; }, [call("GET /admin/vault-backup/key-status")]);
add("key", "rotate", () => {}, [call("POST /admin/vault-backup/rotate-key", { uid: 7 }), call("POST /admin/vault-backup/rotate-key", { uid: 0 })]);
add("key", "rotate fails", (S) => { S.rotateThrow = true; }, [call("POST /admin/vault-backup/rotate-key", { uid: 7 })]);
add("key", "rotate audit fails", (S) => { S.auditThrow = true; }, [call("POST /admin/vault-backup/rotate-key", { uid: 7 })]);
add("key", "audit log", () => {}, [call("GET /admin/vault-backup/audit-log"), call("GET /admin/vault-backup/audit-log", { query: { userId: "9", limit: "5" } }), call("GET /admin/vault-backup/audit-log", { query: { userId: "abc", limit: "x" } })]);
add("key", "audit log db error", (S) => { S.dbThrow = true; }, [call("GET /admin/vault-backup/audit-log")]);
// cloud
const C = "/vault/backup/cloud";
add("cloud", "no session", () => {}, [call("GET " + C, { uid: 0 }), call("GET " + C + "/:provider/connect", { uid: 0, params: { provider: "google_drive" } }), call("DELETE " + C + "/:provider", { uid: 0, params: { provider: "dropbox" } })]);
add("cloud", "list", () => {}, [call("GET " + C)]);
add("cloud", "connect matrix", () => {}, ["nope", "dropbox", "google_drive"].map((p) => call("GET " + C + "/:provider/connect", { params: { provider: p } })));
const cb = (query, provider = "google_drive") => call("GET " + C + "/:provider/callback", { uid: 0, query, params: { provider } });
add("cloud", "callback matrix", () => {}, [cb({}), cb({ code: "c" }), cb({ state: "good" }), cb({ code: "c", state: "bad" }), cb({ code: "c", state: "dbx" }), cb({ code: "c", state: "good" }, "nope"), cb({ code: 5, state: "good" }), cb({ code: "c", state: "good" })]);
add("cloud", "callback fails", (S) => { S.completeThrow = "boom & <bad>"; }, [cb({ code: "c", state: "good" })]);
add("cloud", "callback audit fails", (S) => { S.auditThrow = true; }, [cb({ code: "c", state: "good" })]);
add("cloud", "delete", () => {}, [call("DELETE " + C + "/:provider", { params: { provider: "nope" } }), call("DELETE " + C + "/:provider", { params: { provider: "dropbox" } })]);
// schedule
const P = "/vault/backup/schedule";
add("schedule", "no session", () => {}, [P, "PUT " + P, P + "/run-now", "/vault/backup/deliveries", "/vault/backup/audit-log"].map((r, i) => call((i === 0 ? "GET " : i === 1 ? "" : i === 2 ? "POST " : "GET ") + r, { uid: 0 })).map((c) => ({ ...c, route: c.route.replace(/^(GET )?PUT /, "PUT ") })));
add("schedule", "get none", () => {}, [call("GET " + P)]);
add("schedule", "get row", (S) => { S.schedRows = [SCHED]; }, [call("GET " + P)]);
add("schedule", "put defaults new", () => {}, [call("PUT " + P, { body: undefined }), call("PUT " + P, { body: {} }), call("PUT " + P, { body: { enabled: true } })]);
add("schedule", "put clamps", () => {}, [call("PUT " + P, { body: { enabled: true, frequency: "yearly", dayOfWeek: 99, dayOfMonth: 0, hourOfDay: -3, destination: "ftp" } }), call("PUT " + P, { body: { enabled: 1, frequency: "monthly", dayOfWeek: 3.5, dayOfMonth: 31, hourOfDay: 30, includeAttachments: 1, destination: "dropbox" } })]);
add("schedule", "put webhook new", () => {}, [call("PUT " + P, { body: { enabled: true, destination: "webhook", webhookUrl: " https://x.test/h?t=1 " } })]);
add("schedule", "put webhook ssrf", (S) => { S.ssrfThrow = "private address"; }, [call("PUT " + P, { body: { destination: "webhook", webhookUrl: "http://10.0.0.1" } }), call("PUT " + P, { body: { destination: "webhook", webhookUrl: "  " } })]);
add("schedule", "put ssrf no message", (S) => { S.ssrfThrow = ""; }, [call("PUT " + P, { body: { destination: "webhook", webhookUrl: "http://x" } })]);
add("schedule", "put email", () => {}, [call("PUT " + P, { body: { destination: "email", destinationEmail: "bad" } }), call("PUT " + P, { body: { destination: "email", destinationEmail: " a@b.co " } })]);
add("schedule", "put existing unchanged", (S) => { S.schedRows = [SCHED]; }, [call("PUT " + P, { body: { enabled: true, frequency: "weekly", dayOfWeek: 2, dayOfMonth: 5, hourOfDay: 6, destination: "store" } })]);
add("schedule", "put existing changed + reenable", (S) => { S.schedRows = [{ ...SCHED, enabled: false, destination: "webhook", webhookUrl: "https://old", webhookSecret: null }]; }, [call("PUT " + P, { body: { enabled: true, frequency: "weekly", dayOfWeek: 2, dayOfMonth: 5, hourOfDay: 6, destination: "webhook", webhookUrl: "https://new" } }), call("PUT " + P, { body: { enabled: false, destination: "email" } })]);
add("schedule", "put audit fails", (S) => { S.auditThrow = true; }, [call("PUT " + P, { body: { destination: "email", destinationEmail: "a@b.co" } })]);
add("schedule", "run-now", (S) => { S.schedRows = []; }, [call("POST " + P + "/run-now")]);
add("schedule", "run-now ok", (S) => { S.schedRows = [SCHED]; }, [call("POST " + P + "/run-now")]);
add("schedule", "run-now fail", (S) => { S.schedRows = [SCHED]; S.runResult = { ok: false, error: "smtp" }; }, [call("POST " + P + "/run-now")]);
add("schedule", "deliveries", (S) => { S.deliveryRows = [{ id: 1 }, { id: 2 }]; }, [call("GET /vault/backup/deliveries")]);
add("schedule", "own audit", () => {}, [call("GET /vault/backup/audit-log"), call("GET /vault/backup/audit-log", { query: { limit: "7" } }), call("GET /vault/backup/audit-log", { query: { limit: "zz" } })]);

async function run(group, routeFile, routeText) {
  const out = [];
  for (const sc of scenarios[group]) {
    const { S, router } = makeRuntime(routeFile, routeText); sc.setup(S);
    const log = [];
    for (const c of sc.calls) {
      const h = router.routes[c.route];
      if (!h) { log.push([c.route, "NO ROUTE"]); continue; }
      let st = 200, body, redirect;
      const res = { status(n) { st = n; return res; }, json(b) { body = b; return res; }, redirect(u) { redirect = u; return res; } };
      try { await h({ uid: c.uid, body: c.body, query: c.query, params: c.params }, res); } catch (e) { body = "THROW:" + e.message; }
      log.push([c.route, st, JSON.parse(JSON.stringify(body ?? null)), redirect ?? null]);
    }
    const norm = (x) => JSON.parse(JSON.stringify(x).replace(/"\d{4}-\d\d-\d\dT[^"]*Z"/g, '"T"'));
    log.push(["side", norm(S.ops), norm(S.log)]);
    out.push([sc.name, log]);
  }
  return out;
}
const FILES = { key: "vault-backup-key", cloud: "vault-backup-cloud", schedule: "vault-backup-schedule" };
let bad = 0, calls = 0, total = 0;
for (const g of Object.keys(FILES)) {
  const file = `${SRC}/routes/${FILES[g]}.ts`;
  const a = await run(g, file, BASE(FILES[g]));
  const b = await run(g, file, fs.readFileSync(file, "utf8"));
  for (let i = 0; i < a.length; i++) {
    total++; calls += a[i][1].length - 1;
    try { assert.deepStrictEqual(b[i], a[i]); } catch { bad++; console.log(`DIFF [${g}] ${a[i][0]}`); console.log(" old:", JSON.stringify(a[i][1]).slice(0, 700)); console.log(" new:", JSON.stringify(b[i][1]).slice(0, 700)); }
  }
}
console.log(`scenarios=${total} calls=${calls} diffs=${bad}`);
process.exit(bad ? 1 : 0);
