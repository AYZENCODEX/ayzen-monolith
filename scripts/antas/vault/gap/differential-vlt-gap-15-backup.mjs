#!/usr/bin/env node
// VLT-GAP-15 module-level differential: backup-envelope, backup-cloud, backup-alerts.
// OLD = frozen VLT-GAP-08 baseline of lib/vault-backup-{envelope,cloud,alerts}. NEW = current vault/ owners.
// Unlike the route replay these are NOT faked: the modules' own code runs on both sides.
//   envelope: real node:crypto + real packages/vault-crypto aes-gcm.mjs, stateful fake encryption_keys table (the NEW side
//             goes through the REAL key-store port + repository, so the SQL is executed too), cross-decrypt both ways.
//   cloud:    scripted fake fetch (every URL/method/header/body recorded), stateful fake connection table, fake clock.
//   alerts:   fake users table, recording email/telegram/notification sinks incl. failing sinks, fake clock.
// Then planted mutants in the NEW source must each change a trace (sensitivity).
import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import { ROOT, rejectBypass } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL -- bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = loadTs(ROOT);
if (!ts) { console.error("differential FAIL -- typescript compiler not found (fail closed)"); process.exit(1); }
const SRC = path.join(ROOT, "artifacts/api-server/src");
const BASE = (n) => fs.readFileSync(path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-08/baseline/sources", `artifacts__api__server__src__lib__vault__backup__${n}__ts`), "utf8");
const AES = await import(path.join(ROOT, "packages/vault-crypto/src/aes-gcm.mjs"));
const NOW = 1_700_000_000_000;
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x instanceof Date ? `date:${x.toISOString()}` : Buffer.isBuffer(x) ? `buf:${x.toString("hex")}` : x));
const norm = (v) => JSON.parse(json(v === undefined ? null : v));

class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
  toLocaleString() { return "WHEN"; }
}

// ───────────────────────── generic CommonJS loader over transpiled TS ─────────────────────────
function makeLoader(resolveSpec, shadow) {
  const cache = new Map();
  const load = (file, text) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = ts.transpileModule(text ?? fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cache.set(file, m);
    const names = Object.keys(shadow), vals = names.map((n) => shadow[n]);
    new Function("require", "module", "exports", "__filename", ...names, code)((s) => { const r = resolveSpec(s, file); return "mock" in r ? r.mock : load(r.file); }, m, m.exports, file, ...vals);
    return m.exports;
  };
  return load;
}
const resolveRel = (spec, from, mocks) => {
  if (mocks[spec] !== undefined) return { mock: mocks[spec] };
  if (/aes-gcm\.mjs$/.test(spec)) return { mock: AES };
  if (!spec.startsWith(".")) { if (spec === "crypto") return { mock: nodeCrypto }; throw new Error(`unmocked bare import ${spec}`); }
  const abs = path.resolve(path.dirname(from), spec);
  for (const [re, m] of mocks.__logical ?? []) if (re.test(path.relative(SRC, abs).split(path.sep).join("/"))) return { mock: m };
  for (const ext of [".ts", "/index.ts"]) if (fs.existsSync(abs + ext)) return { file: abs + ext };
  throw new Error(`unresolved ${spec} from ${from}`);
};

// ───────────────────────── fake encryption_keys table (interprets the exact SQL both sides send) ─────────────────────────
function makeKeyDb(S) {
  const sqlTag = (strs, ...vals) => ({ text: strs.join("?").replace(/\s+/g, " ").trim(), vals });
  const execute = async (q) => {
    S.sqlLog.push({ text: q.text, vals: q.vals.map((v) => (typeof v === "string" && /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(v) ? "<wrapped>" : v)) });
    if (S.dbFail?.(q.text)) throw new Error("db down");
    if (/^SELECT version, wrapped_dek, active FROM encryption_keys/.test(q.text)) { const ns = q.vals[0]; return { rows: S.keys.filter((k) => k.namespace === ns).sort((a, b) => a.version - b.version).map(({ version, wrapped_dek, active }) => ({ version, wrapped_dek, active })) }; }
    if (/^INSERT INTO encryption_keys .* VALUES \(\?, 1, \?, TRUE\) ON CONFLICT/.test(q.text)) { const [ns, wrapped] = q.vals; if (!S.keys.some((k) => k.namespace === ns && k.version === 1)) S.keys.push({ namespace: ns, version: 1, wrapped_dek: wrapped, active: true }); return { rows: [] }; }
    if (/^UPDATE encryption_keys SET active = FALSE WHERE namespace = \?/.test(q.text)) { for (const k of S.keys) if (k.namespace === q.vals[0]) k.active = false; return { rows: [] }; }
    if (/^INSERT INTO encryption_keys .* VALUES \(\?, \?, \?, TRUE\)$/.test(q.text)) { const [ns, version, wrapped] = q.vals; if (S.keys.some((k) => k.namespace === ns && k.version === version)) throw new Error("duplicate key"); S.keys.push({ namespace: ns, version, wrapped_dek: wrapped, active: true }); return { rows: [] }; }
    throw new Error(`fake db: unrecognised SQL ${q.text}`);
  };
  return { db: { execute }, sql: sqlTag };
}

// ───────────────────────── envelope ─────────────────────────
const KEY_A = "A".repeat(48), KEY_B = "B".repeat(40);
const hkdfKek = (raw) => AES.deriveKekHkdf(raw, Buffer.from("ayzen:vault-backup-envelope:kek-v2"), Buffer.from("kek"), 32);
const legacyKek = (raw) => AES.deriveLegacyAesKey(raw, 32);
const wrapWith = (kek, dek) => AES.packAesGcmHex(AES.encryptAes256Gcm(kek, dek));
const aad = (v, u) => Buffer.from(`vault-backup:v${v}:user:${u}`);
const mkBlob = (prefix, v, dek, plain, a) => { const { iv, encrypted, authTag } = AES.encryptAes256Gcm(dek, plain, a); return [prefix, v, iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":"); };

