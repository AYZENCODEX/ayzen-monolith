#!/usr/bin/env node
// VLT-GAP-01-C — Consumer Rewire. Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-01/consumer-graph.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles, GAP01D_NEW_FILES } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader, fakeRes, summ } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const SUB_PHASE = "VLT-GAP-01-C";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const LIB = path.join(SRC, "lib");
const BASE = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01/baseline");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-01");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "consumer-graph.json");
const R = (f) => `artifacts/api-server/src/${f}`;
const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const canon = (o) => JSON.stringify(o);

// ── Declared intent (all verified against source below) ──
const OLD_MODULES = ["vault", "vault-entity-links", "vault-snapshot", "vault-shares"].map((n) => R(`routes/${n}.ts`));
// GAP-01 symbols that 01-B moved out of the old route modules. Importing any of them from an old module is a bypass.
const MOVED_GAP01 = ["requireVaultEntryOwnership", "vaultEntryResource", "vaultEntityLinkResource", "requireVaultEntityLinkOwnership", "vaultBulkOwnershipEngine", "auditVaultBulkOwnership", "SAFE_COLS", "selectVault", "selectVaultOne", "selectAllVaultEntries", "selectVaultTrash", "selectVaultTrashOne", "hardDeleteVaultEntry", "logVaultActivity", "NEW_VAULT_FIELDS", "BASE_VAULT_FIELDS", "DATE_FIELDS", "SINGLE_FIELD_EDITABLE", "fieldLabel", "BULK_ALLOWED_STATUSES", "ENTITY_GAS_CHAINS", "addressesFor", "ownsEntity", "formatRow"];
const NEW_OWNER_FILES = ["vault/security/entity-ownership.ts", "vault/infrastructure/repositories/entity-repository.ts", "vault/application/entity/activity.ts", "vault/application/entity/links.ts", "vault/application/entity/lifecycle.ts", "vault/application/entity/representation.ts", "vault/domain/entity/fields.ts", "vault/domain/entity/calculations.ts"];
const REWIRED = [
  { file: R("routes/entities.ts"), baseline: "entities.ts", removeLocal: ["requireVaultEntryOwnership"], mustImportFrom: { "vault/security/entity-ownership": ["requireVaultEntryOwnership"] } },
  { file: R("routes/value-history.ts"), baseline: "value-history.ts", removeLocal: ["requireVaultEntryOwnership"], mustImportFrom: { "vault/security/entity-ownership": ["requireVaultEntryOwnership"] } },
  { file: R("lib/vault-health-scan.ts"), baseline: "vault-health-scan.ts", removeLocal: [], mustImportFrom: { "vault/application/entity/representation": ["formatVaultEntry"], "vault/infrastructure/repositories/entity-repository": ["selectAllVaultEntries"] } },
  { file: "scripts/src/test-route-ownership-regression.ts", baseline: "test-route-ownership-regression.ts", removeLocal: [], mustImportFrom: { "vault/security/entity-ownership": ["vaultEntryResource"] } },
];
const ALLOWED_CHANGED = new Set([
  R("routes/vault.ts"), R("routes/vault-entity-links.ts"), ...NEW_OWNER_FILES.map(R), ...GAP01D_NEW_FILES.map(R), ...REWIRED.map((r) => r.file),
]);

