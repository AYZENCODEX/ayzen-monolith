#!/usr/bin/env node
// VLT-GAP-09 differential: the frozen pre-extraction routes/vault-snapshot.ts (09 census baseline) vs the extracted thin
// route + snapshot use cases/blob/payload/store/ownership + repository, executed against the same mocked I/O.
// Status, JSON/raw body, headers, DB operations (table, columns, where-clause shape, values), activity, audit, alerts and
// ownership-middleware registration/resolution must all match.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { ROOT, rejectBypass } from "./gap-common.mjs";
const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL — bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const SRC = ROOT + "/artifacts/api-server/src";
const ROUTE = `${SRC}/routes/vault-snapshot.ts`;
const BASE = fs.readFileSync(`${ROOT}/reports/antas/vault/gap/VLT-GAP-09/baseline/sources/${"artifacts/api-server/src/routes/vault-snapshot.ts".replace(/[^a-zA-Z0-9]+/g, "__")}`, "utf8");
Date.now = () => 1_700_000_000_000;
{ const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1_700_000_000_000])); } static now() { return 1_700_000_000_000; } }; }

const LOGICAL = [
  [/lib\/activity$/, "activity"], [/vault\/infrastructure\/backup\/audit$/, "audit"], [/vault\/infrastructure\/backup\/alerts$/, "alerts"],
  [/lib\/login-security$/, "ls"], [/vault\/infrastructure\/trash\/snapshot-trash-purge$|lib\/vault-snapshot-trash-purge$/, "trash"],
  [/vault\/application\/snapshot\/restore$|lib\/vault-snapshot-restore$/, "restore"], [/vault\/application\/snapshot\/sections$|repositories\/snapshot-sections-repository$|lib\/vault-snapshot-extra$/, "sections"],
  [/vault\/crypto\/field-encryption$/, "fe"], [/lib\/wallet-crypto$/, "wc"], [/vault\/domain\/secret-fields$/, "sf"],
  [/vault\/crypto\/backup-envelope$/, "env"], [/lib\/policy\/pep\/middleware$/, "pep"], [/middlewares\/auth$/, "auth"],
  [/middlewares\/security$/, "sec"], [/packages\/vault-crypto\/src\/aes-gcm\.mjs$/, "aes"],
];
const SECTION_FNS = ["Mailbox", "Projects", "Tasks", "Finance", "UserProfile", "WalletHub", "Activity", "EntityCoverage", "EmergencyAccess", "AccountExtras", "Team", "Earning", "BackupSystem", "EmailAccounts", "MailboxReputation", "ExternalMail"];

