#!/usr/bin/env node
// VLT-GAP-12 differential: the sealed pre-extraction sources (12 census baseline) vs the extracted infrastructure/domain owners,
// executed against the same scripted I/O. Covered: all snapshot section readers + re-encryptors (sections.ts → snapshot-sections-repository),
// the 15 snapshot-restore persistence helpers + identity keys (restore.ts → snapshot-restore-repository / domain/snapshot-restore-keys),
// findVaultEntryByReceiptToken, hasVaultPin, selectKycEntryOwnerRow. Every SQL text + bound parameter, Drizzle call shape, return value and
// error must match; mutated copies of the new owners must be caught.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { ROOT, rejectBypass } from "./gap-common.mjs";
const bypass = rejectBypass();
if (bypass.length) { console.error(`differential FAIL — bypass rejected: ${bypass.join(", ")}`); process.exit(1); }
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const SRC = ROOT + "/artifacts/api-server/src", V = `${SRC}/vault`, REPOS = `${V}/infrastructure/repositories`;
const BASE_DIR = `${ROOT}/reports/antas/vault/gap/VLT-GAP-12/baseline/sources/`;
const bsrc = (p) => fs.readFileSync(BASE_DIR + p.replace(/[^a-zA-Z0-9]+/g, "__"), "utf8");
const B = { sections: bsrc(`artifacts/api-server/src/vault/application/snapshot/sections.ts`), restore: bsrc(`artifacts/api-server/src/vault/application/snapshot/restore.ts`),
  receipt: bsrc(`artifacts/api-server/src/vault/application/entity/receipt.ts`), pin: bsrc(`artifacts/api-server/src/vault/security/pin-guard.ts`), kyc: bsrc(`artifacts/api-server/src/vault/security/kyc-ownership.ts`) };
const N = { sections: fs.readFileSync(`${REPOS}/snapshot-sections-repository.ts`, "utf8"), restore: fs.readFileSync(`${REPOS}/snapshot-restore-repository.ts`, "utf8"),
  entity: fs.readFileSync(`${REPOS}/entity-repository.ts`, "utf8"), security: fs.readFileSync(`${REPOS}/vault-security-repository.ts`, "utf8"), kyc: fs.readFileSync(`${REPOS}/kyc-repository.ts`, "utf8"),
  keys: fs.readFileSync(`${V}/domain/snapshot-restore-keys.ts`, "utf8") };
const NOW = 1_700_000_000_000;
{ const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }; }

function lift(text, name) {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true);
  let out = null;
  sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) out = n.getText(sf); });
  assert(out, `baseline ${name} not found`);
  return "export " + out.replace(/^export\s+/, "");
}
const DB_HEADER = `import { db, vaultEntriesTable, usersTable, vaultSecurityTable } from "@workspace/db";\nimport { eq, and, sql } from "drizzle-orm";\n`;
const BASE_RECEIPT = DB_HEADER + lift(B.receipt, "findVaultEntryByReceiptToken");
const BASE_PIN = DB_HEADER + lift(B.pin, "hasVaultPin");
const BASE_KYC = DB_HEADER + lift(B.kyc, "selectKycEntryOwnerRow");
const RESTORE_HELPERS = ["existingVaultKeys", "insertVaultRow", "existingWalletKeys", "insertWalletRow", "existingRawKeys", "insertRawRow", "existingTemplateKeys", "insertTemplateRow", "existingMessageKeys", "insertMessageRow", "existingDataEntityKeys", "insertDataEntityRow", "existingEmailAccountKeys", "insertEmailAccountRow"];
const BASE_RESTORE = B.restore + `\nexport { ${RESTORE_HELPERS.join(", ")}, norm, vaultKey, walletKey, rawRowKey, dataEntityKey, emailAccountKey, MESSAGE_INSERT_COLS, DATA_ENTITY_INSERT_COLS, EMAIL_ACCOUNT_INSERT_COLS };\n`;