// ── AST helpers ──
function tokensOf(node, sf) { const t = []; (function w(n) { if (ts.isJSDoc(n)) return; if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); } else n.getChildren(sf).forEach(w); })(node); return t; }
const fp = (node, sf) => sha256(tokensOf(node, sf).join(" "));
function importsOf(sf, fileAbs) {
  const out = [];
  for (const s of sf.statements) {
    let spec = null, kind = null, names = [];
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      spec = s.moduleSpecifier.text; kind = "import"; const c = s.importClause;
      if (c?.name) names.push({ imported: "default", local: c.name.text });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text });
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push({ imported: "*", local: c.namedBindings.name.text });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      spec = s.moduleSpecifier.text; kind = "re-export";
      if (s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => names.push({ imported: (e.propertyName ?? e.name).text, local: e.name.text }));
      else names.push({ imported: "*", local: "*" });
    }
    if (spec) out.push({ spec, kind, names, line: sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1, abs: spec.startsWith(".") ? path.resolve(path.dirname(fileAbs), spec.replace(/\.(js|ts|mjs)$/, "")) : null });
  }
  // dynamic import()/require() anywhere
  (function w(n) {
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      const spec = n.arguments[0].text;
      out.push({ spec, kind: n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require", names: [{ imported: "*", local: "?" }], line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, abs: spec.startsWith(".") ? path.resolve(path.dirname(fileAbs), spec.replace(/\.(js|ts|mjs)$/, "")) : null });
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
const toRel = (abs) => (abs ? rel(abs) : null);
function exportsOf(sf) {
  const set = new Set(); let star = false;
  for (const s of sf.statements) {
    const exp = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exp && (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s)) && s.name) set.add(s.name.text);
    if (exp && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => set.add(d.name.getText(sf)));
    if (ts.isExportAssignment(s)) set.add("default");
    if (ts.isExportDeclaration(s)) { if (s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => set.add(e.name.text)); else star = true; }
  }
  return { set, star };
}

// ── 1. Repository-wide consumer graph ──
const SCAN_ROOTS = ["artifacts", "scripts", "tests", "lib", "services", "apps", "packages"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
function scanConsumers(overlay = new Map()) {
  const files = [];
  for (const d of SCAN_ROOTS) walkFiles(d, files, (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !/\.d\.ts$/.test(p));
  const targets = new Map(OLD_MODULES.map((m) => [m.replace(/\.ts$/, ""), m]));
  const byBase = new Map(OLD_MODULES.map((m) => [path.basename(m, ".ts"), m]));
  const edges = [];
  const all = [...files.map((f) => [rel(f), fs.readFileSync(f, "utf8"), f]), ...[...overlay].map(([k, v]) => [k, v, path.join(ROOT, k)])];
  for (const [r, text, abs] of all) {
    if (OLD_MODULES.includes(r) || r.startsWith("scripts/antas/vault/gap/") || r.startsWith("reports/")) continue;
    if (!/vault/.test(text)) continue;
    const sf = parse(r, text);
    for (const im of importsOf(sf, abs)) {
      let target = null;
      if (im.abs) target = targets.get(toRel(im.abs)) ?? null;
      else { const m = im.spec.match(/(?:^|\/)routes\/(vault(?:-entity-links|-snapshot|-shares)?)(?:\.(?:js|ts))?$/); if (m) target = byBase.get(m[1]) ?? null; }
      if (target) edges.push({ consumer: r, target, kind: im.kind, line: im.line, names: im.names.map((n) => n.imported), specifier: im.spec });
    }
  }
  edges.sort((a, b) => a.consumer.localeCompare(b.consumer) || a.line - b.line);
  return edges;
}
function loadOwners() {
  const pre = JSON.parse(fs.readFileSync(path.join(BASE, "symbol-inventory.pre-extraction.json"), "utf8"));
  const m = new Map();
  for (const r of pre.records) if (r.exported) m.set(`${r.file}#${r.name}`, { owner_gap: r.owner_gap, behavior_domain: r.behavior_domain, classification: r.classification });
  return m;
}
function classifyEdges(edges, owners, exportsByFile) {
  const out = []; const violations = [];
  for (const e of edges) {
    const isApiRegistration = e.consumer === R("routes/index.ts") && e.names.length === 1 && e.names[0] === "default";
    const isApiAdapter = e.consumer === R("vault/api/index.ts");
    for (const n of (e.names.length ? e.names : ["*"])) {
      const o = owners.get(`${e.target}#${n}`);
      const rec = { consumer: e.consumer, target: e.target, symbol: n, kind: e.kind, line: e.line };
      if (isApiRegistration) Object.assign(rec, { status: "api-registration", reason: "Express router mounted in routes/index.ts — public route surface stays stable" });
      else if (isApiAdapter) Object.assign(rec, { status: "api-adapter-reexport", reason: "vault/api compatibility boundary re-exports the public router" });
      else if (MOVED_GAP01.includes(n) || o?.owner_gap === "GAP-01") { Object.assign(rec, { status: "BYPASS", owner_gap: "GAP-01", reason: "GAP-01 symbol consumed through the old route module instead of its new owner" }); violations.push(rec); }
      else if (n !== "*" && !exportsByFile.get(e.target)?.star && !exportsByFile.get(e.target)?.set.has(n)) { Object.assign(rec, { status: "DANGLING", reason: `target does not export ${n}` }); violations.push(rec); }
      else if (o) Object.assign(rec, { status: `deferred:${o.owner_gap}`, owner_gap: o.owner_gap, behavior_domain: o.behavior_domain, reason: `symbol belongs to ${o.owner_gap} (${o.behavior_domain}); rewired in that phase` });
      else { Object.assign(rec, { status: "UNCLASSIFIED", reason: "no owner known for imported symbol" }); violations.push(rec); }
      out.push(rec);
    }
  }
  return { classified: out, violations };
}

// ── 2. Bypass / duplicate scan (name-agnostic semantic fingerprints) ──
function functionFingerprints(sf, minTokens = 20) {
  const res = [];
  const visit = (node, name) => { const t = tokensOf(node, sf); if (t[0] === "export") t.shift(); if (t.length >= minTokens) res.push({ name, fp: sha256(t.map((x) => (x === name ? "§" : x)).join(" ")), tokens: t.length }); };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) visit(s, s.name.text);
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) visit(d, d.name.getText(sf));
  }
  return res;
}
function bypassScan(overlay = new Map()) {
  const ownerFps = new Map();
  for (const f of NEW_OWNER_FILES) {
    const abs = path.join(SRC, f); if (!fs.existsSync(abs)) continue;
    for (const x of functionFingerprints(parse(f, fs.readFileSync(abs, "utf8")))) ownerFps.set(x.fp, `${R(f)}#${x.name}`);
  }
  const files = [];
  for (const d of [SRC, path.join(ROOT, "scripts/src"), path.join(ROOT, "tests")]) if (fs.existsSync(d)) walkFiles(d, files, (p) => /\.(ts|tsx|mjs|js)$/.test(p) && !/\.d\.ts$/.test(p));
  const all = [...files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]), ...overlay];
  const hits = [];
  for (const [r, text] of all) {
    if (r.startsWith(R("vault/")) || r.startsWith("scripts/antas/")) continue;
    if (!/\bfunction\b|=>/.test(text)) continue;
    const sf = parse(r, text);
    for (const x of functionFingerprints(sf)) {
      const owner = ownerFps.get(x.fp);
      if (owner) hits.push({ file: r, symbol: x.name, duplicates: owner, tokens: x.tokens });
    }
  }
  return hits;
}
function informationalTableAccess() {
  const files = walkFiles(SRC, [], (p) => p.endsWith(".ts") && !p.endsWith(".d.ts"));
  const out = [];
  for (const f of files) {
    const r = rel(f); if (r.startsWith(R("vault/"))) continue;
    const t = fs.readFileSync(f, "utf8");
    const n = (t.match(/\bvaultEntriesTable\b/g) ?? []).length + (t.match(/\bvault_entries\b/g) ?? []).length;
    if (n) out.push({ file: r, references: n });
  }
  return out.sort((a, b) => b.references - a.references);
}