function makeRuntime(routeText) {
  const S = { log: [], ops: [], q: {}, thr: {}, anom: false, anomThrow: false, restoreDiff: { add: 1 }, applied: { restored: 3, skipped: 1, byTable: { a: 3 } }, envThrow: null, auditThrow: false };
  const rec = (...a) => S.log.push(JSON.parse(JSON.stringify(a, (k, v) => (k === "req" ? { ip: v?.ip, uid: v?.uid } : v))));
  const cache = new Map();
  const tbl = (n) => new Proxy({ __t: n }, { get: (t, p) => (p === "__t" ? n : { t: n, c: String(p) }) });
  const res_ = (key, dflt) => { const q = S.q[key]; if (S.thr[key]) throw new Error(S.thr[key]); if (!q) return dflt; return q.length > 1 ? q.shift() : q[0]; };
  const chain = (kind, table, extra = {}) => {
    const op = { kind, table, ...extra }; S.ops.push(op);
    const o = { from: (t) => { op.table = t.__t; return o; }, set: (v) => { op.set = v; return o; }, values: (v) => { op.values = v; return o; },
      where: (w) => { op.where = w; return o; }, orderBy: (x) => { op.order = x; return o; }, limit: (n) => { op.limit = n; return o; },
      returning: (c) => { op.returning = c; return o; },
      then: (r, j) => { try { const dflt = kind === "select" || kind === "update" && op.returning ? [] : kind === "insert" ? [{ id: 42 }] : []; return Promise.resolve(res_(kind + ":" + op.table, op.returning && kind === "update" ? [] : dflt)).then(r, j); } catch (e) { return Promise.reject(e).then(r, j); } } };
    return o;
  };
  const dbMod = new Proxy({}, { get: (t, p) => p === "db" ? { select: (c) => chain("select", null, { cols: c ? Object.keys(c) : null }), update: (t_) => chain("update", t_.__t), insert: (t_) => chain("insert", t_.__t), delete: (t_) => chain("delete", t_.__t),
    execute: async () => ({ rows: [] }) } : tbl(String(p)) });
  const ownReg = [];
  const mocks = {
    express: Object.assign(() => {}, { json: (o) => "json:" + JSON.stringify(o ?? null), Router: () => { const r = { routes: {}, mws: {} }; for (const m of ["get", "post", "put", "patch", "delete"]) r[m] = (p, ...h) => { r.routes[m.toUpperCase() + " " + p] = h[h.length - 1]; r.mws[m.toUpperCase() + " " + p] = h.slice(0, -1); }; return r; } }),
    "drizzle-orm": { eq: (c, v) => ["eq", c.c, v], and: (...a) => ["and", ...a], desc: (c) => ["desc", c.c], isNull: (c) => ["isNull", c.c], isNotNull: (c) => ["isNotNull", c.c],
      sql: (s, ...v) => ({ sql: Array.from(s).join("?"), v: v.map((x) => (x && x.c ? x.c : x)) }) },
    "@workspace/db": dbMod,
    crypto: { createHash: (a) => { const h = { d: "" }; const o = { update: (s) => { h.d += s; return o; }, digest: () => "H(" + a + ":" + h.d.length + ":" + h.d.slice(0, 8) + ")" }; return o; },
      randomBytes: (n) => Buffer.alloc(n, 0xab), scryptSync: (pw) => Buffer.from(String(pw)) },
    aes: { encryptAes256Gcm: (key, plain) => ({ iv: Buffer.alloc(12, 1), encrypted: Buffer.from(plain), authTag: Buffer.from(key) }),
      decryptAes256Gcm: (key, iv, data, tag) => { if (!Buffer.from(tag).equals(Buffer.from(key))) throw new Error("bad tag"); return Buffer.from(data); } },
    activity: { logActivity: async (...a) => rec("activity", ...a) },
    audit: { logBackupAudit: async (i) => { if (S.auditThrow) throw new Error("audit failed"); rec("audit", i); }, isAnomalousBackupIp: async (u, ip) => { if (S.anomThrow) throw new Error("x"); rec("anomChk", u, ip); return S.anom; } },
    alerts: { alertOwnerOfAnomalousBackupAccess: async (...a) => rec("alert", ...a) },
    ls: { getClientIp: (r) => r.ip },
    trash: { VAULT_SNAPSHOT_TRASH_RETENTION_DAYS: 30 },
    restore: { buildRestoreDiff: async (u, s) => { rec("diff", u, s); return S.restoreDiff; }, applyRestoreDiff: async (u, s) => { rec("apply", u, s); return S.applied; } },
    sections: Object.fromEntries(SECTION_FNS.map((n) => ["gather" + n + "Snapshot", async (u) => new Proxy({}, { get: (t, p) => (typeof p === "string" ? (/count/i.test(p) ? 3 : []) : undefined) })])),
    fe: { decryptField: (v) => (v ? "D:" + v : v) }, wc: { decryptPhrase: (e) => { if (e === "bad") throw new Error("bad"); return "P:" + e; } }, sf: { SENSITIVE_VAULT_FIELDS: ["password"] },
    env: { envelopeDecryptBackup: async (blob, uid) => { if (S.envThrow) throw new Error(S.envThrow); rec("env", blob, uid); return JSON.stringify({ env: true, uid }); } },
    pep: { requireOwnership: (action, resource, opts) => { const d = { __own: true, action, resource, opts }; ownReg.push(d); return d; } },
    auth: { requireAuth: 1, getRequestUserId: (r) => r.uid, pepDecisionObserver: "OBS" }, sec: { sensitiveWriteLimiter: 2 },
  };
  const find = (spec, from) => {
    if (!spec.startsWith(".")) return { mock: mocks[spec] };
    const abs = path.resolve(path.dirname(from), spec); const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    for (const [re, name] of LOGICAL) if (re.test(rel.replace(/^artifacts\/api-server\/src\//, ""))) return { mock: mocks[name] };
    for (const ext of [".ts", "/index.ts"]) if (fs.existsSync(abs + ext)) return { file: abs + ext };
    throw new Error("unresolved " + spec + " from " + from + " (" + rel + ")");
  };
  const load = (file, text) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(text ?? fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cache.set(file, m);
    new Function("require", "module", "exports", "__filename", code)((s) => { const r = find(s, file); return r.mock ?? load(r.file); }, m, m.exports, file);
    return m.exports;
  };
  const router = load(ROUTE, routeText).default;
  return { S, router, ownReg, rec, mocks };
}

const R = (route, o = {}) => ({ route, uid: 1, body: undefined, params: {}, ip: "9.9.9.9", ...o });
const ID = (route, id = "5", o = {}) => R(route, { params: { id }, ...o });
const scenarios = []; const add = (name, setup, calls) => scenarios.push({ name, setup, calls });
const ROUTES = ["POST /vault/snapshot/export", "GET /vault/snapshots", "GET /vault/snapshots/storage", "GET /vault/snapshots/:id/download", "PATCH /vault/snapshots/:id", "DELETE /vault/snapshots/:id",
  "GET /vault/snapshots/trash", "POST /vault/snapshots/:id/restore", "DELETE /vault/snapshots/trash/:id", "POST /vault/snapshot/restore-preview", "POST /vault/snapshot/restore"];
add("route set + middleware chain", () => {}, [R("__routes__")]);
add("ownership resolve/deny", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ userId: 7 }]]; }, [R("__own__")]);
add("ownership no row", () => {}, [R("__own__")]);
add("no session", () => {}, ROUTES.map((r) => R(r, { uid: 0, params: { id: "1" }, body: { password: "x".repeat(12) } })));
add("bad id", () => {}, ROUTES.filter((r) => r.includes(":id")).map((r) => R(r, { params: { id: "abc" } })));
add("export bad password", () => {}, [undefined, {}, { password: 5 }, { password: "short" }, { password: "123456789" }].map((b) => R("POST /vault/snapshot/export", { body: b })));
add("export ok", (S) => { S.q["select:vaultSnapshotsTable"] = [[]]; }, [R("POST /vault/snapshot/export", { body: { password: "correct-horse", includeAttachments: 1, label: "  my label  " } }), R("POST /vault/snapshot/export", { body: { password: "correct-horse", label: " " } }), R("POST /vault/snapshot/export", { body: { password: "correct-horse", label: "x".repeat(300) } })]);
add("export prunes by count + quota", (S) => { S.q["select:vaultSnapshotsTable"] = [[...Array.from({ length: 23 }, (_, i) => ({ id: i + 1, sizeBytes: 10 }))], [{ id: 1, sizeBytes: 300 * 1024 * 1024 }, { id: 2, sizeBytes: 5 }]]; }, [R("POST /vault/snapshot/export", { body: { password: "correct-horse" } })]);
add("export with vault rows + wallets", (S) => { S.q["select:vaultEntriesTable"] = [[{ id: 1, userId: 1, password: "pw", title: "t" }]]; S.q["select:walletsTable"] = [[{ id: 2, userId: 1, encryptedPhrase: "enc" }, { id: 3, userId: 1, encryptedPhrase: "bad" }, { id: 4, userId: 1, encryptedPhrase: null }]]; }, [R("POST /vault/snapshot/export", { body: { password: "correct-horse" } })]);
add("export db fails", (S) => { S.thr["insert:vaultSnapshotsTable"] = "db down"; }, [R("POST /vault/snapshot/export", { body: { password: "correct-horse" } })]);
const ROW = { id: 5, userId: 1, blob: "AYZENBAK2:x", checksum: null, encryptionMode: "password", createdAt: "2026-02-03T04:05:06Z" };
add("list", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ id: 1, label: "a" }, { id: 2, label: null }]]; }, [R("GET /vault/snapshots")]);
add("list empty", () => {}, [R("GET /vault/snapshots")]);
add("list db error", (S) => { S.thr["select:vaultSnapshotsTable"] = "db down"; }, [R("GET /vault/snapshots")]);
add("storage", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ sizeBytes: 1000 }, { sizeBytes: 2000 }]]; }, [R("GET /vault/snapshots/storage")]);
add("storage full", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ sizeBytes: 999 * 1024 * 1024 }]]; }, [R("GET /vault/snapshots/storage")]);
add("storage empty", () => {}, [R("GET /vault/snapshots/storage")]);
add("download missing", () => {}, [ID("GET /vault/snapshots/:id/download")]);
add("download ok", (S) => { S.q["select:vaultSnapshotsTable"] = [[ROW]]; }, [ID("GET /vault/snapshots/:id/download")]);
add("download envelope row", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, encryptionMode: undefined }]]; }, [ID("GET /vault/snapshots/:id/download")]);
add("download bad checksum", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, checksum: "nope" }]]; }, [ID("GET /vault/snapshots/:id/download")]);
add("download good checksum", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, checksum: "H(sha256:11:AYZENBAK)" }]]; }, [ID("GET /vault/snapshots/:id/download")]);
add("download anomalous", (S) => { S.q["select:vaultSnapshotsTable"] = [[ROW]]; S.anom = true; }, [ID("GET /vault/snapshots/:id/download")]);
add("download anomaly check throws", (S) => { S.q["select:vaultSnapshotsTable"] = [[ROW]]; S.anomThrow = true; }, [ID("GET /vault/snapshots/:id/download")]);
add("rename", (S) => { S.q["update:vaultSnapshotsTable"] = [[{ id: 5 }]]; }, [ID("PATCH /vault/snapshots/:id", "5", { body: { label: "  new  " } }), ID("PATCH /vault/snapshots/:id", "5", { body: { label: "  " } }), ID("PATCH /vault/snapshots/:id", "5", { body: { label: 3 } }), ID("PATCH /vault/snapshots/:id", "5", { body: undefined }), ID("PATCH /vault/snapshots/:id", "5", { body: { label: "y".repeat(500) } })]);
add("rename missing", () => {}, [ID("PATCH /vault/snapshots/:id", "5", { body: { label: "x" } })]);
add("trash", (S) => { S.q["update:vaultSnapshotsTable"] = [[{ id: 5 }]]; }, [ID("DELETE /vault/snapshots/:id")]);
add("trash missing", () => {}, [ID("DELETE /vault/snapshots/:id")]);
add("trash audit fails", (S) => { S.q["update:vaultSnapshotsTable"] = [[{ id: 5 }]]; S.auditThrow = true; }, [ID("DELETE /vault/snapshots/:id")]);
add("trash list", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ id: 1, deletedAt: "2026-01-01T00:00:00Z" }, { id: 2, deletedAt: null }]]; }, [R("GET /vault/snapshots/trash")]);
add("trash list empty", () => {}, [R("GET /vault/snapshots/trash")]);
add("untrash", (S) => { S.q["update:vaultSnapshotsTable"] = [[{ id: 5 }]]; }, [ID("POST /vault/snapshots/:id/restore")]);
add("untrash missing", () => {}, [ID("POST /vault/snapshots/:id/restore")]);
add("purge", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ id: 5 }]]; }, [ID("DELETE /vault/snapshots/trash/:id")]);
add("purge missing", () => {}, [ID("DELETE /vault/snapshots/trash/:id")]);
add("purge delete fails", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ id: 5 }]]; S.thr["delete:vaultSnapshotsTable"] = "FK in use"; }, [ID("DELETE /vault/snapshots/trash/:id")]);
const goodBlob = (pw) => ["AYZENBAK2", Buffer.alloc(16, 0xab).toString("base64"), Buffer.alloc(12, 1).toString("base64"), Buffer.from(pw).toString("base64"), Buffer.from(JSON.stringify({ hello: 1 })).toString("base64")].join(":");
for (const [name, rt] of [["preview", "POST /vault/snapshot/restore-preview"], ["restore", "POST /vault/snapshot/restore"]]) {
  add(name + " input errors", () => {}, [undefined, {}, { snapshotId: "x" }, { password: "pw" }, { blob: "b" }, { blob: 5, password: "pw" }].map((b) => R(rt, { body: b })));
  add(name + " blob", () => {}, [R(rt, { body: { blob: goodBlob("pw-correct-1"), password: "pw-correct-1" } }), R(rt, { body: { blob: goodBlob("pw-correct-1"), password: "wrong-pass-22" } }), R(rt, { body: { blob: "ENV1:zzz", password: "pw" } }), R(rt, { body: { blob: "AYZENBAK9:a:b:c:d", password: "pw" } })]);
  add(name + " stored password row", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, blob: goodBlob("pw-correct-1") }]]; }, [R(rt, { body: { snapshotId: 5, password: "pw-correct-1" } }), R(rt, { body: { snapshotId: 5, password: "nope-nope-1" } })]);
  add(name + " stored missing", () => {}, [R(rt, { body: { snapshotId: 5, password: "pw" } })]);
  add(name + " stored bad checksum", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, checksum: "bad" }]]; }, [R(rt, { body: { snapshotId: 5, password: "pw" } })]);
  add(name + " stored envelope", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, blob: "ENV2:abc", encryptionMode: "envelope" }]]; }, [R(rt, { body: { snapshotId: 5 } })]);
  add(name + " stored envelope prefix only", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, blob: "  ENV1:abc" }]]; }, [R(rt, { body: { snapshotId: 5 } })]);
  add(name + " stored envelope fails", (S) => { S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, blob: "ENV2:abc", encryptionMode: "envelope" }]]; S.envThrow = "no key"; }, [R(rt, { body: { snapshotId: 5 } })]);
  add(name + " bad snapshotId type", () => {}, [R(rt, { body: { snapshotId: null, password: "pw" } })]);
}
add("restore anomalous + audit", (S) => { S.anom = true; S.q["select:vaultSnapshotsTable"] = [[{ ...ROW, blob: goodBlob("pw-correct-1") }]]; }, [R("POST /vault/snapshot/restore", { body: { snapshotId: "5", password: "pw-correct-1" } })]);
add("restore anomaly check throws", (S) => { S.anomThrow = true; }, [R("POST /vault/snapshot/restore", { body: { blob: goodBlob("pw-correct-1"), password: "pw-correct-1" } })]);