// ── runtime with scripted I/O ────────────────────────────────────────────────
function render(x) {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(render);
  if (x.k === "sql") return { sql: x.s.reduce((a, s, i) => a + s + (i < x.v.length ? `\u0001${i}` : ""), ""), params: x.v.map(render) };
  if (x.k === "raw") return { raw: x.s };
  if (x.k === "join") return { join: render(x.arr), sep: render(x.sep) };
  if (x.t && x.c) return `${x.t}.${x.c}`;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, render(v)]));
}
const sqlTag = (s, ...v) => ({ k: "sql", s: [...s], v });
sqlTag.raw = (s) => ({ k: "raw", s });
sqlTag.join = (arr, sep) => ({ k: "join", arr, sep });
function makeRuntime(S, sectionsText) {
  const log = S.log = [];
  const rec = (...a) => log.push(JSON.parse(JSON.stringify(render(a))));
  const tbl = (n) => new Proxy({ __t: n }, { get: (t, p) => (p === "__t" ? n : { t: n, c: String(p) }) });
  const mkHandle = (label) => {
    const chain = (kind) => { const op = { kind, label };
      const o = { from: (t) => { op.table = t.__t; return o; }, innerJoin: () => o, where: (w) => { op.where = w; return o; }, limit: (n) => { op.limit = n; return o; }, orderBy: () => o, values: (v) => { op.values = v; return o; },
        then: (r, j) => { try { rec("db", op); if (S.failOn?.includes(op.table) || (kind === "insert" && S.failInsert)) throw new Error("db failed"); return Promise.resolve(kind === "select" ? (S.selectRows?.[op.table] ?? []) : []).then(r, j); } catch (e) { return Promise.reject(e).then(r, j); } } };
      return o; };
    return { select: (cols) => { const o = chain("select"); o.cols = cols ? Object.keys(cols) : null; return o; }, insert: (t) => { const o = chain("insert"); o.table = t.__t; return o; },
      execute: async (q) => { const r = render(q); rec("execute", label, r); if (S.failExec) throw new Error("exec failed"); return { rows: S.execRows(typeof r === "string" ? r : r.sql ?? r.raw ?? "", r) }; } };
  };
  const dbMod = new Proxy({}, { get: (t, p) => (p === "db" ? mkHandle("db") : tbl(String(p))) });
  S.mkHandle = mkHandle;
  const mocks = { "drizzle-orm": { sql: sqlTag, and: (...a) => ["and", ...a.map(render)], eq: (c, v) => ["eq", render(c), render(v)] }, "@workspace/db": dbMod,
    fieldEnc: { encryptField: (s) => `enc:${s}`, decryptField: (s) => (typeof s === "string" ? s.replace(/^enc:/, "") : s) },
    serial: { generateSerial: (u) => `SER${u}` }, walletCrypto: { encryptPhrase: (p) => `wc:${p}` } };
  const cache = new Map();
  const find = (spec, from) => {
    if (!spec.startsWith(".")) return { mock: mocks[spec] ?? (() => { throw new Error(`unmocked package ${spec}`); })() };
    if (/crypto\/field-encryption$/.test(spec)) return { mock: mocks.fieldEnc };
    if (/domain\/serial$/.test(spec)) return { mock: mocks.serial };
    if (/lib\/wallet-crypto$/.test(spec)) return { mock: mocks.walletCrypto };
    if (/domain\/secret-fields$/.test(spec)) return { file: `${V}/domain/secret-fields.ts` };
    if (/domain\/snapshot-restore-keys$/.test(spec)) return { file: `${V}/domain/snapshot-restore-keys.ts` };
    if (/\.\/sections$|snapshot-sections-repository$/.test(spec)) return { file: `${V}/application/snapshot/sections.ts`, text: sectionsText };
    throw new Error(`unresolved ${spec} from ${from}`);
  };
  const load = (file, text) => {
    const key = file + "#" + (text?.length ?? "f");
    if (cache.has(key)) return cache.get(key).exports;
    const code = ts.transpileModule(text ?? fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const m = { exports: {} }; cache.set(key, m);
    new Function("require", "module", "exports", "__filename", code)((s) => { const r = find(s, file); return r.mock ?? load(r.file, r.text); }, m, m.exports, file);
    return m.exports;
  };
  return { load };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const ser = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Set ? { set: [...x].sort() } : x)));
async function exec(S, fn) { try { return { value: ser(await fn()) }; } catch (e) { return { error: String(e.message ?? e) }; } }