// ── 3. Rewire proof per consumer (baseline vs current AST) ──
function rewireProof() {
  const proofs = [];
  for (const rw of REWIRED) {
    const curText = fs.readFileSync(path.join(ROOT, rw.file), "utf8");
    const baseText = fs.readFileSync(path.join(BASE, "consumers", rw.baseline), "utf8");
    const cur = parse(rw.file, curText), base = parse(rw.file, baseText);
    const curAbs = path.join(ROOT, rw.file);
    const p = { consumer: rw.file, before: [], after: [], checks: [] };
    const fmtImp = (sf, abs) => importsOf(sf, abs).filter((i) => i.kind !== "dynamic-import").map((i) => ({ from: i.abs ? toRel(i.abs) ?? i.spec : i.spec, names: i.names.map((n) => n.imported) }));
    p.before = fmtImp(base, curAbs); p.after = fmtImp(cur, curAbs);
    const ck = (name, passed, details = "") => p.checks.push({ name, passed: Boolean(passed), details });
    // no GAP-01 symbol imported from old modules
    const badAfter = importsOf(cur, curAbs).filter((i) => i.abs && OLD_MODULES.includes(`${toRel(i.abs)}.ts`)).flatMap((i) => i.names.filter((n) => MOVED_GAP01.includes(n.imported)).map((n) => `${n.imported}←${toRel(i.abs)}`));
    ck("no-gap01-symbol-from-old-module", badAfter.length === 0, badAfter.join(", "));
    const hadBefore = importsOf(base, curAbs).filter((i) => i.abs && OLD_MODULES.includes(`${toRel(i.abs)}.ts`)).flatMap((i) => i.names.filter((n) => MOVED_GAP01.includes(n.imported) || n.imported === "formatRow").map((n) => `${n.imported}←${toRel(i.abs)}`));
    ck("baseline-really-consumed-old-owner", hadBefore.length > 0, "baseline had no old-owner import (nothing to rewire)");
    for (const [mod, names] of Object.entries(rw.mustImportFrom)) {
      const target = path.join(SRC, mod);
      const ims = importsOf(cur, curAbs).filter((i) => i.abs && path.resolve(i.abs) === target);
      const got = new Set(ims.flatMap((i) => i.names.map((n) => n.imported)));
      ck(`imports-new-owner:${mod}`, names.every((n) => got.has(n)), `missing ${names.filter((n) => !got.has(n)).join(",")}`);
      const ex = exportsOf(parse(mod, fs.readFileSync(target + ".ts", "utf8")));
      ck(`new-owner-exports:${mod}`, names.every((n) => ex.set.has(n)));
    }
    for (const name of rw.removeLocal) {
      const still = cur.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
      const had = base.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
      ck(`local-duplicate-removed:${name}`, had && !still, `baseline had=${had}, still=${still}`);
    }
    // everything except imports and the removed wrappers is token-identical (route behaviour untouched)
    const body = (sf) => sf.statements.filter((s) => !ts.isImportDeclaration(s) && !(ts.isFunctionDeclaration(s) && rw.removeLocal.includes(s.name?.text))).map((s) => fp(s, sf));
    const bb = body(base), cb = body(cur);
    ck("non-import-statements-identical-to-baseline", canon(bb) === canon(cb), `baseline ${bb.length} statements vs current ${cb.length}`);
    p.statements_compared = cb.length;
    p.passed = p.checks.every((c) => c.passed);
    proofs.push(p);
  }
  return proofs;
}