const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "function" ? "fn" : v)).replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"T"'));
async function run(routeText) {
  const out = [];
  for (const sc of scenarios) {
    const { S, router, ownReg, mocks } = makeRuntime(routeText); sc.setup(S);
    const log = [];
    for (const c of sc.calls) {
      if (c.route === "__routes__") { log.push(["routes", Object.keys(router.routes), Object.fromEntries(Object.entries(router.mws).map(([k, v]) => [k, v.map((m) => (m && m.__own ? ["own", m.action, m.opts.onDecision] : m))])), ownReg.length]); continue; }
      if (c.route === "__own__") {
        for (const d of ownReg) {
          let r; try { r = await d.resource({ params: { id: "5" } }); } catch (e) { r = "THROW:" + e.message; }
          const nan = await d.resource({ params: { id: "zz" } });
          const deny = []; for (const id of ["5", "zz"]) { let st, body; const res = { status(n) { st = n; return res; }, json(b) { body = b; return res; } }; d.opts.onDeny({ params: { id } }, res); deny.push([st, body]); }
          log.push([d.action, r, nan, deny]);
        }
        continue;
      }
      const h = router.routes[c.route];
      if (!h) { log.push([c.route, "NO ROUTE"]); continue; }
      const hdr = {}; let st = 200, body, sent;
      const res = { status(n) { st = n; return res; }, json(b) { body = b; return res; }, send(b) { sent = b; return res; }, setHeader(k, v) { hdr[k] = v; } };
      try { await h({ uid: c.uid, body: c.body, params: c.params, ip: c.ip }, res); } catch (e) { body = "THROW:" + e.message; }
      log.push([c.route, st, body ?? null, sent ?? null, hdr]);
    }
    log.push(["side", S.ops, S.log]);
    out.push([sc.name, norm(log)]);
  }
  return out;
}
const a = await run(BASE);
const b = await run(fs.readFileSync(ROUTE, "utf8"));
let bad = 0, calls = 0;
for (let i = 0; i < a.length; i++) {
  calls += a[i][1].length - 1;
  try { assert.deepStrictEqual(b[i], a[i]); } catch { bad++; console.log(`DIFF ${a[i][0]}`); console.log(" old:", JSON.stringify(a[i][1]).slice(0, 900)); console.log(" new:", JSON.stringify(b[i][1]).slice(0, 900)); }
}
// the differential must actually exercise something: guard against a vacuous all-404 run
const hits = a.flatMap(([, l]) => l).filter((e) => typeof e[1] === "number" && e[1] === 200).length;
if (hits < 15) { console.log(`differential FAIL — only ${hits} successful responses; mocks are not exercising the handlers`); process.exit(1); }
console.log(`scenarios=${a.length} calls=${calls} ok_responses=${hits} diffs=${bad}`);
process.exit(bad ? 1 : 0);