// generic row synthesizer for `SELECT ... FROM <table>` section reads
const FIELDS = { id: 1, user_id: 7, name: "n", title: "t", status: "active", amount: "5", created_at: "2026-01-01T00:00:00.000Z", encrypted_content: "enc:abc", encrypted_password: "enc:pw", encrypted_body: "enc:b", text_body: "enc:tb", html_body: "enc:hb", subject: "enc:s", password: "enc:p", secret: "enc:sec", encrypted_secret: "enc:es", token: "enc:t", message_id: "m1", direction: "in", folder: "inbox", email_address: "a@x", protocol: "imap", vault_pin_hash: "h", backup_codes: "[]", birth_date: "b", nid_number: "enc:nid", father_name: "f" };
const synth = (sqlText) => { const m = /FROM\s+([a-z_]+)/i.exec(sqlText); const t = m ? m[1] : "x"; return [0, 1].map((i) => ({ ...FIELDS, id: i + 1, tbl: t })); };
const baseScript = () => ({ execRows: (s) => synth(s) });

// ── comparison cases ─────────────────────────────────────────────────────────
const NEW = () => ({ sections: ["virtual", N.sections], restore: ["virtual", N.restore] });
async function runSections(sectionsText, name, scenario) {
  const S = { ...baseScript(), ...scenario }; const rt = makeRuntime(S, sectionsText);
  const mod = rt.load(`${V}/application/snapshot/sections.ts`, sectionsText);
  const out = {};
  for (const fn of Object.keys(mod).sort()) {
    if (typeof mod[fn] !== "function") continue;
    const before = S.log.length;
    const args = /^gather/.test(fn) ? [[7, true], [7, false]] : [[clone({ ...FIELDS, name: "t", body_html: "enc:bh", config: { a: 1 } })], [{}]];
    out[fn] = [];
    for (const a of args) out[fn].push(await exec(S, () => mod[fn](...a)));
    out[fn + ":ops"] = S.log.slice(before);
  }
  return out;
}
async function runRestore(text, sectionsText, scenario, mockFrom) {
  const S = { ...baseScript(), ...scenario }; const rt = makeRuntime(S, sectionsText);
  const mod = rt.load(mockFrom, text);
  const alt = S.mkHandle("alt");
  const out = {};
  const plan = { table: "mailboxRules", sqlTable: "ayzen_mailbox_rules", label: "L", keyColumns: ["name"], displayColumns: ["name"], excludeOnInsert: ["id", "secret"] };
  const entry = { id: 5, userId: 99, name: "Ab", projectName: "Proj", password: "pw", seedPhrase: "word word", encryptedPhrase: "x", createdAt: "c", twitterPassword: "tp", nullField: null, folder: "weird", subject: "enc:s", is_default: true, email_address: "a@x", protocol: "imap", secret: "s", extra: undefined };
  const calls = {
    existingVaultKeys: [[7], [7, alt]], existingWalletKeys: [[7], [7, alt]], existingRawKeys: [["ayzen_mailbox_rules", ["name", "b"], 7], ["t", ["x"], "7abc", alt]],
    existingTemplateKeys: [[7], [7, alt]], existingMessageKeys: [[7], [7, alt]], existingDataEntityKeys: [[7], [7, alt]], existingEmailAccountKeys: [[7], [7, alt]],
  };
  for (const [fn, argSets] of Object.entries(calls)) { out[fn] = []; for (const a of argSets) { const before = S.log.length; out[fn].push([await exec(S, () => mod[fn](...a)), S.log.slice(before)]); } }
  const h = S.mkHandle("tx");
  const ins = { insertVaultRow: [[h, 7, entry], [h, 7, { ...entry, projectName: null }]], insertWalletRow: [[h, 7, entry], [h, 7, { ...entry, seedPhrase: "" }]], insertRawRow: [[h, plan, 7, { ...entry, undef: undefined }]],
    insertTemplateRow: [[h, 7, entry]], insertMessageRow: [[h, 7, entry], [h, 7, { ...entry, folder: "archive" }]], insertDataEntityRow: [[h, 7, entry]], insertEmailAccountRow: [[h, 7, entry]] };
  for (const [fn, argSets] of Object.entries(ins)) { out[fn] = []; for (const a of argSets) { const before = S.log.length; out[fn].push([await exec(S, () => mod[fn](...a)), S.log.slice(before)]); } }
  return out;
}
async function runSingles(texts, scenario) {
  const out = {};
  for (const [name, [text, fnName, args]] of Object.entries(texts)) {
    const S = { ...baseScript(), ...scenario }; const rt = makeRuntime(S, null);
    const mod = rt.load(`${V}/x-${name}.ts`, text);
    out[name] = [await exec(S, () => mod[fnName](...args)), S.log];
  }
  return out;
}
const SINGLE_SCENARIOS = {
  found: { selectRows: { vaultEntriesTable: [{ id: 1, userId: 3, receiptToken: "tok" }], usersTable: [{ username: "alice" }], vaultSecurityTable: [{ vaultPinHash: "hash" }] }, execRows: () => [{ user_id: 42 }] },
  noOwner: { selectRows: { vaultEntriesTable: [{ id: 1, userId: 3 }], usersTable: [], vaultSecurityTable: [{ vaultPinHash: null }] }, execRows: () => [] },
  empty: { selectRows: {}, execRows: () => [] },
  dbDown: { selectRows: { vaultEntriesTable: [{ id: 1 }] }, failOn: ["vaultEntriesTable", "vaultSecurityTable"], failExec: true, execRows: () => [] },
};
const singlesBase = () => ({ receipt: [BASE_RECEIPT, "findVaultEntryByReceiptToken", ["tok"]], pin: [BASE_PIN, "hasVaultPin", [7]], kyc: [BASE_KYC, "selectKycEntryOwnerRow", [5]] });
const singlesNew = (n = N) => ({ receipt: [DB_HEADER + lift(n.entity, "findVaultEntryByReceiptToken"), "findVaultEntryByReceiptToken", ["tok"]], pin: [DB_HEADER + lift(n.security, "hasVaultPin"), "hasVaultPin", [7]], kyc: [DB_HEADER + lift(n.kyc, "selectKycEntryOwnerRow"), "selectKycEntryOwnerRow", [5]] });
const SCEN = {
  default: {},
  rowsEmpty: { execRows: () => [], selectRows: {} },
  dbFailures: { failExec: true, failOn: ["vaultEntriesTable", "walletsTable"], failInsert: true },
  vaultRows: { selectRows: { vaultEntriesTable: [{ projectName: " Alpha " }, { projectName: null }, { projectName: "alpha" }], walletsTable: [{ chain: "eth", address: "0xA" }, { chain: null, address: null }] } },
};