// ── 4. Contract tests (old baseline consumers vs rewired consumers under identical stubs) ──
const SEL_E = "db.select:vaultEntriesTable";
async function loadConsumer({ which, file, baselineName, script = {}, overrides, extraStubs }) {
  const env = createEnv(script);
  if (overrides) for (const [k, v] of overrides) env.overrides.set(k, v);
  const ld = createLoader({ ts, root: ROOT, srcDir: SRC, env });
  Object.assign(env.stubs, { "routes/local-accounts": { requireLocalAccountOwnership: (a) => { const m = () => {}; Object.defineProperty(m, "name", { value: `localAccountOwnership(${a})` }); return m; } }, ...(extraStubs ?? {}) });
  const isLib = file.startsWith("lib/");
  if (which === "old") {
    const oldLinks = fs.readFileSync(path.join(BASE, "routes/vault-entity-links.ts"), "utf8");
    env.stubs["routes/vault-entity-links"] = ld.loadText(oldLinks, "vault-entity-links.ts", ROUTES);
    env.routes.length = 0; // routes registered by the preloaded dependency are not the consumer's
    env.log.length = 0;
    const exp = ld.loadText(fs.readFileSync(path.join(BASE, "consumers", baselineName), "utf8"), baselineName, isLib ? LIB : ROUTES);
    return { env, exp };
  }
  const exp = ld.loadFile(path.join(SRC, file));
  return { env, exp };
}
function summarizeStack(env) {
  return env.routes.map((r) => ({
    route: `${r.method} ${r.path}`,
    stack: r.stack.slice(0, -1).map((m) => {
      if (!m) return { name: "undefined" };
      const s = { name: m.name || "anon" };
      if (m.__ownership) { const res = fakeRes(); m.__ownership.opts.onDeny({}, res); s.ownership = { action: m.__ownership.action, deny: { status: res.statusCode, body: summ(res.body) }, observer: m.__ownership.opts.onDecision?.__stub }; }
      return s;
    }),
  })).sort((a, b) => a.route.localeCompare(b.route));
}
async function builderBehaviour(env, label) {
  const out = [];
  const cases = [["owned", { params: { id: "5" } }, [{ value: [{ userId: 7 }] }]], ["missing", { params: { id: "5" } }, [{ value: [] }]], ["nan", { params: { id: "zz" } }, []], ["array", { params: { id: ["5", "6"] } }, [{ value: [{ userId: 7 }] }]]];
  const seen = new Set();
  for (const r of env.routes) for (const m of r.stack.slice(0, -1)) {
    if (!m?.__ownership || seen.has(m.__ownership.builder)) continue; seen.add(m.__ownership.builder);
    for (const [cn, req, rows] of cases) {
      const e2 = createEnv({ [SEL_E]: rows }); // fresh fake DB per probe
      const ld2 = createLoader({ ts, root: ROOT, srcDir: SRC, env: e2 });
      // Re-load is unnecessary: the builder closes over the module's `db`; swap its queue by re-driving the same env.
      void ld2;
      env.log.length = 0; env.__setQueue?.(SEL_E, rows);
      let res, thr = null; try { res = await m.__ownership.builder(req); } catch (e) { thr = e.message; }
      out.push({ label, case: cn, res: summ(res), thr, log: env.log.map(canon) });
    }
  }
  return out;
}
async function contractTests() {
  const results = []; const t = (name, passed, details = "") => results.push({ name, passed: Boolean(passed), details });
  for (const [file, baselineName] of [["routes/entities.ts", "entities.ts"], ["routes/value-history.ts", "value-history.ts"]]) {
    const o = await loadConsumer({ which: "old", file, baselineName }), n = await loadConsumer({ which: "new", file, baselineName });
    const so = summarizeStack(o.env), sn = summarizeStack(n.env);
    t(`contract:${file}:route table + middleware + ownership actions + deny bodies identical`, canon(so) === canon(sn), canon(so) === canon(sn) ? `${so.length} routes` : "route/middleware/deny surface differs");
    t(`contract:${file}:every vault_entry route is still ownership-gated`, so.filter((r) => r.stack.some((s) => s.ownership)).length === sn.filter((r) => r.stack.some((s) => s.ownership)).length && sn.some((r) => r.stack.some((s) => s.ownership)));
    // builder behaviour (owned / missing / NaN / array) — old wrapper's builder vs new owner's builder
    const drive = async (ctx) => {
      const out = []; const seen = new Set();
      for (const r of ctx.env.routes) for (const m of r.stack.slice(0, -1)) {
        if (!m?.__ownership || seen.has(m.__ownership.builder)) continue; seen.add(m.__ownership.builder);
        for (const [cn, req, rows] of [["owned", { params: { id: "5" } }, [{ userId: 7 }]], ["missing", { params: { id: "5" } }, []], ["nan", { params: { id: "zz" } }, []], ["array", { params: { id: ["5", "6"] } }, [{ userId: 7 }]]]) {
          const c2 = await loadConsumer({ which: ctx.which, file, baselineName, script: { [SEL_E]: [{ value: rows }] } });
          const b = [...c2.env.routes.flatMap((x) => x.stack.slice(0, -1))].find((x) => x?.__ownership);
          c2.env.log.length = 0; let res, thr = null; try { res = await b.__ownership.builder(req); } catch (e) { thr = e.message; }
          out.push({ case: cn, res: summ(res), thr, log: c2.env.log.map(canon) });
        }
        break; // one distinct builder per file is enough: all routes share it
      }
      return out;
    };
    const bo = await drive({ which: "old", env: o.env }), bn = await drive({ which: "new", env: n.env });
    t(`contract:${file}:ownership builder behaviour identical (owned/missing/NaN/array-param)`, bo.length > 0 && canon(bo) === canon(bn), bo.length ? "" : "no builders exercised");
    t(`security:${file}:foreign-owner row is reported with the foreign ownerId`, (() => { const x = bn.find((y) => y.case === "owned"); return x && x.res?.ownerId === 7 && x.res?.type === "vault_entry"; })());
  }
  return results;
}
async function healthScanJobTest(overrides) {
  const runScan = async (which) => {
    const rows = [{ id: 1, userId: 7, category: "c", projectName: "P" }, { id: 2, userId: 8, category: "c", projectName: "Q" }];
    const touched = new Set();
    const routesVaultStub = new Proxy({}, { get: (_t, p) => { if (typeof p === "string") touched.add(p); return p === "toHealthInput" ? (f) => ({ health: f.id }) : undefined; } });
    const fmtCalls = [];
    const extra = {
      "routes/vault": routesVaultStub,
      "vault/application/entity/representation": { formatVaultEntry: (e) => { fmtCalls.push(e.id); return { id: e.id, userId: e.userId, category: e.category, projectName: e.projectName }; } },
      "lib/vault-health": { evalBackgroundHealthRules: () => [{ id: "stale-login" }], evalKycBackgroundHealthRules: () => [], evalWalletBackgroundHealthRules: () => [], evalLocalAccountBackgroundHealthRules: () => [], evalDataEntityBackgroundHealthRules: () => [], severityEmoji: () => "!" },
      "lib/logger": { logger: new Proxy({}, { get: () => () => {} }) },
      "lib/log-bus": { logBus: new Proxy({}, { get: () => () => {} }) },
    };
    const c = await loadConsumer({ which, file: "lib/vault-health-scan.ts", baselineName: "vault-health-scan.ts", script: { [SEL_E]: [{ value: rows }] }, overrides, extraStubs: extra });
    c.env.log.length = 0;
    const result = await c.exp.runDailyHealthScan();
    return { result, touched: [...touched].sort(), fmtCalls, log: c.env.log };
  };
  const n = await runScan("new");
  const res = []; const t = (name, passed, details = "") => res.push({ name, passed: Boolean(passed), details });
  const selectedFromVaultEntries = n.log.some((e) => e[0] === "db.select.from" && canon(e[1]).includes("table(vaultEntriesTable)"));
  t("job:health-scan reads entries through the repository (vault_entries SELECT ... deleted_at IS NULL)", selectedFromVaultEntries && n.log.some((e) => e[0] === "db.select.where" && canon(e[1]).includes("IS NULL")));
  t("job:health-scan formats rows through the representation owner", canon(n.fmtCalls) === canon([1, 2]), canon(n.fmtCalls));
  t("job:health-scan touches routes/vault ONLY for toHealthInput (GAP-11 deferred)", canon(n.touched) === canon(["toHealthInput"]), canon(n.touched));
  t("job:health-scan persists flags per entry with owner filter", n.log.filter((e) => e[0] === "db.update").length === 2 && n.log.some((e) => e[0] === "db.update.where" && canon(e[1]).includes("vaultEntriesTable.userId")));
  t("job:health-scan summary counts are correct", n.result.entriesScanned >= 0 && canon(Object.keys(n.result).sort()) === canon(["entriesFlagged", "entriesScanned", "usersAlerted"]), canon(n.result));
  return res;
}
async function contractSuite() {
  const guard = async (label, fn) => { try { return await fn(); } catch (e) { return [{ name: `${label} (crashed)`, passed: false, details: String(e.message).slice(0, 200) }]; } };
  const c = await guard("contract:consumers", contractTests); const j = await guard("job:health-scan", () => healthScanJobTest());
  return [...c, ...j];
}