function envRuntime(side, newText, seedKeys, env) {
  const S = { keys: seedKeys.map((k) => ({ ...k })), sqlLog: [], dbFail: null };
  const { db, sql } = makeKeyDb(S);
  const mocks = { "@workspace/db": { db }, "drizzle-orm": { sql } };
  const saved = { ...process.env };
  for (const k of ["VAULT_MASTER_KEY", "VAULT_FIELD_ENCRYPTION_KEY"]) delete process.env[k];
  Object.assign(process.env, env);
  const restore = () => { for (const k of ["VAULT_MASTER_KEY", "VAULT_FIELD_ENCRYPTION_KEY"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  const resolve = (s, from) => resolveRel(s, from, mocks);
  let mod;
  if (side === "old") {
    mod = makeLoader(resolve, {})(path.join(SRC, "lib/__old__vault-backup-envelope.ts"), BASE("envelope"));
  } else {
    // new side: the REAL key-store port + REAL repository register against the same fake db
    const load = makeLoader(resolve, {});
    load(path.join(SRC, "vault/infrastructure/crypto-key-stores.ts"));
    mod = load(path.join(SRC, "vault/crypto/backup-envelope.ts"), newText);
  }
  return { S, mod, restore };
}
const errMsg = (e) => String(e?.message ?? e);
async function attempt(fn) { try { return { ok: await fn() }; } catch (e) { return { err: errMsg(e) }; } }
const shape = (b) => { const p = String(b).split(":"); return { prefix: p[0], version: Number(p[1]), parts: p.length }; };
// DB state normalised: wrapped_dek replaced by what it unwraps to (kek kind + dek length) so random IVs don't matter
function keyView(S, raw) {
  return S.keys.map((k) => {
    let kind = "unwrappable";
    const t = (kek) => { try { const { iv, encrypted, authTag } = AES.unpackAesGcmHex(k.wrapped_dek); return AES.decryptAes256Gcm(kek, iv, encrypted, authTag); } catch { return null; } };
    const s = raw ? t(hkdfKek(raw)) : null, l = raw ? t(legacyKek(raw)) : null;
    kind = s ? `hkdf:${s.length}` : l ? `legacy:${l.length}` : "opaque";
    return { namespace: k.namespace, version: k.version, active: k.active, wrapped: kind };
  });
}
const dekOf = (S, raw, version) => { const k = S.keys.find((x) => x.version === version); const { iv, encrypted, authTag } = AES.unpackAesGcmHex(k.wrapped_dek); try { return AES.decryptAes256Gcm(hkdfKek(raw), iv, encrypted, authTag); } catch { return AES.decryptAes256Gcm(legacyKek(raw), iv, encrypted, authTag); } };

const envScenarios = [];
const E = (name, env, seed, steps) => envScenarios.push({ name, env, seed, steps });
const DEK1 = Buffer.alloc(32, 0x11), DEK2 = Buffer.alloc(32, 0x22);
const ROW = (v, wrapped, active = true, ns = "vault-backup") => ({ namespace: ns, version: v, wrapped_dek: wrapped, active });
E("bootstrap + encrypt/decrypt roundtrip", { VAULT_MASTER_KEY: KEY_A }, [], [["enc", "hello vault", 5], ["dec-last", 5], ["version"]]);
E("fallback env key", { VAULT_FIELD_ENCRYPTION_KEY: KEY_B }, [], [["enc", "x", 1], ["dec-last", 1], ["version"]]);
E("master key wins over fallback", { VAULT_MASTER_KEY: KEY_A, VAULT_FIELD_ENCRYPTION_KEY: KEY_B }, [], [["enc", "x", 1], ["dec-last", 1]]);
E("no key configured", {}, [], [["load"], ["enc", "x", 1], ["version"]]);
E("short key rejected", { VAULT_MASTER_KEY: "short" }, [], [["load"], ["enc", "x", 1]]);
E("existing chain strong kek", { VAULT_MASTER_KEY: KEY_A }, [ROW(1, wrapWith(hkdfKek(KEY_A), DEK1), false), ROW(2, wrapWith(hkdfKek(KEY_A), DEK2), true)], [["load"], ["version"], ["enc", "p", 9], ["dec-last", 9], ["dec-blob", mkBlob("ENV2", 1, DEK1, "old v1", aad(1, 9)), 9]]);
E("legacy kek wrapped chain (fallback unwrap)", { VAULT_MASTER_KEY: KEY_A }, [ROW(1, wrapWith(legacyKek(KEY_A), DEK1), true)], [["load"], ["enc", "legacy-wrapped", 3], ["dec-last", 3], ["rotate"], ["enc", "after", 3], ["dec-last", 3]]);
E("wrong kek for chain", { VAULT_MASTER_KEY: KEY_B }, [ROW(1, wrapWith(hkdfKek(KEY_A), DEK1), true)], [["load"], ["enc", "x", 1]]);
E("no active row -> highest version", { VAULT_MASTER_KEY: KEY_A }, [ROW(1, wrapWith(hkdfKek(KEY_A), DEK1), false), ROW(4, wrapWith(hkdfKek(KEY_A), DEK2), false)], [["load"], ["version"], ["enc", "p", 2], ["dec-last", 2]]);
E("rotate keeps old versions decryptable", { VAULT_MASTER_KEY: KEY_A }, [], [["enc", "v1 data", 7], ["save-last"], ["rotate"], ["version"], ["enc", "v2 data", 7], ["dec-last", 7], ["dec-saved", 7], ["rotate"], ["dec-saved", 7], ["version"]]);
E("rotate before load", { VAULT_MASTER_KEY: KEY_A }, [], [["rotate"], ["version"], ["load"], ["version"]]);
E("AAD binds owner (ENV2 wrong owner)", { VAULT_MASTER_KEY: KEY_A }, [], [["enc", "secret", 11], ["dec-last", 11], ["dec-last", 12], ["dec-last", 0]]);
E("legacy ENV1 blob has no AAD", { VAULT_MASTER_KEY: KEY_A }, [ROW(1, wrapWith(hkdfKek(KEY_A), DEK1), true)], [["load"], ["dec-blob", mkBlob("ENV1", 1, DEK1, "legacy", undefined), 1], ["dec-blob", mkBlob("ENV1", 1, DEK1, "legacy", undefined), 999]]);
E("malformed / unknown blobs", { VAULT_MASTER_KEY: KEY_A }, [ROW(1, wrapWith(hkdfKek(KEY_A), DEK1), true)], [["dec-blob", "garbage", 1], ["dec-blob", "ENV3:1:a:b:c", 1], ["dec-blob", "ENV2:1:a:b", 1], ["dec-blob", "ENV2:7:AAAA:AAAA:AAAA", 1], ["dec-blob", "  " + mkBlob("ENV2", 1, DEK1, "trim", aad(1, 2)) + "\n", 2], ["dec-blob", mkBlob("ENV2", 1, DEK1, "tampered", aad(1, 2)).replace(/.$/, (c) => (c === "A" ? "B" : "A")), 2]]);
E("db failures", { VAULT_MASTER_KEY: KEY_A }, [], [["fail", /^SELECT/], ["load"], ["fail", null], ["load"], ["fail", /^INSERT/], ["load"], ["fail", null], ["enc", "x", 1], ["fail", /^UPDATE/], ["rotate"]]);

async function runEnvScenario(sc, side, newText) {
  const { S, mod, restore } = envRuntime(side, newText, sc.seed, sc.env);
  const trace = []; let last = null, saved = null;
  try {
    for (const st of sc.steps) {
      const [op, a, b] = st;
      if (op === "load") trace.push([op, await attempt(() => mod.loadBackupEnvelopeKeyManager())]);
      else if (op === "version") trace.push([op, await attempt(() => mod.getActiveBackupEnvelopeVersion())]);
      else if (op === "rotate") trace.push([op, await attempt(() => mod.rotateBackupEnvelopeKey())]);
      else if (op === "fail") S.dbFail = a ? (t) => a.test(t) : null;
      else if (op === "enc") { const r = await attempt(() => mod.envelopeEncryptBackup(a, b)); if (r.ok) last = r.ok.blob; trace.push([op, r.err ? r : { ok: { shape: shape(r.ok.blob), version: r.ok.version } }]); }
      else if (op === "save-last") saved = last;
      else if (op === "dec-last") trace.push([op, b, await attempt(() => mod.envelopeDecryptBackup(last, a))]);
      else if (op === "dec-saved") trace.push([op, await attempt(() => mod.envelopeDecryptBackup(saved, a))]);
      else if (op === "dec-blob") trace.push([op, await attempt(() => mod.envelopeDecryptBackup(a, b))]);
    }
  } finally { restore(); }
  const raw = sc.env.VAULT_MASTER_KEY || sc.env.VAULT_FIELD_ENCRYPTION_KEY;
  return { trace: norm(trace), sql: norm(S.sqlLog), keys: norm(keyView(S, raw && raw.length >= 32 ? raw : null)), S, last, raw };
}

// cross-decrypt: blob written by one side, key chain loaded by the other from the first side's final table
async function crossCells(newText) {
  const cells = [];
  for (const [w, r] of [["old", "new"], ["new", "old"]]) {
    const env = { VAULT_MASTER_KEY: KEY_A };
    const a = envRuntime(w, newText, [], env);
    const blobs = [];
    try {
      for (const [p, u] of [["first", 5], ["日本語 ünïcode", 6]]) blobs.push([p, u, (await a.mod.envelopeEncryptBackup(p, u)).blob]);
      await a.mod.rotateBackupEnvelopeKey();
      blobs.push(["after-rotate", 5, (await a.mod.envelopeEncryptBackup("after-rotate", 5)).blob]);
    } finally { a.restore(); }
    const b = envRuntime(r, newText, a.S.keys, env);
    try {
      for (const [p, u, blob] of blobs) cells.push({ name: `${w}->${r} decrypt ${JSON.stringify(p)}`, got: await attempt(() => b.mod.envelopeDecryptBackup(blob, u)), want: { ok: p } });
      cells.push({ name: `${w}->${r} wrong owner rejected`, got: norm(await attempt(() => b.mod.envelopeDecryptBackup(blobs[0][2], 99))).err ? "rejected" : "ACCEPTED", want: "rejected" });
    } finally { b.restore(); }
    // the stored wrapped DEKs written by `w` must unwrap to the same DEK `w` used (both chains share the table)
    cells.push({ name: `${w} wrote unwrappable DEKs`, got: a.S.keys.every((k) => dekOf(a.S, KEY_A, k.version).length === 32), want: true });
  }
  return cells;
}

// ───────────────────────── cloud ─────────────────────────
const CLOUD_ENV_FULL = { GOOGLE_DRIVE_CLIENT_ID: "gid", GOOGLE_DRIVE_CLIENT_SECRET: "gsec", GOOGLE_DRIVE_REDIRECT_URI: "https://app/cb/g", DROPBOX_CLIENT_ID: "did", DROPBOX_CLIENT_SECRET: "dsec", DROPBOX_REDIRECT_URI: "https://app/cb/d" };
const CLOUD_ENV_KEYS = Object.keys(CLOUD_ENV_FULL);
// VLT-GAP-19 intentional behaviour change in cloud upload (reviewed; asserted by the "cloud-intentional" cells below, so it cannot hide a regression):
//   * Drive: the NEW code first asks whether a file of that name already exists in the backup folder and skips the upload if so (a redelivery of the same
//     snapshot used to add a second file). That probe is answered from S.existing and kept OUT of the compared trace.
//   * Dropbox: the NEW code uploads with mode "overwrite"/autorename false instead of "add"/autorename true (a redelivery used to add an auto-renamed copy).
//     The recorded header is normalised back to the OLD spelling for the comparison; the raw header is kept in S.raw for the intentional cells.
const isDedupeProbe = (url) => /drive\/v3\/files\?q=name%3D/.test(url) && /in%20parents/.test(url);
function makeFetch(S, side = "old") {
  const rec = (v) => (v instanceof URLSearchParams ? `qs:${v.toString()}` : Buffer.isBuffer(v) ? `buf:${v.toString("utf8")}` : v);
  return async (url, init = {}) => {
    if (side === "new" && isDedupeProbe(String(url))) { S.probes.push(String(url)); return { ok: true, status: 200, json: async () => ({ files: S.existing ?? [] }), text: async () => "" }; }
    S.raw.push({ url: String(url), headers: init.headers ?? null });
    const hdrs = side === "new" && init.headers?.["Dropbox-API-Arg"] ? { ...init.headers, "Dropbox-API-Arg": init.headers["Dropbox-API-Arg"].replace('"mode":"overwrite","autorename":false', '"mode":"add","autorename":true') } : (init.headers ?? null);
    S.fetchLog.push({ url: String(url), method: init.method ?? "GET", headers: hdrs, body: rec(init.body) ?? null });
    const r = S.routes.shift?.() ?? S.fetchDefault; if (r === "throw") throw new Error("network down");
    const x = typeof r === "function" ? r(String(url), init) : r;
    if (x === "throw") throw new Error("network down");
    return { ok: x.ok, status: x.status ?? (x.ok ? 200 : 400), json: async () => { if (x.badJson) throw new Error("bad json"); return x.json; }, text: async () => { if (x.badText) throw new Error("bad text"); return x.text ?? ""; } };
  };
}
const OK = (json) => ({ ok: true, json });
const BAD = (json, status = 400) => ({ ok: false, status, json });
function cloudRuntime(side, newText, seed) {
  const S = { rows: seed.rows.map((r) => ({ ...r })), ops: [], fetchLog: [], probes: [], raw: [], existing: seed.existing ?? [], routes: [...seed.routes], fetchDefault: seed.def ?? BAD({}), nextId: 100, dbFail: null, logs: [] };
  const eqf = (col, v) => ({ eq: [col.c, v] }), andf = (...a) => ({ and: a });
  const cond = (c, row) => (c.and ? c.and.every((x) => cond(x, row)) : row[c.eq[0]] === c.eq[1]);
  const T = new Proxy({ __t: "conn" }, { get: (t, p) => (p === "__t" ? "conn" : { c: String(p) }) });
  const chain = (fn) => { const p = { where: (c) => { return Promise.resolve().then(() => fn(c)); }, then: (r, j) => Promise.resolve().then(() => fn(null)).then(r, j) }; return p; };
  const mocks = {
    "drizzle-orm": { eq: eqf, and: andf },
    "@workspace/db": { vaultBackupCloudConnectionsTable: T, db: {
      select: () => ({ from: () => chain((c) => { S.ops.push(["select", norm(c)]); if (S.dbFail === "select") throw new Error("db select"); return S.rows.filter((r) => !c || cond(c, r)); }) }),
      update: () => ({ set: (v) => chain((c) => { S.ops.push(["update", norm(v), norm(c)]); S.rows.filter((r) => cond(c, r)).forEach((r) => Object.assign(r, v)); }) }),
      insert: () => ({ values: async (v) => { S.ops.push(["insert", norm(v)]); S.rows.push({ id: S.nextId++, ...v }); } }),
      delete: () => chain((c) => { S.ops.push(["delete", norm(c)]); if (S.dbFail === "delete") throw new Error("db delete"); S.rows = S.rows.filter((r) => !cond(c, r)); }) } },
    "logger-mock": null,
  };
  const logger = { warn: (...a) => S.logs.push(["warn", norm(a.map((x) => (x && x.err ? { err: errMsg(x.err) } : x)))]), error: (...a) => S.logs.push(["error", norm(a)]), info: () => {} };
  const fe = { encryptField: (v) => (v == null ? v : `E(${v})`), decryptField: (v) => (v == null ? v : String(v).replace(/^E\((.*)\)$/s, "$1")) };
  const jwt = { signOAuthState: (p) => `S:${json(p)}`, verifyOAuthState: (s) => (typeof s === "string" && s.startsWith("S:") ? JSON.parse(s.slice(2)) : s === "numeric-user-bad" ? { userId: "x", provider: "google_drive" } : null) };
  const logical = [[/vault\/crypto\/field-encryption$/, fe], [/lib\/jwt$/, jwt], [/lib\/logger$/, { logger }]];
  const m = { ...mocks, __logical: logical };
  const resolve = (s, from) => resolveRel(s, from, m);
  const shadow = { fetch: makeFetch(S, side), Date: FakeDate };
  const mod = side === "old" ? makeLoader(resolve, shadow)(path.join(SRC, "lib/__old__vault-backup-cloud.ts"), BASE("cloud")) : makeLoader(resolve, shadow)(path.join(SRC, "vault/infrastructure/backup/cloud.ts"), newText);
  return { S, mod };
}
const GCONN = (o = {}) => ({ id: 1, userId: 5, provider: "google_drive", accessToken: "E(at1)", refreshToken: "E(rt1)", expiresAt: new Date(NOW + 3_600_000).toISOString(), accountLabel: "a@b", folderId: "F1", ...o });
const DCONN = (o = {}) => GCONN({ id: 2, provider: "dropbox", folderId: null, ...o });
const cloudScenarios = [];
const CL = (name, env, seed, steps) => cloudScenarios.push({ name, env, seed: { rows: [], routes: [], ...seed }, steps });
CL("configured matrix", CLOUD_ENV_FULL, {}, [["configured", "google_drive"], ["configured", "dropbox"]]);
CL("unconfigured / partial", { GOOGLE_DRIVE_CLIENT_ID: "x", DROPBOX_CLIENT_ID: "y", DROPBOX_CLIENT_SECRET: "z" }, {}, [["configured", "google_drive"], ["configured", "dropbox"]]);
CL("authorize urls", CLOUD_ENV_FULL, {}, [["authurl", "google_drive", 5], ["authurl", "dropbox", 6]]);
CL("authorize state", CLOUD_ENV_FULL, {}, [["state", "S:" + json({ userId: 5, provider: "dropbox" })], ["state", "S:" + json({ userId: 5, provider: "box" })], ["state", "S:" + json({ userId: "5", provider: "dropbox" })], ["state", "numeric-user-bad"], ["state", "junk"]]);
CL("connect google new", CLOUD_ENV_FULL, { routes: [OK({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }), OK({ email: "me@x" }), OK({ files: [{ id: "FOLD" }] })] }, [["connect", "google_drive", 5, "code1"]]);
CL("connect google folder created", CLOUD_ENV_FULL, { routes: [OK({ access_token: "AT", expires_in: 0 }), BAD({}), BAD({}), OK({ id: "NEW" })] }, [["connect", "google_drive", 5, "c"]]);
CL("connect google folder create fails", CLOUD_ENV_FULL, { routes: [OK({ access_token: "AT" }), OK({}), { ok: true, json: {} , badJson: false }, BAD({ error: { message: "quota" } })] }, [["connect", "google_drive", 5, "c"]]);
CL("connect google folder create fails no msg", CLOUD_ENV_FULL, { routes: [OK({ access_token: "AT" }), OK({}), OK({ files: [] }), BAD({})] }, [["connect", "google_drive", 5, "c"]]);
CL("connect google reauth keeps refresh", CLOUD_ENV_FULL, { rows: [GCONN({ refreshToken: "E(old-rt)" })], routes: [OK({ access_token: "AT2", expires_in: 100 }), OK({ email: "me@x" }), OK({ files: [{ id: "F2" }] })] }, [["connect", "google_drive", 5, "c"]]);
CL("connect google reauth new refresh", CLOUD_ENV_FULL, { rows: [GCONN()], routes: [OK({ access_token: "AT2", refresh_token: "NEWRT" }), "throw", OK({ files: [{ id: "F2" }] })] }, [["connect", "google_drive", 5, "c"]]);
CL("connect google token errors", CLOUD_ENV_FULL, {}, [["connect", "google_drive", 5, "c", [BAD({ error_description: "desc", error: "e" })]], ["connect", "google_drive", 5, "c", [BAD({ error: "just-err" })]], ["connect", "google_drive", 5, "c", [BAD({})]], ["connect", "google_drive", 5, "c", ["throw"]]]);
CL("connect google userinfo failures", CLOUD_ENV_FULL, {}, [["connect", "google_drive", 5, "c", [OK({ access_token: "A" }), BAD({}), OK({ files: [{ id: "F" }] })]], ["connect", "google_drive", 6, "c", [OK({ access_token: "A" }), OK({}), OK({ files: [{ id: "F" }] })]]]);
CL("connect dropbox new", CLOUD_ENV_FULL, { routes: [OK({ access_token: "DAT", refresh_token: "DRT", expires_in: 14400 }), OK({ email: "d@x" })] }, [["connect", "dropbox", 7, "dc"]]);
CL("connect dropbox errors", CLOUD_ENV_FULL, {}, [["connect", "dropbox", 7, "c", [BAD({ error_description: "dbx desc" })]], ["connect", "dropbox", 7, "c", [BAD({ error: "dbx-err" })]], ["connect", "dropbox", 7, "c", [BAD({})]], ["connect", "dropbox", 7, "c", [OK({ access_token: "T" }), "throw"]], ["connect", "dropbox", 7, "c", [OK({ access_token: "T" }), BAD({})]]]);
CL("connect db failure", CLOUD_ENV_FULL, { routes: [OK({ access_token: "AT" }), OK({ email: "e" }), OK({ files: [{ id: "F" }] })] }, [["dbfail", "select"], ["connect", "google_drive", 5, "c"]]);
CL("upload google ok valid token", CLOUD_ENV_FULL, { rows: [GCONN()], routes: [OK({})] }, [["gup", 5, "b.ayz", "BLOB-DATA"]]);
CL("upload google not connected", CLOUD_ENV_FULL, {}, [["gup", 5, "b", "x"]]);
CL("upload google no folder id", CLOUD_ENV_FULL, { rows: [GCONN({ folderId: null })], routes: [OK({ files: [{ id: "LISTED" }] }), OK({})] }, [["gup", 5, "b", "x"]]);
CL("upload google expired refresh ok", CLOUD_ENV_FULL, { rows: [GCONN({ expiresAt: new Date(NOW + 30_000).toISOString() })], routes: [OK({ access_token: "FRESH", expires_in: 3600 }), OK({})] }, [["gup", 5, "b", "x"]]);
CL("upload google expired no expiry date", CLOUD_ENV_FULL, { rows: [GCONN({ expiresAt: null })], routes: [OK({})] }, [["gup", 5, "b", "x"]]);
CL("upload google expired no refresh token", CLOUD_ENV_FULL, { rows: [GCONN({ expiresAt: new Date(NOW - 1000).toISOString(), refreshToken: null })], routes: [OK({})] }, [["gup", 5, "b", "x"]]);
CL("upload google boundary 60s", CLOUD_ENV_FULL, { rows: [GCONN({ expiresAt: new Date(NOW + 60_000).toISOString() })], routes: [OK({ access_token: "R", expires_in: 1 }), OK({})] }, [["gup", 5, "b", "x"]]);
CL("upload google refresh fails", CLOUD_ENV_FULL, { rows: [GCONN({ expiresAt: new Date(NOW - 1000).toISOString() })], routes: [BAD({ error_description: "revoked" })] }, [["gup", 5, "b", "x"]]);
CL("upload google upload fails", CLOUD_ENV_FULL, {}, [["gup", 5, "b", "x", { rows: [GCONN()], routes: [BAD({ error: { message: "storage full" } })] }], ["gup", 5, "b", "x", { rows: [GCONN()], routes: [{ ok: false, status: 503, badJson: true }] }]]);
CL("upload dropbox ok", CLOUD_ENV_FULL, { rows: [DCONN()], routes: [OK({})] }, [["dup", 5, "my backup.ayz", "ÜNICODE-BLOB"]]);
CL("upload dropbox not connected", CLOUD_ENV_FULL, {}, [["dup", 5, "b", "x"]]);
CL("upload dropbox refresh then upload", CLOUD_ENV_FULL, { rows: [DCONN({ expiresAt: new Date(NOW - 5).toISOString() })], routes: [OK({ access_token: "DFRESH" }), OK({})] }, [["dup", 5, "b", "x"]]);
CL("upload dropbox fails", CLOUD_ENV_FULL, {}, [["dup", 5, "b", "x", { rows: [DCONN()], routes: [{ ok: false, status: 409, text: "path/conflict" }] }], ["dup", 5, "b", "x", { rows: [DCONN()], routes: [{ ok: false, status: 500, badText: true }] }], ["dup", 5, "b", "x", { rows: [DCONN()], routes: [{ ok: false, status: 502, text: "" }] }]]);
CL("list + disconnect", CLOUD_ENV_FULL, { rows: [GCONN({ accountLabel: "g@x" }), DCONN({ userId: 9 })] }, [["list", 5], ["list", 9], ["list", 1], ["disconnect", 5, "google_drive"], ["list", 5], ["disconnect", 5, "dropbox"]]);
CL("list unconfigured server", {}, { rows: [GCONN()] }, [["list", 5]]);
CL("disconnect db failure", CLOUD_ENV_FULL, { rows: [GCONN()] }, [["dbfail", "delete"], ["disconnect", 5, "google_drive"]]);

async function runCloudScenario(sc, side, newText) {
  const saved = Object.fromEntries(CLOUD_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CLOUD_ENV_KEYS) delete process.env[k]; Object.assign(process.env, sc.env);
  const trace = [];
  try {
    let rt = cloudRuntime(side, newText, sc.seed);
    for (const st of sc.steps) {
      const [op, ...a] = st;
      const withSeed = (extra) => { if (extra && !Array.isArray(extra)) { rt = cloudRuntime(side, newText, { rows: [], routes: [], ...extra }); } else if (Array.isArray(extra)) { rt.S.routes = [...extra]; } };
      if (op === "dbfail") { rt.S.dbFail = a[0]; continue; }
      let r;
      if (op === "configured") r = { ok: rt.mod.isCloudProviderConfigured(a[0]) };
      else if (op === "authurl") r = await attempt(() => rt.mod.buildAuthorizeUrl(a[0], a[1]));
      else if (op === "state") r = await attempt(() => rt.mod.verifyAuthorizeState(a[0]));
      else if (op === "connect") { withSeed(a[3]); r = await attempt(() => rt.mod.completeCloudConnect(a[0], a[1], a[2])); }
      else if (op === "gup") { withSeed(a[3]); r = await attempt(() => rt.mod.uploadToGoogleDrive(a[0], a[1], a[2])); }
      else if (op === "dup") { withSeed(a[3]); r = await attempt(() => rt.mod.uploadToDropbox(a[0], a[1], a[2])); }
      else if (op === "list") r = await attempt(() => rt.mod.listCloudConnections(a[0]));
      else if (op === "disconnect") r = await attempt(() => rt.mod.disconnectCloudProvider(a[0], a[1]));
      trace.push({ step: st.map((x) => (typeof x === "object" ? "…" : x)), r: norm(r), fetch: norm(rt.S.fetchLog.splice(0)), ops: norm(rt.S.ops.splice(0)), logs: norm(rt.S.logs.splice(0)), rows: norm(rt.S.rows) });
    }
    trace.push({ providers: norm(makeProviders(side, newText, sc)) });
  } finally { for (const k of CLOUD_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  return trace;
}
async function cloudIntentionalCells(newText) {
  const out = [], env = CLOUD_ENV_FULL, saved = Object.fromEntries(CLOUD_ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const drive = async (existing) => { const rt = cloudRuntime("new", newText, { rows: [GCONN()], routes: [OK({ id: "created" })], existing }); await rt.mod.uploadToGoogleDrive(5, "snap-1.ayzenbak", "BLOB"); return rt.S; };
    const skip = await drive([{ id: "already" }]);
    out.push({ name: "drive: a file of that name already in the folder is not uploaded again", ok: skip.probes.length === 1 && /snap-1\.ayzenbak/.test(decodeURIComponent(skip.probes[0])) && /'F1' in parents/.test(decodeURIComponent(skip.probes[0])) && !skip.fetchLog.some((f) => f.method === "POST"), detail: { probes: skip.probes, fetch: skip.fetchLog } });
    const first = await drive([]);
    out.push({ name: "drive: first delivery probes once and uploads once", ok: first.probes.length === 1 && first.fetchLog.filter((f) => f.method === "POST").length === 1, detail: { probes: first.probes, fetch: first.fetchLog } });
    const dbx = cloudRuntime("new", newText, { rows: [DCONN()], routes: [OK({})] }); await dbx.mod.uploadToDropbox(5, "snap-1.ayzenbak", "BLOB");
    const arg = JSON.parse(dbx.S.raw[0]?.headers?.["Dropbox-API-Arg"] ?? "{}");
    out.push({ name: "dropbox: redelivery overwrites the same file instead of adding an auto-renamed copy", ok: arg.mode === "overwrite" && arg.autorename === false && arg.path === "/AYZEN Vault Backups/snap-1.ayzenbak", detail: { arg } });
  } finally { for (const k of CLOUD_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  return out;
}
function makeProviders(side, newText, sc) { const rt = cloudRuntime(side, newText, { rows: [], routes: [] }); return rt.mod.CLOUD_PROVIDERS; }

// ───────────────────────── alerts ─────────────────────────
function alertsRuntime(side, newText, users, modes) {
  const S = { out: [], logs: [] };
  const sel = (rows) => ({ from: () => ({ where: () => (modes.dbFail ? Promise.reject(new Error("db down")) : Promise.resolve(rows)) }) });
  const mocks = {
    "drizzle-orm": { eq: (c, v) => ({ eq: [c, v] }) },
    "@workspace/db": { usersTable: { email: "email", username: "username", telegramChatId: "tg", id: "id", role: "role" }, db: { select: (cols) => ({ from: () => ({ where: (c) => { S.out.push(["select", norm(Object.keys(cols)), norm(c)]); return modes.dbFail ? Promise.reject(new Error("db down")) : Promise.resolve(users(c)); } }) }) } },
  };
  const sink = (name, failKey) => (...a) => { S.out.push([name, norm(a)]); const f = modes[failKey]; if (f === "sync") throw new Error(`${name} sync fail`); if (f === "reject") return Promise.reject(new Error(`${name} rejected`)); if (typeof f === "function" && f(a)) return Promise.reject(new Error(`${name} rejected`)); return Promise.resolve(); };
  const logger = { warn: (...a) => S.logs.push(["warn", norm(a.map((x) => (x && x.err ? { ...x, err: errMsg(x.err) } : x)))]) };
  const logical = [[/lib\/email$/, { sendEmail: sink("email", "email") }], [/lib\/telegram$/, { sendToUser: sink("telegram", "telegram") }], [/lib\/logger$/, { logger }], [/routes\/notifications$|lib\/create-notification$/, { createNotification: sink("notify", "notify") }]];
  const m = { ...mocks, __logical: logical };
  const resolve = (s, from) => resolveRel(s, from, m);
  const shadow = { Date: FakeDate };
  const mod = side === "old" ? makeLoader(resolve, shadow)(path.join(SRC, "lib/__old__vault-backup-alerts.ts"), BASE("alerts")) : makeLoader(resolve, shadow)(path.join(SRC, "vault/infrastructure/backup/alerts.ts"), newText);
  return { S, mod };
}
const U1 = { email: "u@x.test", username: "uname", telegramChatId: "tg1" }, U2 = { email: "v@x.test", username: "<v>", telegramChatId: null }, U3 = { email: null, username: "noemail", telegramChatId: "tg3" };
const ADMINS = [{ email: "a1@x" }, { email: "a2@x" }, { email: "a3@x" }];
const alertScenarios = [];
const AL = (name, users, modes, fn) => alertScenarios.push({ name, users, modes, fn });
const one = (u) => () => (u ? [u] : []);
for (const [dl, u] of [["full user", U1], ["no telegram", U2], ["no email", U3], ["no user", null]]) {
  for (const ev of ["snapshot_downloaded", "snapshot_restored"]) AL(`anomalous access ${ev} / ${dl}`, one(u), {}, (m) => m.alertOwnerOfAnomalousBackupAccess(5, ev, "203.0.113.9"));
  AL(`scheduled ok / ${dl}`, one(u), {}, async (m) => { await m.alertUserOfScheduledBackupResult(5, { ok: true, snapshotId: 12, entriesCount: 7, walletsCount: 2, destination: "store" }); await m.alertUserOfScheduledBackupResult(5, { ok: true }); });
  AL(`scheduled failed / ${dl}`, one(u), {}, async (m) => { await m.alertUserOfScheduledBackupResult(5, { ok: false, error: "disk full" }); await m.alertUserOfScheduledBackupResult(5, { ok: false }); });
  for (const mins of [5, 59, 60, 95, 200]) AL(`missed ${mins} / ${dl}`, one(u), {}, (m) => m.alertUserOfMissedBackup(5, mins));
}
AL("anomalous email fails", one(U1), { email: "reject" }, (m) => m.alertOwnerOfAnomalousBackupAccess(5, "snapshot_restored", "1.1.1.1"));
AL("anomalous email throws sync", one(U1), { email: "sync" }, (m) => m.alertOwnerOfAnomalousBackupAccess(5, "snapshot_restored", "1.1.1.1"));
AL("anomalous db fails", one(U1), { dbFail: true }, (m) => m.alertOwnerOfAnomalousBackupAccess(5, "snapshot_restored", "1.1.1.1"));
for (const [n, mo] of [["notify rejects", { notify: "reject" }], ["telegram rejects", { telegram: "reject" }], ["email rejects", { email: "reject" }], ["notify throws sync", { notify: "sync" }], ["telegram throws sync", { telegram: "sync" }], ["email throws sync", { email: "sync" }], ["db fails", { dbFail: true }]]) {
  AL(`scheduled ok / ${n}`, one(U1), mo, (m) => m.alertUserOfScheduledBackupResult(5, { ok: true, entriesCount: 1 }));
  AL(`scheduled failed / ${n}`, one(U1), mo, (m) => m.alertUserOfScheduledBackupResult(5, { ok: false, error: "x" }));
  AL(`missed / ${n}`, one(U1), mo, (m) => m.alertUserOfMissedBackup(5, 120));
}
AL("stale key: 3 admins", () => ADMINS, {}, (m) => m.alertAdminsOfStaleKeyRotation(4, 12, "kms timeout"));
AL("stale key: no admins", () => [], {}, (m) => m.alertAdminsOfStaleKeyRotation(4, 12, "x"));
AL("stale key: one bounce doesn't block rest", () => ADMINS, { email: (a) => a[0].to === "a1@x" }, (m) => m.alertAdminsOfStaleKeyRotation(2, 3, "e"));
AL("stale key: all bounce", () => ADMINS, { email: "reject" }, (m) => m.alertAdminsOfStaleKeyRotation(2, 3, "e"));
AL("stale key: db fails (propagates)", () => ADMINS, { dbFail: true }, (m) => m.alertAdminsOfStaleKeyRotation(2, 3, "e"));

async function runAlertScenario(sc, side, newText) {
  const rt = alertsRuntime(side, newText, sc.users, sc.modes);
  const r = await attempt(() => sc.fn(rt.mod));
  await new Promise((res) => setImmediate(res)); // let fire-and-forget .catch(() => {}) chains settle
  return norm({ r, out: rt.S.out, logs: rt.S.logs });
}

// ───────────────────────── run + compare ─────────────────────────
const NEWTEXT = {
  envelope: fs.readFileSync(path.join(SRC, "vault/crypto/backup-envelope.ts"), "utf8"),
  cloud: fs.readFileSync(path.join(SRC, "vault/infrastructure/backup/cloud.ts"), "utf8"),
  alerts: fs.readFileSync(path.join(SRC, "vault/infrastructure/backup/alerts.ts"), "utf8"),
};
const eq = (a, b) => json(a) === json(b);

async function runAll(nt) {
  const cells = [];
  const add = (group, name, equal, detail) => cells.push({ group, name, equal, ...(equal ? {} : { detail }) });
  for (const sc of envScenarios) {
    const [o, n] = [await runEnvScenario(sc, "old", nt.envelope), await runEnvScenario(sc, "new", nt.envelope)];
    add("envelope", sc.name, eq(o.trace, n.trace) && eq(o.sql, n.sql) && eq(o.keys, n.keys), { old: o, new: n });
  }
  for (const c of await crossCells(nt.envelope)) add("envelope-cross", c.name, eq(c.got, c.want), { got: c.got, want: c.want });
  for (const sc of cloudScenarios) {
    const [o, n] = [await runCloudScenario(sc, "old", nt.cloud), await runCloudScenario(sc, "new", nt.cloud)];
    add("cloud", sc.name, eq(o, n), { old: o, new: n });
  }
  for (const c of await cloudIntentionalCells(nt.cloud)) add("cloud-intentional", c.name, c.ok, c.detail);
  for (const sc of alertScenarios) {
    const [o, n] = [await runAlertScenario(sc, "old", nt.alerts), await runAlertScenario(sc, "new", nt.alerts)];
    add("alerts", sc.name, eq(o, n), { old: o, new: n });
  }
  return cells;
}

const base = await runAll(NEWTEXT);
const bad = base.filter((c) => !c.equal);
// determinism: second run must reproduce identical cell outcomes
const again = await runAll(NEWTEXT);
const nondet = base.filter((c, i) => c.equal !== again[i].equal).length;

// sensitivity: each mutant edits the NEW source only and must flip at least one cell
const MUTANTS = [
  ["envelope", "encrypt without AAD", (t) => t.replace('encryptAes256Gcm(dek, plaintext, backupAad(version, ownerUserId))', 'encryptAes256Gcm(dek, plaintext)')],
  ["envelope", "drop legacy KEK fallback on unwrap", (t) => t.replace("return unwrapDekWith(wrapped, getLegacyKek());", "throw new Error('no fallback');")],
  ["envelope", "encrypt writes ENV1 prefix", (t) => t.replace("[PREFIX_V2, version,", "[PREFIX, version,")],
  ["envelope", "rotate forgets to deactivate old key", (t) => t.replace("await getBackupEnvelopeKeyStore().deactivateKeys(NAMESPACE);", "")],
  ["envelope", "decrypt ignores ENV2 AAD", (t) => t.replace("prefix === PREFIX_V2 ? backupAad(version, ownerUserId) : undefined", "undefined")],
  ["cloud", "refresh window 60s -> 30s", (t) => t.replace("> 60_000", "> 30_000")],
  ["cloud", "re-auth overwrites refresh token with null", (t) => t.replace("(existing?.refreshToken ?? null)", "null")],
  ["cloud", "dropbox path changed", (t) => t.replace('"/AYZEN Vault Backups"', '"/AYZEN Backups"')],
  ["cloud", "dropbox upload mode changed", (t) => t.replace('mode: "overwrite"', 'mode: "update"')],
  ["cloud", "dropbox upload adds an auto-renamed copy again", (t) => t.replace('mode: "overwrite", autorename: false', 'mode: "add", autorename: true')],
  ["cloud", "drive upload no longer skips an existing file", (t) => t.replace("existingData.files.length > 0) return;", "existingData.files.length > 99) return;")],
  ["cloud", "disconnect swallows db error", (t) => t.replace("logger.warn({ err }, \"Failed to delete vault_backup_cloud_connections row\"); throw err;", "logger.warn({ err }, \"Failed to delete vault_backup_cloud_connections row\");")],
  ["alerts", "failure alert drops telegram", (t) => t.replace('"⚠️ *Automatic Vault Backup Failed*",', '"⚠️ *Automatic Vault Backup Failed*", "".trim(),').replace(/(const message = `Your scheduled backup attempted[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\n\s*)if \(user\.telegramChatId\) \{/, "$1if (false) {")],
  ["alerts", "stale-key loop stops at first admin", (t) => t.replace("for (const admin of admins) {", "for (const admin of admins.slice(0, 1)) {")],
  ["alerts", "anomalous alert verbs swapped", (t) => t.replace('eventType === "snapshot_downloaded" ? "downloaded" : "restored"', 'eventType === "snapshot_downloaded" ? "restored" : "downloaded"')],
  ["alerts", "missed alert rounds hours down", (t) => t.replace("Math.round(missedSinceMinutes / 60)", "Math.floor(missedSinceMinutes / 60)")],
];
const probes = [];
for (const [g, name, fn] of MUTANTS) {
  const key = g;
  const mutated = fn(NEWTEXT[key]);
  const applied = mutated !== NEWTEXT[key];
  let detected = 0;
  if (applied) { const cells = await runAll({ ...NEWTEXT, [key]: mutated }); detected = cells.filter((c) => !c.equal).length; }
  probes.push({ group: g, mutation: name, applied, detected_cells: detected });
}

const byGroup = {}; for (const c of base) { const g = (byGroup[c.group] ??= { cells: 0, equal: 0 }); g.cells++; if (c.equal) g.equal++; }
const errors = [];
if (bad.length) errors.push(`${bad.length} old-vs-new cell(s) differ: ${bad.slice(0, 5).map((c) => `${c.group}/${c.name}`).join("; ")}`);
if (nondet) errors.push(`${nondet} non-deterministic cell(s)`);
for (const p of probes) if (!p.applied || !p.detected_cells) errors.push(`mutant not caught: ${p.group}/${p.mutation}${p.applied ? "" : " (did not apply)"}`);
if (base.length < 100) errors.push(`only ${base.length} cells`);

const OUT = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-15");
fs.mkdirSync(OUT, { recursive: true });
const ev = { gap: "VLT-GAP-15", sub: "module-differential-backup", checked_at: new Date().toISOString(), modules: ["vault/crypto/backup-envelope", "vault/infrastructure/backup/cloud", "vault/infrastructure/backup/alerts"],
  old_sources: ["lib/vault-backup-envelope", "lib/vault-backup-cloud", "lib/vault-backup-alerts"].map((n) => `VLT-GAP-08 baseline ${n}`),
  real_not_faked: ["node:crypto", "packages/vault-crypto aes-gcm", "NEW key-store port + repository SQL (via crypto-key-stores)", "module bodies on both sides"],
  faked: ["encryption_keys table (interprets the exact SQL)", "fetch (scripted, every request recorded)", "connection/users tables", "email/telegram/notification sinks", "clock", "field-encryption & jwt in cloud (covered by their own gaps)"],
  cells: base.length, equal_cells: base.filter((c) => c.equal).length, groups: byGroup, mutants: probes, errors, status: errors.length ? "FAIL" : "PASS" };
fs.writeFileSync(path.join(OUT, "module-differential-backup.json"), JSON.stringify(ev, null, 2) + "\n");
if (errors.length) { for (const e of errors) console.error(`  - ${e}`); if (process.env.DIFF_DEBUG && bad[0]) console.error(JSON.stringify(bad[0], null, 1).slice(0, 4000)); console.error("differential-vlt-gap-15-backup FAIL"); process.exit(1); }
console.log(`differential-vlt-gap-15-backup PASS -- ${ev.equal_cells}/${ev.cells} cells equal (${Object.entries(byGroup).map(([g, v]) => `${g}:${v.equal}`).join(", ")}), ${probes.filter((p) => p.detected_cells).length}/${probes.length} mutants caught`);