let comparisons = 0, nonVacuous = 0;
const cmp = (label, a, b) => { assert.deepStrictEqual(b, a, `${label} diverged`); comparisons++; };
for (const [sn, sc] of Object.entries(SCEN)) {
  const a = await runSections(B.sections, "b", sc), b = await runSections(N.sections, "n", sc);
  cmp(`sections:${sn}`, a, b);
  if (sn === "default") { const ok = Object.entries(a).filter(([k, v]) => /^gather/.test(k) && v.every((r) => r.value)).length; assert(ok >= 12, `only ${ok} gather fns ran successfully`); nonVacuous += ok; assert(Object.keys(a).filter((k) => /^gather/.test(k) && !k.endsWith(":ops")).length === 16, "expected 16 gather fns"); }
  const ra = await runRestore(BASE_RESTORE, B.sections, sc, `${V}/application/snapshot/restore.ts`);
  const rb = await runRestore(N.restore, N.sections, sc, `${REPOS}/snapshot-restore-repository.ts`);
  // the new repository does not export the pure keys (they live in domain); compare them from the domain file separately
  cmp(`restore:${sn}`, ra, rb);
  if (sn === "default") assert(ra.insertWalletRow[0][1].some((l) => JSON.stringify(l).includes("wc:")) && ra.insertVaultRow[0][1].some((l) => JSON.stringify(l).includes("enc:")), "restore inserts must exercise re-encryption");
}
{ // identity keys: baseline restore.ts internals vs the domain module
  const rtB = makeRuntime({ ...baseScript() }, B.sections), rtN = makeRuntime({ ...baseScript() }, N.sections);
  const mb = rtB.load(`${V}/application/snapshot/restore.ts`, BASE_RESTORE), mn = rtN.load(`${V}/domain/snapshot-restore-keys.ts`, N.keys);
  const probes = [["norm", ["  Ab "]], ["norm", [null]], ["norm", [12]], ["vaultKey", [{ projectName: " P " }]], ["vaultKey", [{}]], ["walletKey", [{ chain: "ETH", address: "0xA" }]], ["walletKey", [{ chain: null }]], ["rawRowKey", [{ a: " X ", b: null }, ["a", "b"]]], ["dataEntityKey", [{ name: "N", father_name: null, birth_date: "b" }]], ["emailAccountKey", [{ email_address: "A@X", protocol: null }]]];
  for (const [fn, args] of probes) cmp(`keys:${fn}`, ser(mb[fn](...clone(args))), ser(mn[fn](...clone(args))));
  assert.deepStrictEqual(mb.MESSAGE_INSERT_COLS, mn.MESSAGE_INSERT_COLS); assert.deepStrictEqual(mb.DATA_ENTITY_INSERT_COLS, mn.DATA_ENTITY_INSERT_COLS); assert.deepStrictEqual(mb.EMAIL_ACCOUNT_INSERT_COLS, mn.EMAIL_ACCOUNT_INSERT_COLS); comparisons += 3;
}
for (const [sn, sc] of Object.entries(SINGLE_SCENARIOS)) cmp(`singles:${sn}`, await runSingles(singlesBase(), sc), await runSingles(singlesNew(), sc));