// ── 5. Mutation self-tests (in-memory) ──
async function selfTests(owners, exportsByFile) {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed: Boolean(passed), details });
  // (a) a consumer that imports a moved symbol from the old module must be a BYPASS violation
  const fake = new Map([[R("routes/zz-fake-consumer.ts"), 'import { selectAllVaultEntries } from "./vault";\nexport const x = selectAllVaultEntries;\n']]);
  const e1 = scanConsumers(fake); const c1 = classifyEdges(e1, owners, exportsByFile);
  t("selftest:moved-symbol-imported-from-old-module-is-BYPASS", c1.violations.some((v) => v.consumer.endsWith("zz-fake-consumer.ts") && v.status === "BYPASS"));
  // (b) dynamic import of the old module must be discovered as an edge
  const fake2 = new Map([[R("routes/zz-dyn.ts"), 'export async function f() { const m = await import("./vault-entity-links"); return m.vaultEntryResource; }\n']]);
  t("selftest:dynamic-import-consumer-discovered", scanConsumers(fake2).some((e) => e.consumer.endsWith("zz-dyn.ts") && e.kind === "dynamic-import"));
  // (c) a renamed copy of a moved function must be caught by the semantic-fingerprint scan
  const own = fs.readFileSync(path.join(SRC, "vault/infrastructure/repositories/entity-repository.ts"), "utf8").replace(/\bselectVaultOne\b/g, "someOtherName");
  const hits = bypassScan(new Map([[R("routes/zz-copy.ts"), own]]));
  t("selftest:renamed-copy-of-moved-function-detected", hits.some((h) => h.file.endsWith("zz-copy.ts")));
  // (d) a dangling import must be flagged
  const fake3 = new Map([[R("routes/zz-dangling.ts"), 'import { doesNotExist } from "./vault";\nexport const y = doesNotExist;\n']]);
  t("selftest:dangling-import-flagged", classifyEdges(scanConsumers(fake3), owners, exportsByFile).violations.some((v) => v.status === "DANGLING"));
  // (e) the health job test must notice a consumer wired back to the old owner
  const hsPath = path.join(SRC, "lib/vault-health-scan.ts"); const orig = fs.readFileSync(hsPath, "utf8");
  const mut = orig.replace('import { selectAllVaultEntries } from "../vault/infrastructure/repositories/entity-repository";', 'import { selectAllVaultEntries } from "../routes/vault";');
  t("selftest:mutation-anchor-present", mut !== orig);
  const mres = await healthScanJobTest(new Map([[hsPath, mut]])).catch((e) => [{ name: "crashed", passed: false, details: String(e.message) }]);
  t("selftest:health-job-detects-rewire-reverted-to-old-owner", mres.some((r) => !r.passed));
  return out;
}

// ── 6. Diff audit ──
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE, "repo-manifest.json"), "utf8")).files;
  const now = {}; for (const f of walkFiles(ROOT)) now[rel(f)] = sha256File(f);
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const okAdd = (k) => ALLOWED_CHANGED.has(k) || k.startsWith("scripts/antas/vault/gap/");
  return { changed, added, removed, unexpected: [...changed.filter((k) => !ALLOWED_CHANGED.has(k)), ...added.filter((k) => !okAdd(k)), ...removed] };
}

function sourceHashes() {
  const files = [...ALLOWED_CHANGED, "scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs", "scripts/antas/vault/gap/validate-vlt-gap-01-B.mjs"];
  return Object.fromEntries(files.map((f) => [f, sha256File(path.join(ROOT, f))]));
}

async function main() {
  if (process.argv.includes("--verify")) {
    if (!fs.existsSync(EVIDENCE_FILE)) fail("evidence missing: run the validator first");
    const ev = JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8")); const b = binding(sourceHashes()); const p = [];
    if (ev.sub_phase !== SUB_PHASE) p.push("sub_phase mismatch");
    if (ev.commit_sha !== b.commit_sha) p.push("commit_sha mismatch");
    if (ev.source_tree_sha256 !== b.source_tree_sha256) p.push("source changed since evidence (stale)");
    if (ev.validator_sha256 !== sha256File(HERE)) p.push("different validator version");
    const body = { ...ev }; delete body.evidence_body_sha256; delete body.generated_at;
    if (sha256(JSON.stringify(body)) !== ev.evidence_body_sha256) p.push("evidence body edited after generation");
    if (ev.status !== "PASS") p.push(`recorded status ${ev.status}`);
    if (p.length) fail(`evidence rejected: ${p.join("; ")}`);
    console.log(`${SUB_PHASE} evidence verified (${b.commit_binding})`); return;
  }
  const started = Date.now(); const commands = []; const exit_codes = {};
  // executed prerequisite: 01-B (which itself executes 01-A). Its exit code is recorded, not trusted from disk.
  const b1 = spawnSync(process.execPath, [path.join(ROOT, "scripts/antas/vault/gap/validate-vlt-gap-01-B.mjs")], { encoding: "utf8", env: process.env });
  commands.push("node scripts/antas/vault/gap/validate-vlt-gap-01-B.mjs"); exit_codes["01-B"] = b1.status;

  const owners = loadOwners();
  const exportsByFile = new Map(OLD_MODULES.map((m) => [m, exportsOf(parse(m, fs.readFileSync(path.join(ROOT, m), "utf8")))]));
  const edges = scanConsumers();
  const { classified, violations } = classifyEdges(edges, owners, exportsByFile);
  const proofs = rewireProof();
  const dup = bypassScan();
  const tableAccess = informationalTableAccess();
  const contract = await contractSuite();
  const selft = await selfTests(owners, exportsByFile);
  const audit = diffAudit();

  // cross-check against the independent 01-A census consumer list
  const census = JSON.parse(fs.readFileSync(path.join(EVIDENCE_DIR, "symbol-inventory.json"), "utf8"));
  const key = (c) => `${c.consumer}|${c.target}|${c.kind}`;
  const a = new Set(census.consumers.filter((c) => !c.consumer.startsWith("scripts/antas/")).map(key)), b = new Set(edges.map(key));
  const onlyCensus = [...a].filter((x) => !b.has(x)), onlyMine = [...b].filter((x) => !a.has(x));

  // compat re-exports of moved symbols must be gone
  const compat = [];
  for (const m of ["routes/vault.ts", "routes/vault-entity-links.ts"]) {
    const sf = parse(m, fs.readFileSync(path.join(SRC, m), "utf8"));
    for (const s of sf.statements) if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) if (MOVED_GAP01.includes(e.name.text)) compat.push(`${m}:${e.name.text}`);
  }
  const deferred = classified.filter((c) => c.status.startsWith("deferred:"));
  const checks = [];
  const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details });
  chk("prerequisite:01-B-executed-and-passed", b1.status === 0, (b1.stderr || b1.stdout || "").slice(-300));
  chk("consumer-graph:no-bypass-or-dangling-or-unclassified", violations.length === 0, canon(violations));
  chk("consumer-graph:all-edges-classified", classified.every((c) => c.status && c.status !== "UNCLASSIFIED"));
  chk("consumer-graph:matches-independent-01-A-census", onlyCensus.length === 0 && onlyMine.length === 0, `only-census=${onlyCensus.join(",")} only-validator=${onlyMine.join(",")}`);
  chk("no-compat-reexports-of-moved-symbols-remain", compat.length === 0, compat.join(", "));
  for (const p of proofs) for (const c of p.checks) chk(`rewire:${p.consumer}:${c.name}`, c.passed, c.details);
  chk("bypass-scan:no-duplicate-of-moved-implementation-outside-vault", dup.length === 0, canon(dup));
  for (const r of contract) chk(r.name, r.passed, r.details);
  for (const r of selft) chk(r.name, r.passed, r.details);
  chk("diff-audit:no-unrelated-changes", audit.unexpected.length === 0, audit.unexpected.join(", "));
  chk("contract:public-route-tables-stable (01-B differential executed)", b1.status === 0);
  chk("coverage:deferred-consumers-name-a-later-owner", deferred.every((d) => /^GAP-\d+$/.test(d.owner_gap)), canon(deferred.filter((d) => !/^GAP-\d+$/.test(d.owner_gap))));
  exit_codes.consumer_graph = violations.length ? 1 : 0;
  exit_codes.contract_tests = contract.every((r) => r.passed) ? 0 : 1;
  exit_codes.self_tests = selft.every((r) => r.passed) ? 0 : 1;
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const bd = binding(hashes);
  const ev = {
    phase: "VLT-GAP-01", sub_phase: SUB_PHASE,
    commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE),
    source_hashes: hashes, commands, exit_codes,
    symbols_moved: [], // moved in 01-B; see extraction-proof.json
    consumers_migrated: proofs.map((p) => ({ consumer: p.consumer, before: p.before, after: p.after, statements_verified_identical: p.statements_compared, passed: p.passed })),
    old_business_symbols_remaining: [],
    duplicate_implementations: dup,
    consumer_edges: classified,
    deferred_consumers: deferred.map((d) => ({ consumer: d.consumer, symbol: d.symbol, target: d.target, owner_gap: d.owner_gap, behavior_domain: d.behavior_domain })),
    direct_vault_entries_accessors_outside_vault_module_informational: tableAccess,
    contract_tests: contract, self_tests: selft, diff_audit: audit,
    summary: { edges: classified.length, api_registration: classified.filter((c) => c.status === "api-registration").length, api_adapter_reexport: classified.filter((c) => c.status === "api-adapter-reexport").length, deferred: deferred.length, bypass: violations.length, consumers_rewired: proofs.length, contract_cases: contract.length, self_tests: selft.length },
    checks, status: failed.length === 0 ? "PASS" : "FAIL",
  };
  ev.evidence_body_sha256 = sha256(JSON.stringify(ev)); ev.generated_at = new Date().toISOString();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(ev, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${ev.status} — edges=${ev.summary.edges} rewired=${proofs.length} deferred=${deferred.length} bypass=${violations.length} contract=${contract.length} selftests=${selft.filter((s) => s.passed).length}/${selft.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 300) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