// ── self-test: mutated owners must be caught ─────────────────────────────────
const MUT = [
  ["sections:table", "sections", (t) => t.replace("FROM ayzen_mailbox_labels", "FROM ayzen_mailbox_label")],
  ["sections:limit", "sections", (t) => t.replace("LIMIT ${TEAM_ACTIVITY_LIMIT}", "LIMIT 1")],
  ["sections:param", "sections", (t) => t.replace("WHERE owner_id = ${userId}", "WHERE owner_id = ${userId + 1}")],
  ["restore:folder", "restore", (t) => t.replace(`? row.folder : "inbox"`, `? row.folder : "sent"`)],
  ["restore:is_default", "restore", (t) => t.replace("is_default: false", "is_default: true")],
  ["restore:sensitive", "restore", (t) => t.replace("SENSITIVE_VAULT_FIELDS.has(key) ? encryptField(String(value)) : value", "value")],
  ["restore:raw-exclude", "restore", (t) => t.replace("!plan.excludeOnInsert.includes(c) && ", "")],
  ["receipt:owner", "entity", (t) => t.replace("owner?.username ?? null", `owner?.username ?? ""`)],
  ["pin:bool", "security", (t) => t.replace("return !!row?.vaultPinHash;", "return row?.vaultPinHash as any;")],
  ["kyc:row", "kyc", (t) => t.replace("return result.rows[0] as any;", "return result.rows[1] as any;")],
];
let caught = 0;
for (const [label, key, mutate] of MUT) {
  const mutated = mutate(N[key]);
  assert.notStrictEqual(mutated, N[key], `mutant ${label} did not change the source`);
  let diverged = false;
  try {
    if (key === "sections") { for (const [sn, sc] of Object.entries(SCEN)) assert.deepStrictEqual(await runSections(mutated, "m", sc), await runSections(B.sections, "b", sc)); }
    else if (key === "restore") { for (const [, sc] of Object.entries(SCEN)) { const a = await runRestore(BASE_RESTORE, B.sections, sc, `${V}/application/snapshot/restore.ts`), b = await runRestore(mutated, N.sections, sc, `${REPOS}/snapshot-restore-repository.ts`); assert.deepStrictEqual(b, a); } }
    else { for (const sc of Object.values(SINGLE_SCENARIOS)) assert.deepStrictEqual(await runSingles(singlesNew({ ...N, [key]: mutated }), sc), await runSingles(singlesBase(), sc)); }
  } catch { diverged = true; }
  assert(diverged, `differential failed to catch mutant ${label}`);
  caught++;
}
console.log(`VLT-GAP-12 differential PASS — ${comparisons} executed comparisons (16 section readers + re-encryptors, 14 restore helpers, 10 identity probes, 3 lookups; ${nonVacuous} gather runs returned data), ${caught}/${MUT.length} mutants caught`);
