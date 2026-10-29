#!/usr/bin/env node
// VLT-GAP-05-D — Old Source Retirement Gate (Secret/Core). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-05/{old-source-fingerprint,new-source-fingerprint,route-thinness,duplicate-implementation,
//           behavior-regression,security-regression,gate}.json
//
// Question answered: is the NEW module the source of truth, and is the OLD implementation only an adapter or retired?
//   Old sources (roadmap): services/vault/src/index.mjs, routes/vault.ts, lib/vault-crypto.ts.
//   (1) lib/vault-crypto.ts (pure re-export adapter, zero importers after 05-C) must be RETIRED: file gone, no import/re-export/
//       dynamic import/require/string/config reference anywhere, migration map + generated docs say RETIRED and agree with the tree.
//   (2) routes/vault.ts must hold no DB/provider/crypto/credit logic for the GAP-05 behaviors: every handler is parsed; the four
//       secret handlers must be the exact delegating shape; the only remaining DB use is the GAP-11 health runner (explicit deferral).
//   (3) services/vault/src/index.mjs must be a pure composition root; the service compat shims must be pure re-exports.
//   (4) No duplicate implementation of the crypto owner or of the secret use-cases / old handler bodies anywhere in the repo.
//   (5) Behavior: 05-C (and through it 05-B's 51-case differential) is re-run on a temp copy reconstructed to the 05-C-certified state;
//       the crypto owner is EXECUTED (legacy + versioned + rotation + tamper cases) and proven token-identical to the sealed owner.
//   (6) Security: step-up before decrypt, tenant predicates, middleware chains, no plaintext logging, owner crypto unchanged.
//   (7) Diff audit, differential typecheck, mutation self-tests and bypass attempts. Status is validator-generated only.
// This validator NEVER writes a baseline; it only VERIFIES the write-once seal from freeze-vlt-gap-05-D-baseline.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-05";
const SUB_PHASE = "VLT-GAP-05-D";
const HERE = fileURLToPath(import.meta.url);
const GAP = "scripts/antas/vault/gap/";
const SRC = path.join(ROOT, "artifacts/api-server/src");
const EVID = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const BASE = path.join(EVID, "baseline-05d");
const FROZEN_DIR = path.join(BASE, "frozen");
const SEAL_FILE = path.join(BASE, "SEAL.json");
const MANIFEST_FILE = path.join(BASE, "tree-manifest.json");
const SEAL_05C = path.join(EVID, "baseline-05c/SEAL.json");
const GATE_FILE = path.join(EVID, "gate.json");
const EVIDENCE_FILES = ["old-source-fingerprint.json", "new-source-fingerprint.json", "route-thinness.json", "duplicate-implementation.json", "behavior-regression.json", "security-regression.json"];
const R = (f) => `artifacts/api-server/src/${f}`;
const COMPAT = R("lib/vault-crypto");
const OWNER = R("vault/crypto/field-encryption");
const ROUTE = R("routes/vault.ts");
const SVC = "services/vault/src/index.mjs";
const canon = (o) => JSON.stringify(o);
const ALLOWED_NEW_SCRIPTS = new Set([`${GAP}validate-vlt-gap-05-D.mjs`, `${GAP}freeze-vlt-gap-05-D-baseline.mjs`]);
const OWNER_NAMES = ["decryptField", "decryptRow", "decryptRows", "encryptField", "getActiveVersion", "loadKeyManager", "rotateKey"];
// The only files 05-D may change/delete (everything else must be byte-identical to the 05-C-certified tree).
const RETIRE_FILES = { deleted: [`${COMPAT}.ts`], edited: [`${OWNER}.ts`, "docs/antas/vault/file-migration-map.md", "docs/antas/vault/db-touch-inventory.md", "docs/antas/vault/architecture.md", "scripts/antas/vault/build-certification.mjs"] };

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const kindOf = (name) => (/\.(mjs|js|cjs)$/.test(name) ? ts.ScriptKind.JS : /x$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kindOf(name));
const exists = (rp) => fs.existsSync(path.join(ROOT, rp)) && fs.statSync(path.join(ROOT, rp)).isFile();
/** overlay: Map<relpath, string|null>; null = deleted. */
const rd = (overlay, rp) => (overlay?.has(rp) ? overlay.get(rp) : exists(rp) ? fs.readFileSync(path.join(ROOT, rp), "utf8") : null);
const norm = (s) => s.replace(/\s+/g, " ").trim();
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

// ── 0. Seal ─────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(SEAL_FILE) || !fs.existsSync(MANIFEST_FILE)) fail("baseline-05d/SEAL.json missing — run freeze-vlt-gap-05-D-baseline.mjs ONCE, before any 05-D change");
const SEAL = JSON.parse(fs.readFileSync(SEAL_FILE, "utf8")); const MANIFEST_TEXT = fs.readFileSync(MANIFEST_FILE, "utf8"); const MANIFEST = JSON.parse(MANIFEST_TEXT).files;
const SEAL_C = JSON.parse(fs.readFileSync(SEAL_05C, "utf8"));
const CONSUMERS = Object.values(SEAL_C.frozen_consumers).map((v) => v.source).sort();
const frozenText = (name) => fs.readFileSync(path.join(FROZEN_DIR, name), "utf8");
const FROZEN_BY_SOURCE = Object.fromEntries(Object.entries(SEAL.frozen_files).map(([n, v]) => [v.source, n]));

// ── AST primitives ──────────────────────────────────────────────────────────────────────────────────────────────────
const stripExt = (p) => p.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
const resolveSpec = (fromRel, spec) => (spec.startsWith(".") ? stripExt(rel(path.resolve(path.dirname(path.join(ROOT, fromRel)), spec))) : null);
function specifiers(text, fileRel) {
  const sf = parse(fileRel, text); const out = [];
  const add = (lit, kind, names) => out.push({ spec: lit.text, kind, line: lineOf(sf, lit.getStart(sf)), resolved: resolveSpec(fileRel, lit.text), names });
  (function w(n) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) { const c = n.importClause; const names = []; if (c?.name) names.push("default"); if (c?.namedBindings) { if (ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text)); else names.push("*"); } add(n.moduleSpecifier, "import", names); }
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier, "re-export", n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"]);
    else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      let names = ["*"]; let p = n.parent; while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) names = p.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
      add(n.arguments[0], n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require", names);
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
/** Comment-free token stream (comments/JSDoc never become tokens), used to prove "code unchanged". */
function tokens(text, fileRel) {
  const sf = parse(fileRel, text); const out = [];
  (function w(n) { if (ts.isJSDoc(n)) return; if (n.getChildCount(sf) === 0) { if (n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(n.getText(sf)); } else n.getChildren(sf).forEach(w); })(sf);
  return out;
}
function exportedNames(text, fileRel) {
  const sf = parse(fileRel, text); const out = new Set();
  for (const s of sf.statements) {
    const ex = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ex && ts.isFunctionDeclaration(s) && s.name) out.add(s.name.text);
    else if (ex && ts.isVariableStatement(s)) s.declarationList.declarations.forEach((d) => out.add(d.name.getText(sf)));
    else if (ex && (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s)) && s.name) out.add(s.name.text);
    else if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) s.exportClause.elements.forEach((e) => out.add(e.name.text));
  }
  return out;
}
function allSourceFiles() {
  const roots = ["artifacts", "scripts", "lib", "packages", "services", "apps", "tests"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const files = []; for (const d of roots) walkFiles(d, files, (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"));
  return files.map(rel).filter((r) => !r.startsWith("scripts/antas/") && !r.includes("/node_modules/"));
}
const sourceUniverse = (overlay) => [...new Set([...allSourceFiles(), ...(overlay ? [...overlay.keys()].filter((k) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(k) && !k.startsWith("scripts/antas/")) : [])])];

// ── 1. Retirement of lib/vault-crypto.ts ────────────────────────────────────────────────────────────────────────────
const CONSTANT_OK = /^ayzen:vault-crypto:/; // HKDF salt constant (data), not a module reference
// a string that IS a module path (…/vault-crypto, vault-crypto.ts); prose in log messages is not a reference
const MODULE_PATH_LIKE = /^(\.{1,2}\/|@\/|\/)?([\w.@-]+\/)*vault-crypto(\.(ts|js|mjs|cjs))?$/;
function referenceScan(overlay = new Map()) {
  const importers = []; const stringRefs = []; const commentOnly = [];
  for (const r of sourceUniverse(overlay)) {
    const text = rd(overlay, r); if (text === null || !/vault-crypto/.test(text)) continue;
    for (const s of specifiers(text, r)) if (s.resolved === COMPAT) importers.push({ file: r, line: s.line, kind: s.kind });
    const sf = parse(r, text); let codeHit = false;
    (function w(n) {
      const lit = ts.isStringLiteralLike(n) || ts.isTemplateLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
      if (lit && MODULE_PATH_LIKE.test(n.text ?? "") && !CONSTANT_OK.test(n.text ?? "")) {
        const p = n.parent; const isSpec = (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n;
        if (!isSpec) { stringRefs.push({ file: r, line: lineOf(sf, n.getStart(sf)) }); codeHit = true; }
      }
      if (ts.isIdentifier(n) && /vault-?crypto/i.test(n.text)) { stringRefs.push({ file: r, line: lineOf(sf, n.getStart(sf)), identifier: n.text }); codeHit = true; }
      ts.forEachChild(n, w);
    })(sf);
    if (!codeHit && !importers.some((i) => i.file === r)) commentOnly.push(r);
  }
  return { importers, stringRefs, commentOnly };
}
function configScan(overlay = new Map()) {
  const hits = []; const files = [];
  walkFiles(ROOT, files, (p) => /\.(json|ya?ml|toml)$/.test(p) && !/node_modules/.test(p));
  for (const f of files.map(rel)) { const t = rd(overlay, f); if (t !== null && /lib\/vault-crypto|\.\/vault-crypto|vault-crypto\.(ts|js)/.test(t)) hits.push(f); }
  for (const [k, t] of overlay) if (/\.(json|ya?ml|toml)$/.test(k) && t !== null && /lib\/vault-crypto|\.\/vault-crypto/.test(t) && !hits.includes(k)) hits.push(k);
  return hits;
}
function migrationMap(overlay = new Map()) {
  const out = { rows: [], problems: [] };
  const mapText = rd(overlay, "docs/antas/vault/file-migration-map.md"); const gen = rd(overlay, "scripts/antas/vault/build-certification.mjs");
  if (mapText === null) { out.problems.push("file-migration-map.md missing"); return out; }
  for (const line of mapText.split("\n")) {
    const c = line.split("|").map((x) => x.trim()); if (c.length < 6 || c[1] === "Classification" || /^-+$/.test(c[1])) continue;
    const row = { classification: c[1], old: c[2], target: c[3], status: c[4] }; out.rows.push(row);
    if (row.old.includes("*")) continue;
    const oldExists = rd(overlay, row.old) !== null; const retired = /^RETIRED\b/.test(row.status);
    if (retired && oldExists) out.problems.push(`${row.old}: map says RETIRED but the file still exists`);
    if (!retired && !oldExists && row.old.endsWith(".ts")) out.problems.push(`${row.old}: map says '${row.status}' but the file does not exist`);
    if (retired && rd(overlay, row.target) === null) out.problems.push(`${row.old}: RETIRED but its target ${row.target} does not exist`);
  }
  const crypto = out.rows.find((r) => r.old === `${COMPAT}.ts`);
  if (!crypto || !/^RETIRED\b/.test(crypto.status) || crypto.target !== `${OWNER}.ts`) out.problems.push("lib/vault-crypto.ts must be listed RETIRED → vault/crypto/field-encryption.ts");
  if (gen === null || !gen.includes("| Crypto | artifacts/api-server/src/lib/vault-crypto.ts | artifacts/api-server/src/vault/crypto/field-encryption.ts | RETIRED (VLT-GAP-05-D) |")) out.problems.push("build-certification.mjs generator does not emit the RETIRED row (docs would regress on regeneration)");
  const arch = rd(overlay, "docs/antas/vault/architecture.md") ?? ""; const dbt = rd(overlay, "docs/antas/vault/db-touch-inventory.md") ?? "";
  for (const m of arch.matchAll(/^.*vault-crypto.*$/gm)) if (!/retired/i.test(m[0])) out.problems.push(`architecture.md presents lib/vault-crypto as live: ${m[0].trim()}`);
  if (/`vault-crypto` helper/.test(dbt)) out.problems.push("db-touch-inventory.md still names the retired helper");
  return out;
}
function ownerChecks(overlay = new Map()) {
  const text = rd(overlay, `${OWNER}.ts`); const o = { present: text !== null, names: [], imports: [], reach: 0, cycle: [], claimsAdapter: false };
  if (text === null) return o;
  o.names = [...exportedNames(text, "owner.ts")].sort(); o.imports = specifiers(text, "owner.ts").map((s) => s.spec);
  o.claimsAdapter = /remains a compatibility adapter|compatibility adapter for\s+consumers that have not moved/i.test(text);
  // reachability within api-server (relative imports only): owner must not reach any consumer
  const seen = new Set(); const stack = [`${OWNER}`];
  while (stack.length) { const f = stack.pop(); if (seen.has(f)) continue; seen.add(f); const real = [`${f}.ts`, `${f}/index.ts`].find((c) => rd(overlay, c) !== null); if (!real) continue; for (const s of specifiers(rd(overlay, real), real)) if (s.resolved?.startsWith("artifacts/api-server/src/")) stack.push(s.resolved); }
  o.reach = seen.size; o.cycle = CONSUMERS.map(stripExt).filter((f) => f !== OWNER && seen.has(f));
  return o;
}
function consumerOwnership(overlay = new Map()) {
  const bad = []; const rows = [];
  const names = exportedNames(rd(overlay, `${OWNER}.ts`) ?? "", "owner.ts");
  for (const c of CONSUMERS) {
    const t = rd(overlay, c); if (t === null) { bad.push(`${c}: missing`); continue; }
    const hit = specifiers(t, c).filter((s) => s.resolved === OWNER);
    if (!hit.length) { bad.push(`${c}: no longer imports the crypto owner`); continue; }
    for (const h of hit) for (const n of h.names) if (n !== "*" && !names.has(n)) bad.push(`${c}: '${n}' not exported by owner`);
    rows.push({ file: c, owner_import_kinds: hit.map((h) => h.kind), names: [...new Set(hit.flatMap((h) => h.names))].sort() });
  }
  return { bad, rows };
}

// ── 2. routes/vault.ts thinness ─────────────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_IN_HANDLER = new Set(["db", "sql", "eq", "and", "or", "inArray", "vaultEntriesTable", "usersTable", "decryptSeedPhrase", "encryptSeedPhrase", "decryptField", "encryptField", "decryptRow", "decryptRows", "loadKeyManager", "rotateKey", "chargeCredits", "fetch", "ethers", "getChainBalance", "validateWalletKey", "disable_seed_reveal", "encrypted_seed_phrase"]);
const SECRET_IDS = ["decryptSeedPhrase", "decryptField", "encryptField", "loadKeyManager", "rotateKey", "consumeRevealToken", "chargeCredits", "ethers"];
const FORBIDDEN_IMPORT = [/lib\/vault-crypto/, /vault\/crypto\//, /lib\/chain-balance/, /lib\/wallet-key-validation/, /lib\/wallet-crypto/, /vault\/infrastructure\/repositories\/secret-repository/];
const DEFERRED_HANDLERS = { "GET /vault/health-report": "VLT-GAP-11", "POST /vault/health-check": "VLT-GAP-11" };
const SINGLE_BRANCH_OK = { "GET /vault/receipt/:token/pdf": "response mapping over the receipt use-case result (GAP-01 receipt owner builds the PDF spec)" };
const SECRET_ROUTES = {
  "GET /vault/:id/seed": { fn: "revealSeedPhrase", mw: ["requireAuth", "requireVaultEntryOwnership:vault_entry.seed.read", "requireCreditBalance:sylo.credential_access"] },
  "PATCH /vault/:id/drive-wallet": { fn: "setDriveWallet", mw: ["requireAuth", "requireVaultEntryOwnership:vault_entry.drive_wallet.update"] },
  "POST /vault/validate-key": { fn: "validateSecretKey", mw: ["requireAuth"] },
  "POST /vault/:id/refresh-wallet-worth": { fn: "refreshWalletWorth", mw: null },
};
const mwName = (m, sf) => (ts.isCallExpression(m) ? `${m.expression.getText(sf)}${m.arguments[0] && ts.isStringLiteralLike(m.arguments[0]) ? `:${m.arguments[0].text}` : ""}` : m.getText(sf));
function routeGate(overlay = new Map()) {
  const text = rd(overlay, ROUTE); const v = []; const handlers = []; if (text === null) return { violations: ["routes/vault.ts missing"], handlers, symbols: [], db_sites: [] };
  const sf = parse("vault.ts", text);
  const importSpecs = specifiers(text, ROUTE);
  for (const s of importSpecs) for (const rx of FORBIDDEN_IMPORT) if (rx.test(s.spec)) v.push(`routes/vault.ts imports '${s.spec}' (business owner must be reached through vault/application)`);
  const healthFns = new Set(["runHealthCheck", "toHealthInput"]); const symbols = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) continue;
    if (ts.isFunctionDeclaration(s)) { symbols.push({ kind: "function", name: s.name?.text, lines: [lineOf(sf, s.getStart(sf)), lineOf(sf, s.end)], deferred_to: healthFns.has(s.name?.text) ? "VLT-GAP-11" : null }); if (!healthFns.has(s.name?.text)) v.push(`top-level function '${s.name?.text}' is not an approved adapter symbol`); }
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
      const ini = d.initializer; const name = d.name.getText(sf); symbols.push({ kind: "const", name });
      const ok = ini && ((ts.isCallExpression(ini) && ini.expression.getText(sf) === "Router") || (ts.isObjectLiteralExpression(ini) && ini.properties.every((p) => ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)))));
      if (!ok) v.push(`top-level const '${name}' is not a port/Router wiring declaration`);
    } else if (ts.isExpressionStatement(s)) { const e = s.expression; if (!(ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText(sf) === "router")) v.push(`unexpected top-level statement at line ${lineOf(sf, s.getStart(sf))}`); }
    else if (!ts.isExportAssignment(s) && !ts.isInterfaceDeclaration(s) && !ts.isTypeAliasDeclaration(s)) v.push(`unexpected top-level ${ts.SyntaxKind[s.kind]} at line ${lineOf(sf, s.getStart(sf))}`);
  }
  // every db/sql usage in the file must sit inside the deferred health runner
  const dbSites = []; const healthRange = (() => { const f = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "runHealthCheck"); return f ? [f.getStart(sf), f.end] : null; })();
  (function w(n) { if (ts.isIdentifier(n) && ["db", "sql"].includes(n.text) && !ts.isImportSpecifier(n.parent)) { const p = n.getStart(sf); const inside = healthRange && p >= healthRange[0] && p < healthRange[1]; dbSites.push({ line: lineOf(sf, p), in_deferred_health_runner: Boolean(inside) }); if (!inside) v.push(`DB access outside the deferred health runner at line ${lineOf(sf, p)}`); } ts.forEachChild(n, w); })(sf);
  for (const fn of sf.statements.filter((s) => ts.isFunctionDeclaration(s) && healthFns.has(s.name?.text))) {
    (function w(n) { if (ts.isIdentifier(n) && SECRET_IDS.includes(n.text)) v.push(`deferred health symbol '${fn.name.text}' references secret identifier '${n.text}'`); if (ts.isStringLiteralLike(n) && /encrypted_seed_phrase|disable_seed_reveal|drive_wallet/.test(n.text)) v.push(`deferred health symbol '${fn.name.text}' touches secret column '${n.text}'`); ts.forEachChild(n, w); })(fn);
  }
  const seen = new Set();
  (function w(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const key = `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`; const h = n.arguments[n.arguments.length - 1]; seen.add(key);
      const row = { route: key, middleware: n.arguments.slice(1, -1).map((m) => mwName(m, sf)), statements: 0, branches: 0, forbidden_refs: [], use_case: null, classification: "thin-adapter" };
      if (!ts.isFunctionLike(h) || !h.body) { v.push(`${key}: last argument is not an inline handler`); handlers.push(row); ts.forEachChild(n, w); return; }
      row.statements = ts.isBlock(h.body) ? h.body.statements.length : 1;
      (function x(y) {
        if (ts.isIfStatement(y) || ts.isConditionalExpression(y) || ts.isSwitchStatement(y) || ts.isForStatement(y) || ts.isForOfStatement(y) || ts.isForInStatement(y) || ts.isWhileStatement(y) || ts.isTryStatement(y)) row.branches++;
        if (ts.isBinaryExpression(y) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(y.operatorToken.kind)) row.branches++;
        if (ts.isIdentifier(y) && FORBIDDEN_IN_HANDLER.has(y.text)) row.forbidden_refs.push(y.text);
        if (ts.isStringLiteralLike(y) && /encrypted_seed_phrase|disable_seed_reveal|drive_wallet|wallet_worth/.test(y.text)) row.forbidden_refs.push(`"${y.text}"`);
        ts.forEachChild(y, x);
      })(h.body);
      const first = ts.isBlock(h.body) ? h.body.statements[0] : null; const decl = first && ts.isVariableStatement(first) ? first.declarationList.declarations[0] : null;
      const call = decl?.initializer && ts.isAwaitExpression(decl.initializer) && ts.isCallExpression(decl.initializer.expression) ? decl.initializer.expression : decl?.initializer && ts.isCallExpression(decl.initializer) ? decl.initializer : null;
      row.use_case = call ? call.expression.getText(sf) : null;
      if (row.forbidden_refs.length) v.push(`${key}: handler references ${[...new Set(row.forbidden_refs)].join(", ")} (DB/crypto/provider/credit logic must live in the owner)`);
      if (DEFERRED_HANDLERS[key]) row.classification = `deferred:${DEFERRED_HANDLERS[key]}`;
      else if (SINGLE_BRANCH_OK[key]) { row.classification = "response-mapping"; if (row.branches > 1) v.push(`${key}: more than one branch`); }
      else {
        if (row.branches) v.push(`${key}: ${row.branches} decision branch(es) inside a route handler`);
        if (row.statements !== 2 || !row.use_case) v.push(`${key}: handler is not 'const r = await useCase(...); res.status(r.status).json(r.body)'`);
        else if (!new RegExp(`^res\\.status\\((r|out)\\.status\\)\\.json\\(\\1\\.body\\)$`).test(norm(h.body.statements[1].getText(sf)).replace(/;$/, "")) && !/^res\./.test(norm(h.body.statements[1].getText(sf)))) v.push(`${key}: second statement is not a response mapping`);
      }
      const sec = SECRET_ROUTES[key];
      if (sec) {
        row.classification = "secret-adapter";
        if (row.use_case !== sec.fn) v.push(`${key}: must delegate to ${sec.fn} (found ${row.use_case})`);
        if (sec.mw && canon(row.middleware) !== canon(sec.mw)) v.push(`${key}: middleware chain changed: ${canon(row.middleware)}`);
        if (!importSpecs.some((s) => /vault\/application\/secret\//.test(s.spec) && s.names.includes(sec.fn))) v.push(`${key}: ${sec.fn} is not imported from vault/application/secret`);
      }
      handlers.push(row);
    }
    ts.forEachChild(n, w);
  })(sf);
  for (const k of Object.keys(SECRET_ROUTES)) if (!seen.has(k)) v.push(`secret route ${k} no longer registered`);
  if (handlers.length < 30) v.push(`only ${handlers.length} handlers found (parse problem or routes removed)`);
  return { violations: v, handlers, symbols, db_sites: dbSites, imports: importSpecs.map((s) => s.spec), lines: text.split("\n").length };
}

// ── 3. services/vault/src/index.mjs and compat shims ────────────────────────────────────────────────────────────────
function serviceGate(overlay = new Map()) {
  const v = []; const text = rd(overlay, SVC); if (text === null) return { violations: ["services/vault/src/index.mjs missing"], statements: [] };
  const sf = parse(SVC, text); const st = [];
  const BAD_ID = new Set(["crypto", "createCipheriv", "createDecipheriv", "Buffer", "fetch", "db", "sql", "pg", "Pool", "readFileSync", "writeFileSync", "eval"]);
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) { const spec = s.moduleSpecifier.text; st.push({ kind: "import", spec }); if (spec.startsWith(".") && !exists(rel(path.resolve(path.dirname(path.join(ROOT, SVC)), spec)))) v.push(`import '${spec}' does not resolve`); continue; }
    if (ts.isVariableStatement(s)) { st.push({ kind: "wiring-const", name: s.declarationList.declarations[0].name.getText(sf) }); continue; }
    if (ts.isExpressionStatement(s) && /^createServiceServer\(/.test(s.expression.getText(sf))) { st.push({ kind: "bootstrap" }); continue; }
    v.push(`non-composition statement ${ts.SyntaxKind[s.kind]} at line ${lineOf(sf, s.getStart(sf))}`);
  }
  (function w(n) {
    if (ts.isFunctionLike(n) && !ts.isSourceFile(n.parent)) { /* inline arrow in wiring is rejected below */ }
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) v.push(`function/class defined in the composition root at line ${lineOf(sf, n.getStart(sf))}`);
    if (ts.isIfStatement(n) || ts.isSwitchStatement(n) || ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isTryStatement(n) || ts.isConditionalExpression(n)) v.push(`control flow in the composition root at line ${lineOf(sf, n.getStart(sf))}`);
    if (ts.isIdentifier(n) && BAD_ID.has(n.text)) v.push(`composition root references '${n.text}' at line ${lineOf(sf, n.getStart(sf))}`);
    ts.forEachChild(n, w);
  })(sf);
  const needs = ["./crypto/envelope.mjs", "./security/access.mjs", "./infrastructure/dependencies.mjs", "./api/http-handler.mjs", "./api/contracts.mjs"];
  for (const n of needs) if (!st.some((s) => s.spec === n)) v.push(`composition root no longer wires ${n}`);
  const shims = ["crypto.mjs", "access.mjs", "domain.mjs", "contracts.mjs"].map((f) => {
    const rp = `services/vault/src/${f}`; const t = rd(overlay, rp); const ok = t !== null && parse(rp, t).statements.every((s) => ts.isExportDeclaration(s) && s.moduleSpecifier);
    if (!ok) v.push(`service shim ${f} is not a pure re-export`); return { file: rp, pure_reexport: ok };
  });
  return { violations: v, statements: st, shims };
}

// ── 4. Duplicate implementations ────────────────────────────────────────────────────────────────────────────────────
function fnFingerprints(text, fileRel, minTokens = 25) {
  const sf = parse(fileRel, text); const out = [];
  (function w(n) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))))) {
      const body = ts.isVariableDeclaration(n) ? n.initializer.body : n.body; const name = n.name?.getText(sf);
      if (body) { const t = []; (function z(x) { if (x.getChildCount(sf) === 0) { if (x.kind !== ts.SyntaxKind.EndOfFileToken) t.push(x.getText(sf)); } else x.getChildren(sf).forEach(z); })(body); if (t.length >= minTokens) out.push({ name, file: fileRel, line: lineOf(sf, n.getStart(sf)), tokens: t.length, fp: sha256(t.join(" ")) }); }
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
const KEY_ROTATION_SCRIPTS = { "scripts/src/reencrypt-vault.ts": "VLT-GAP-07", "scripts/src/rewrap-encryption-keys.ts": "VLT-GAP-07", "scripts/src/reencrypt-seed-phrases.ts": "VLT-GAP-07", [R("lib/wallet-crypto.ts")]: "VLT-GAP-07" };
const CLIENT_ONLY = /^artifacts\/(ayzen|mobile[^/]*|astra-extension)\//; // browser/extension API clients share function names with server use-cases; they implement nothing
const SECRET_USE_CASES = ["revealSeedPhrase", "setDriveWallet", "validateSecretKey", "refreshWalletWorth"];
function duplicateScan(overlay = new Map()) {
  const out = { owner_function_matches: [], redeclared_owner_names: [], redeclared_use_cases: [], old_handler_body_copies: [], deferred_copies: [], owner_functions: 0, old_handlers_fingerprinted: 0, files_scanned: 0, deferred_copy_namespaces: [], deferred_copy_same_namespace: [] };
  const ownerText = rd(overlay, `${OWNER}.ts`); if (ownerText === null) return { ...out, error: "owner missing" };
  const ownerFns = fnFingerprints(ownerText, `${OWNER}.ts`); out.owner_functions = ownerFns.length; const ownerFp = new Map(ownerFns.map((f) => [f.fp, f]));
  // old handler bodies = the 4 secret handlers of the sealed pre-extraction routes/vault.ts
  const baseRoute = path.join(EVID, "baseline/sources/artifacts__api-server__src__routes__vault.ts"); const oldHandlers = new Map();
  if (fs.existsSync(baseRoute)) {
    const bt = fs.readFileSync(baseRoute, "utf8"); const bsf = parse("old.ts", bt);
    (function w(n) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(bsf) === "router" && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) { const k = `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`; if (SECRET_ROUTES[k]) { const h = n.arguments[n.arguments.length - 1]; const t = []; (function z(x) { if (x.getChildCount(bsf) === 0) { if (x.kind !== ts.SyntaxKind.EndOfFileToken) t.push(x.getText(bsf)); } else x.getChildren(bsf).forEach(z); })(h.body); oldHandlers.set(sha256(t.join(" ")), k); } } ts.forEachChild(n, w); })(bsf);
  }
  out.old_handlers_fingerprinted = oldHandlers.size;
  for (const r of sourceUniverse(overlay)) {
    const t = rd(overlay, r); if (t === null) continue; out.files_scanned++;
    if (`${stripExt(r)}` === OWNER) continue;
    const sf = parse(r, t);
    for (const s of sf.statements) {
      const nm = ts.isFunctionDeclaration(s) ? s.name?.text : ts.isVariableStatement(s) ? s.declarationList.declarations.map((d) => d.name.getText(sf)).join(",") : null;
      if (!nm) continue;
      if (OWNER_NAMES.some((n) => nm.split(",").includes(n)) && !r.startsWith("scripts/antas/")) out.redeclared_owner_names.push({ file: r, name: nm });
      if (SECRET_USE_CASES.some((n) => nm.split(",").includes(n)) && !CLIENT_ONLY.test(r) && !/^artifacts\/api-server\/src\/vault\/application\/secret\//.test(r)) out.redeclared_use_cases.push({ file: r, name: nm });
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(r)) continue;
    for (const f of fnFingerprints(t, r)) {
      if (ownerFp.has(f.fp)) { const rec = { file: f.file, line: f.line, function: f.name, copy_of: ownerFp.get(f.fp).name }; if (KEY_ROTATION_SCRIPTS[r]) out.deferred_copies.push({ ...rec, deferred_to: KEY_ROTATION_SCRIPTS[r] }); else out.owner_function_matches.push(rec); }
      if (oldHandlers.has(f.fp)) out.old_handler_body_copies.push({ file: f.file, line: f.line, old_route: oldHandlers.get(f.fp) });
    }
  }
  // anonymous route handlers (route files) may carry a pasted copy of an old body
  for (const r of sourceUniverse(overlay).filter((x) => /\/routes\//.test(x))) {
    const t = rd(overlay, r); if (t === null || r === ROUTE) continue; const sf = parse(r, t);
    (function w(n) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === "router" && n.arguments.length) { const h = n.arguments[n.arguments.length - 1]; if (ts.isFunctionLike(h) && h.body) { const tk = []; (function z(x) { if (x.getChildCount(sf) === 0) { if (x.kind !== ts.SyntaxKind.EndOfFileToken) tk.push(x.getText(sf)); } else x.getChildren(sf).forEach(z); })(h.body); const fp = sha256(tk.join(" ")); if (oldHandlers.has(fp)) out.old_handler_body_copies.push({ file: r, line: lineOf(sf, n.getStart(sf)), old_route: oldHandlers.get(fp) }); } } ts.forEachChild(n, w); })(sf);
  }
  // a deferred copy is only acceptable if it manages a DIFFERENT key chain (its own namespace) than the owner
  out.deferred_copy_namespaces = [...new Set(out.deferred_copies.map((d) => d.file))].map((f) => { const tx = rd(overlay, f) ?? ""; const m = tx.match(/const NAMESPACE\s*=\s*"([^"]+)"/); return { file: f, namespace: m ? m[1] : null }; });
  out.deferred_copy_same_namespace = out.deferred_copy_namespaces.filter((d) => d.namespace === "vault");
  return out;
}

// ── 5. Executed crypto behavior (owner loaded through the harness loader with real node:crypto and an in-memory key table) ──
async function executedCryptoBehavior(ownerOverride = null) {
  const cases = []; const t = (name, passed, details = "") => cases.push({ name, passed: Boolean(passed), details: String(details).slice(0, 200) });
  const saved = { a: process.env.VAULT_FIELD_ENCRYPTION_KEY, b: process.env.VAULT_MASTER_KEY };
  process.env.VAULT_FIELD_ENCRYPTION_KEY = "gap05d-test-only-field-key-0123456789abcdef"; delete process.env.VAULT_MASTER_KEY; // test-only values; restored below
  try {
    const table = []; const env = createEnv({});
    const tag = (strings, ...values) => ({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    env.stubs.crypto = { default: globalThis.__nodeCrypto };
    env.stubs["drizzle-orm"] = { sql: tag };
    env.stubs["@workspace/db"] = { db: { execute: async (q) => {
      if (/^SELECT version/i.test(q.text)) return { rows: table.map((r) => ({ ...r })) };
      if (/^INSERT INTO encryption_keys/i.test(q.text)) { const [version, wrapped] = q.values.length === 2 ? [1, q.values[1]] : [q.values[1], q.values[2]]; if (!table.some((r) => r.version === version)) table.push({ version, wrapped_dek: wrapped, active: true }); return {}; }
      if (/^UPDATE encryption_keys SET active = FALSE/i.test(q.text)) { table.forEach((r) => { r.active = false; }); return {}; }
      throw new Error(`unexpected SQL: ${q.text}`);
    } } };
    if (ownerOverride) env.overrides = new Map([[path.join(SRC, "vault/crypto/field-encryption.ts"), ownerOverride]]);
    const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    const o = loader.loadFile(path.join(SRC, "vault/crypto/field-encryption.ts"));
    t("exports:all-seven-public-functions-present", OWNER_NAMES.every((n) => typeof o[n] === "function"), OWNER_NAMES.filter((n) => typeof o[n] !== "function").join(","));
    const legacy = o.encryptField("seed words here");
    t("legacy:pre-load-ciphertext-uses-plain-enc-prefix-and-iv:ct:tag-envelope", /^enc:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/.test(legacy), legacy.slice(0, 20));
    t("legacy:round-trip", o.decryptField(legacy) === "seed words here");
    t("passthrough:null-undefined-empty-and-unprefixed-values-are-returned-unchanged", o.encryptField(null) === null && o.encryptField(undefined) === undefined && o.encryptField("") === "" && o.decryptField("plain") === "plain" && o.decryptField(null) === null && o.decryptField("") === "");
    t("version:no-active-version-before-load", o.getActiveVersion() === null);
    await o.loadKeyManager();
    t("bootstrap:first-load-creates-v1-through-parameterised-sql-only", o.getActiveVersion() === 1 && table.length === 1 && /^[0-9a-f]{24}:/.test(table[0].wrapped_dek));
    const v1 = o.encryptField("alpha");
    t("versioned:v1-envelope", /^enc:v1:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/.test(v1) && o.decryptField(v1) === "alpha");
    t("versioned:legacy-ciphertext-still-decrypts-after-key-load", o.decryptField(legacy) === "seed words here");
    t("iv:two-encryptions-of-the-same-plaintext-differ", o.encryptField("alpha") !== v1);
    const nv = await o.rotateKey();
    t("rotation:rotateKey-returns-next-version-and-switches-active", nv === 2 && o.getActiveVersion() === 2 && table.filter((r) => r.active).length === 1 && table.find((r) => r.active).version === 2);
    const v2 = o.encryptField("beta");
    t("rotation:new-ciphertext-uses-v2-and-v1-ciphertext-still-decrypts", /^enc:v2:/.test(v2) && o.decryptField(v2) === "beta" && o.decryptField(v1) === "alpha");
    const parts = v1.split(":"); const ct = parts[3]; const flipped = `${parts.slice(0, 3).join(":")}:${(ct[0] === "0" ? "1" : "0") + ct.slice(1)}:${parts[4]}`;
    t("tamper:modified-ciphertext-yields-failure-marker-not-plaintext", o.decryptField(flipped) === "[decryption failed]");
    t("tamper:unknown-key-version-is-reported-not-guessed", o.decryptField("enc:v9:00:00:00") === "[decryption failed: unknown key version]");
    t("tamper:malformed-envelope-is-reported", o.decryptField("enc:garbage") === "[decryption failed]");
    const row = { a: o.encryptField("x"), b: o.encryptField("y"), c: "z" };
    t("rows:decryptRow-and-decryptRows-map-only-the-listed-fields", canon(o.decryptRow(row, ["a", "b"])) === canon({ a: "x", b: "y", c: "z" }) && canon(o.decryptRows([row], ["a"])) === canon([{ a: "x", b: row.b, c: "z" }]));
    t("no-leak:wrapped-dek-in-the-key-table-is-ciphertext", table.every((r) => /^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/.test(r.wrapped_dek) && !/^[0-9a-f]{64}$/.test(r.wrapped_dek)));
  } catch (e) { t("executed-behavior:module-loaded-and-ran", false, e.stack || e); }
  finally { if (saved.a === undefined) delete process.env.VAULT_FIELD_ENCRYPTION_KEY; else process.env.VAULT_FIELD_ENCRYPTION_KEY = saved.a; if (saved.b === undefined) delete process.env.VAULT_MASTER_KEY; else process.env.VAULT_MASTER_KEY = saved.b; }
  return cases;
}

// ── 6. Security regression (static, AST-derived) ────────────────────────────────────────────────────────────────────
function securityChecks(overlay = new Map()) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  const owner = rd(overlay, `${OWNER}.ts`) ?? ""; const sealedOwner = frozenText("owner__field-encryption.ts");
  chk("crypto:owner-code-token-identical-to-the-05-C-sealed-owner (only comments may differ)", owner !== "" && canon(tokens(owner, "owner.ts")) === canon(tokens(sealedOwner, "owner.ts")), `${tokens(owner, "o.ts").length} vs ${tokens(sealedOwner, "o.ts").length} tokens`);
  const oc = owner.replace(/\/\*[\s\S]*?\*\//g, "");
  chk("crypto:aes-256-gcm-hkdf-sha256-and-12-byte-iv-parameters-intact", /createCipheriv\("aes-256-gcm"/.test(oc) && /createDecipheriv\("aes-256-gcm"/.test(oc) && /hkdfSync\("sha256"/.test(oc) && /randomBytes\(12\)/.test(oc) && /setAuthTag/.test(oc));
  chk("crypto:fail-closed-boot-without-a-32-char-key", /LEGACY_KEY_RAW\.length < 32/.test(oc) && /throw new Error\(/.test(oc));
  chk("crypto:key-table-sql-is-parameterised (no string concatenation into SQL)", !/sql`[^`]*\$\{(?!NAMESPACE|newVersion|wrapDek)/.test(oc));
  const rev = rd(overlay, R("vault/application/secret/reveal.ts")) ?? ""; const rsf = parse("reveal.ts", rev);
  let posConsume = -1, posDecrypt = -1, posCharge = -1, posPin = -1, posPolicy = -1;
  (function w(n) { if (ts.isCallExpression(n)) { const c = n.expression.getText(rsf); const p = n.getStart(rsf); if (/consumeRevealToken$/.test(c) && posConsume < 0) posConsume = p; if (/hasNoEntityPin$/.test(c) && posPin < 0) posPin = p; if (c === "decryptSeedPhrase" && posDecrypt < 0) posDecrypt = p; if (c === "chargeCredits" && posCharge < 0) posCharge = p; if (/selectOrgSeedRevealBlock$/.test(c) && posPolicy < 0) posPolicy = p; } ts.forEachChild(n, w); })(rsf);
  chk("step-up:reveal-use-case-checks-pin-state-and-consumes-the-single-use-token-before-decrypting", posPin > 0 && posConsume > posPin && posDecrypt > posConsume, canon({ posPin, posConsume, posDecrypt }));
  chk("credits:charge-happens-only-after-a-successful-decrypt", posCharge > posDecrypt && posDecrypt > 0, canon({ posDecrypt, posCharge }));
  chk("org-policy:reveal-use-case-consults-the-organization-seed-reveal-policy-before-decrypting", posPolicy > 0 && posPolicy < posDecrypt, canon({ posPolicy, posDecrypt }));
  chk("audit:seed-reveal-is-audited-via-logVaultActivity(seed_revealed)", /logVaultActivity\(id, userId, "seed_revealed"\)/.test(rev));
  const repo = rd(overlay, R("vault/infrastructure/repositories/secret-repository.ts")) ?? ""; const wheres = [...repo.matchAll(/\.where\(([^;]*)\)/g)].map((m) => m[1]);
  chk("tenant-scope:every-secret-repository-write-filters-by-owner-user-id", wheres.length >= 2 && wheres.every((w) => /userId/.test(w)), `${wheres.length} where() clauses`);
  chk("tenant-scope:org-membership-lookup-is-parameterised-and-scoped-to-the-user", /organization_members/.test(repo) && /user_id\s*=\s*\$\{/.test(repo.replace(/\s+/g, " ")));
  const leaks = []; for (const f of ["vault/application/secret/reveal.ts", "vault/application/secret/wallet.ts", "vault/infrastructure/repositories/secret-repository.ts", "vault/crypto/field-encryption.ts"]) {
    const t = rd(overlay, R(f)) ?? ""; const sf = parse(f, t);
    (function w(n) { if (ts.isCallExpression(n) && /^(console|logger|log)\.\w+$/.test(n.expression.getText(sf))) { const a = n.arguments.map((x) => x.getText(sf)).join(" "); if (/plaintext|seedPhrase|decrypted|privateKey|\bdek\b|encSeed|wrapped_dek/i.test(a)) leaks.push(`${f}:${lineOf(sf, n.getStart(sf))}`); } ts.forEachChild(n, w); })(sf);
  }
  chk("logging:no-plaintext-secret-key-material-passed-to-console-or-logger", leaks.length === 0, leaks.join(", "));
  const rt = routeGate(overlay);
  chk("access:secret-route-middleware-chains-are-the-sealed-chains (auth, ownership PDP, credit meter)", !rt.violations.some((x) => /middleware chain|must delegate/.test(x)), rt.violations.filter((x) => /middleware chain|must delegate/.test(x)).join(" | "));
  const wal = rd(overlay, R("vault/application/secret/wallet.ts")) ?? "";
  chk("access:drive-wallet-remains-write-once-and-tenant-scoped", /driveWallet|drive_wallet/i.test(wal) && /userId/.test(wal));
  return checks;
}

// ── 7. Seal / prerequisites / diff audit / typecheck ────────────────────────────────────────────────────────────────
function sealChecks(pre) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: String(details) });
  chk("seal:manifest-hash-matches-seal", sha256(MANIFEST_TEXT) === SEAL.tree_manifest_sha256);
  chk("seal:certified-by-05C-and-sub-phase-is-05D", SEAL.certified_by?.sub_phase === "VLT-GAP-05-C" && SEAL.sub_phase === SUB_PHASE);
  const bad = Object.entries(SEAL.frozen_files).filter(([n, v]) => !fs.existsSync(path.join(FROZEN_DIR, n)) || sha256File(path.join(FROZEN_DIR, n)) !== v.sha256 || (MANIFEST[v.source] !== undefined && MANIFEST[v.source] !== v.sha256));
  chk("seal:frozen-files-intact-and-equal-to-manifest", bad.length === 0 && Object.keys(SEAL.frozen_files).length === 6, bad.map(([n]) => n).join(", "));
  const cur = Object.fromEntries(walkFiles(path.join(ROOT, GAP), [], (p) => /\.mjs$/.test(p)).map((f) => [rel(f), sha256File(f)]));
  const edited = Object.entries(SEAL.gap_scripts_at_freeze).filter(([k, h]) => cur[k] !== h).map(([k]) => k);
  chk("seal:earlier-validators-and-harness-byte-identical-since-freeze", edited.length === 0 && Object.keys(SEAL.gap_scripts_at_freeze).length >= 30, edited.join(", "));
  const extra = Object.keys(cur).filter((k) => !(k in SEAL.gap_scripts_at_freeze) && !ALLOWED_NEW_SCRIPTS.has(k));
  chk("seal:no-unexpected-new-validator-scripts", extra.length === 0, extra.join(", "));
  const e05c = JSON.parse(fs.readFileSync(path.join(EVID, "baseline-05c/SEAL.json"), "utf8"));
  chk("seal:05-C-baseline-seal-still-intact", Boolean(e05c.frozen_consumers) && Object.keys(e05c.frozen_consumers).length >= 20);
  if (pre) chk("prerequisite:05-C-passes-on-a-copy-reconstructed-to-the-05-C-certified-state (re-runs 05-B differential through it)", pre.ok, pre.details);
  return checks;
}
function diffAudit(overlay = new Map()) {
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith(GAP)) now[k] = sha256File(f); }
  for (const [k, t] of overlay) if (!k.startsWith(GAP)) { if (t === null) delete now[k]; else now[k] = sha256(t); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in MANIFEST)) added.push(k); else if (MANIFEST[k] !== v) changed.push(k); }
  for (const k of Object.keys(MANIFEST)) if (!(k in now)) removed.push(k);
  // docs/ is outside the manifest (walkFiles skips it): compare it against the frozen copies directly
  const docChanged = Object.values(SEAL.frozen_files).filter((v) => v.source.startsWith("docs/")).filter((v) => { const t = rd(overlay, v.source); return t === null || sha256(t) !== v.sha256; }).map((v) => v.source);
  const allowedChanged = new Set(RETIRE_FILES.edited.filter((f) => !f.startsWith("docs/"))); const allowedRemoved = new Set(RETIRE_FILES.deleted);
  const allowedAdded = new Set([".gitignore"]); // repository metadata added when git was set up; carries no source
  const unexpected = [...changed.filter((k) => !allowedChanged.has(k)), ...added.filter((k) => !allowedAdded.has(k)), ...removed.filter((k) => !allowedRemoved.has(k))];
  return { changed, added, removed, doc_changed: docChanged, unexpected, files_compared: Object.keys(MANIFEST).length };
}
const runNode = (script, cwd, args = []) => { const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: process.env, timeout: 1200000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
function prerequisite05C() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-05d-c-")); let full = { status: null, out: "" }; let ev = null;
  try {
    fs.cpSync(ROOT, tmp, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
    for (const f of ALLOWED_NEW_SCRIPTS) fs.rmSync(path.join(tmp, f), { force: true });
    fs.rmSync(path.join(tmp, ".gitignore"), { force: true }); // reconstruct the pre-git 05-C tree
    for (const [name, v] of Object.entries(SEAL.frozen_files)) { if (sha256File(path.join(FROZEN_DIR, name)) !== v.sha256) throw new Error(`sealed frozen file ${name} was edited`); fs.mkdirSync(path.dirname(path.join(tmp, v.source)), { recursive: true }); fs.copyFileSync(path.join(FROZEN_DIR, name), path.join(tmp, v.source)); }
    full = runNode(path.join(tmp, `${GAP}validate-vlt-gap-05-C.mjs`), tmp);
    const p = path.join(tmp, "reports/antas/vault/gap/VLT-GAP-05/consumer-graph.json"); ev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const failing = ev ? ev.checks.filter((c) => !c.passed).map((c) => c.name) : ["<no evidence>"];
  const ok = full.status === 0 && ev?.status === "PASS" && failing.length === 0 && ev.consumers_migrated?.length >= 20 && ev.tests?.prerequisite_05B?.differential_cases >= 51 && ev.tests.prerequisite_05B.differential_passed === ev.tests.prerequisite_05B.differential_cases;
  return { ok, details: ok ? `05-C PASS on reconstructed tree (${ev.consumers_migrated.length} consumers, 05-B differential ${ev.tests.prerequisite_05B.differential_passed}/${ev.tests.prerequisite_05B.differential_cases}, ${ev.tests.mutation_self_tests_passed}/${ev.tests.mutation_self_tests} mutations)` : `exit=${full.status} failing=${failing.join(", ")} ${full.out.slice(-200)}`, c_tests: ev?.tests ?? null };
}
function typecheck() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const roots = [...new Set([...CONSUMERS, `${OWNER}.ts`, ROUTE, R("vault/application/secret/reveal.ts"), R("vault/application/secret/wallet.ts")])].map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  const prog = ts.createProgram(roots, opts); const tally = {}; const syntactic = []; const relUnresolved = [];
  for (const f of roots) { const sf = prog.getSourceFile(f); if (sf) for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
  for (const sf of prog.getSourceFiles()) {
    if (!roots.includes(sf.fileName)) continue;
    for (const d of prog.getSemanticDiagnostics(sf)) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      if ([2307, 2792].includes(d.code)) { const mm = msg.match(/module '([^']+)'/) ?? msg.match(/'([^']+)'/); if (mm && mm[1].startsWith(".")) { relUnresolved.push(`${rel(sf.fileName)}: ${mm[1]}`); continue; } if (mm) { tally.__external_unresolved = (tally.__external_unresolved ?? 0) + 1; continue; } }
      const k = `${d.code}`; tally[k] = (tally[k] ?? 0) + 1;
    }
  }
  const tot = Object.values(tally).reduce((a, b) => a + b, 0);
  return { mode: "degraded (project dependencies are not installed in the upload; full tsc/build was NOT executed)", files: roots.length, diagnostics_total: tot, syntactic_errors: syntactic, unresolved_relative_modules: relUnresolved };
}

// ── 8. Full static gate (overlay-parameterised so mutation tests run the real code) ─────────────────────────────────
function staticGate(overlay = new Map()) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  const rf = rd(overlay, `${COMPAT}.ts`);
  chk("retirement:lib/vault-crypto.ts-no-longer-exists", rf === null, rf === null ? "" : "file present");
  const refs = referenceScan(overlay);
  chk("retirement:no-import-reexport-dynamic-import-or-require-of-the-retired-adapter-anywhere-in-the-repo", refs.importers.length === 0, refs.importers);
  chk("retirement:no-string-or-identifier-reference-to-the-retired-path-in-code (mock/resolve/require-by-string)", refs.stringRefs.length === 0, refs.stringRefs);
  const cfg = configScan(overlay);
  chk("retirement:no-build-config-or-manifest-references-the-retired-path (json/yaml/toml)", cfg.length === 0, cfg);
  const mm = migrationMap(overlay);
  chk("retirement:migration-map-and-generated-docs-agree-with-the-actual-tree", mm.problems.length === 0 && mm.rows.length >= 4, mm.problems.join(" | "));
  const oc = ownerChecks(overlay);
  chk("owner:exists-and-exports-all-seven-public-functions", oc.present && OWNER_NAMES.every((n) => oc.names.includes(n)), oc.names.join(","));
  chk("owner:imports-only-crypto-@workspace/db-drizzle-orm (lowest layer) and reaches no consumer (no cycle)", oc.imports.every((s) => ["crypto", "@workspace/db", "drizzle-orm"].includes(s)) && oc.cycle.length === 0, canon({ imports: oc.imports, cycle: oc.cycle }));
  chk("owner:header-no-longer-claims-a-live-compatibility-adapter", oc.present && !oc.claimsAdapter);
  const co = consumerOwnership(overlay);
  chk("consumers:all-27-sealed-consumers-still-import-the-owner-and-only-existing-names", co.bad.length === 0 && co.rows.length === CONSUMERS.length && CONSUMERS.length >= 20, co.bad.slice(0, 5).join(" | "));
  const rg = routeGate(overlay);
  chk("routes/vault.ts:old-route-is-an-adapter (no DB, crypto, provider or credit logic; secret handlers are exact delegations)", rg.violations.length === 0, rg.violations.slice(0, 6).join(" | "));
  const sg = serviceGate(overlay);
  chk("services/vault/src/index.mjs:pure-composition-root-and-compat-shims-are-pure-re-exports", sg.violations.length === 0, sg.violations.slice(0, 6).join(" | "));
  const dup = duplicateScan(overlay);
  chk("duplicates:no-second-implementation-of-the-crypto-owner (names or token-identical bodies)", dup.redeclared_owner_names.length === 0 && dup.owner_function_matches.length === 0 && dup.owner_functions >= 8, canon({ names: dup.redeclared_owner_names, bodies: dup.owner_function_matches, owner_functions: dup.owner_functions }));
  chk("duplicates:secret-use-cases-declared-only-in-vault/application/secret", dup.redeclared_use_cases.length === 0, dup.redeclared_use_cases);
  chk("duplicates:every-deferred-copy-manages-a-different-key-chain-namespace-than-the-vault-owner", dup.deferred_copy_same_namespace.length === 0, canon(dup.deferred_copy_namespaces));
  chk("duplicates:no-copy-of-the-four-old-secret-route-handler-bodies-anywhere", dup.old_handler_body_copies.length === 0 && dup.old_handlers_fingerprinted === 4, canon({ copies: dup.old_handler_body_copies, fingerprinted: dup.old_handlers_fingerprinted }));
  const sec = securityChecks(overlay); for (const c of sec) checks.push(c);
  return { checks, refs, cfg, mm, oc, co, rg, sg, dup, sec };
}

// ── 9. Mutation self-tests: every mutation runs the REAL gate code on an overlay ────────────────────────────────────
async function selfTests() {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed: Boolean(passed), details });
  const cur = (rp) => fs.readFileSync(path.join(ROOT, rp), "utf8");
  const failing = (ov, rx) => staticGate(ov).checks.filter((c) => !c.passed).some((c) => rx.test(c.name));
  const passing = (ov, rx) => staticGate(ov).checks.filter((c) => rx.test(c.name)).every((c) => c.passed);
  const swap = (f, a, b) => { const x = cur(f); const y = x.split(a).join(b); return y === x ? null : y; };
  const anchor = (n, v) => t(`selftest:mutation-anchor-${n}`, v !== null);
  const zz = R("routes/zz-new.ts"); const adapterSrc = frozenText("adapter__lib__vault-crypto.ts");
  t("selftest:baseline-gate-is-green-before-mutating", staticGate().checks.every((c) => c.passed));
  t("selftest:restoring-the-adapter-file-is-detected", failing(new Map([[`${COMPAT}.ts`, adapterSrc]]), /^retirement:lib\/vault-crypto\.ts-no-longer-exists/));
  t("selftest:new-static-importer-of-the-retired-adapter-is-detected", failing(new Map([[zz, 'import { encryptField } from "../lib/vault-crypto";\nexport const x = encryptField;\n']]), /^retirement:no-import/));
  t("selftest:new-reexport-of-the-retired-adapter-is-detected", failing(new Map([[zz, 'export { decryptField } from "../lib/vault-crypto";\n']]), /^retirement:no-import/));
  t("selftest:new-dynamic-import-of-the-retired-adapter-is-detected", failing(new Map([[zz, 'export async function f() { return import("../lib/vault-crypto"); }\n']]), /^retirement:no-import/));
  t("selftest:new-require-of-the-retired-adapter-is-detected", failing(new Map([[zz, 'const m = require("../lib/vault-crypto");\nexport default m;\n']]), /^retirement:no-import/));
  t("selftest:mock-by-string-of-the-retired-adapter-is-detected", failing(new Map([[zz, 'declare const jest: any;\njest.mock("../lib/vault-crypto");\n']]), /^retirement:no-string/));
  t("selftest:config-reference-to-the-retired-path-is-detected", failing(new Map([["artifacts/api-server/zz-config.json", '{"entry":"src/lib/vault-crypto.ts"}']]), /^retirement:no-build-config/));
  t("selftest:negative-control-comment-only-mention-passes", passing(new Map([[zz, "// historical: lib/vault-crypto.ts was the adapter\nexport const ok = 1;\n"]]), /^retirement:no-(import|string)/));
  t("selftest:migration-map-saying-compatibility-preserved-for-a-deleted-file-is-detected", failing(new Map([["docs/antas/vault/file-migration-map.md", cur("docs/antas/vault/file-migration-map.md").replace("RETIRED (VLT-GAP-05-D)", "compatibility-preserved")]]), /^retirement:migration-map/));
  t("selftest:generator-regressing-to-the-live-row-is-detected", failing(new Map([["scripts/antas/vault/build-certification.mjs", cur("scripts/antas/vault/build-certification.mjs").replace("RETIRED (VLT-GAP-05-D)", "compatibility-preserved")]]), /^retirement:migration-map/));
  t("selftest:architecture-doc-presenting-the-adapter-as-live-is-detected", failing(new Map([["docs/antas/vault/architecture.md", cur("docs/antas/vault/architecture.md").replace("(`lib/vault-crypto.ts` retired in VLT-GAP-05-D)", "and `lib/vault-crypto.ts`")]]), /^retirement:migration-map/));
  let m = swap(R("routes/teams.ts"), "field-encryption", "seed-phrase"); anchor("consumer", m);
  if (m) t("selftest:consumer-pointed-at-a-different-module-is-detected", failing(new Map([[R("routes/teams.ts"), m]]), /^consumers:all-27/));
  t("selftest:deleted-owner-is-detected", failing(new Map([[`${OWNER}.ts`, null]]), /^owner:/));
  m = swap(`${OWNER}.ts`, "export function decryptRows", "function decryptRows"); anchor("owner-export", m);
  if (m) t("selftest:owner-missing-a-public-name-is-detected", failing(new Map([[`${OWNER}.ts`, m]]), /^(owner:exists|consumers:all-27)/));
  m = cur(`${OWNER}.ts`) + '\nimport "../../routes/teams";\n'; t("selftest:owner-importing-a-consumer-is-detected", failing(new Map([[`${OWNER}.ts`, m]]), /^owner:imports-only/));
  m = swap(`${OWNER}.ts`, "former lib/vault-crypto.ts compatibility adapter was retired", "legacy lib/vault-crypto.ts path remains a compatibility adapter for consumers that have not moved yet. (x) was retired"); anchor("owner-header", m);
  if (m) t("selftest:owner-header-claiming-a-live-adapter-is-detected", failing(new Map([[`${OWNER}.ts`, m]]), /^owner:header/));
  m = swap(`${OWNER}.ts`, '"aes-256-gcm", key, iv', '"aes-128-gcm", key, iv'); anchor("cipher", m);
  if (m) t("selftest:cipher-change-in-the-owner-is-detected-by-token-identity", failing(new Map([[`${OWNER}.ts`, m]]), /^crypto:owner-code-token-identical/));
  m = swap(R("routes/vault.ts"), "await revealSeedPhrase(", "await revealX("); anchor("route-delegation", m);
  if (m) t("selftest:secret-route-no-longer-delegating-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = swap(R("routes/vault.ts"), "const out = await validateSecretKey(req.body);", "const out = await validateSecretKey(req.body); const rows = await db.select().from(vaultEntriesTable);"); anchor("route-db", m);
  if (m) t("selftest:db-query-added-to-a-route-handler-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = swap(R("routes/vault.ts"), "const r = await listEntities(req.user!.userId);", "const r = await listEntities(req.user!.userId); if (r.status === 200) { r.body = decryptField(r.body); }"); anchor("route-crypto", m);
  if (m) t("selftest:crypto-call-and-decision-branch-added-to-a-route-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = swap(R("routes/vault.ts"), 'requireCreditBalance("sylo.credential_access"), ', ""); anchor("route-mw", m);
  if (m) t("selftest:removed-credit-middleware-on-the-reveal-route-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = swap(R("routes/vault.ts"), 'import { createEntity }', 'import { encryptField } from "../vault/crypto/field-encryption";\nimport { createEntity }'); anchor("route-import", m);
  if (m) t("selftest:route-importing-the-crypto-owner-directly-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = cur(ROUTE) + "\nfunction decryptSeed(x: string) { return x; }\n"; t("selftest:new-business-function-in-the-old-route-file-is-detected", failing(new Map([[ROUTE, m]]), /^routes\/vault\.ts/));
  m = swap(SVC, "const handle = createVaultHttpHandler({ ...dependencies, vaultCrypto, vaultAccess });", "const handle = createVaultHttpHandler({ ...dependencies, vaultCrypto, vaultAccess });\nfunction encryptSecret(v) { return Buffer.from(v); }"); anchor("svc", m);
  if (m) t("selftest:business-function-in-the-service-composition-root-is-detected", failing(new Map([[SVC, m]]), /^services\/vault/));
  m = swap(SVC, 'const allowMemoryState = process.env.ALLOW_SERVICE_MEMORY_STORE === "true";', 'let allowMemoryState = false; if (process.env.X) { allowMemoryState = true; }'); anchor("svc-flow", m);
  if (m) t("selftest:control-flow-in-the-service-composition-root-is-detected", failing(new Map([[SVC, m]]), /^services\/vault/));
  t("selftest:service-shim-with-logic-is-detected", failing(new Map([["services/vault/src/crypto.mjs", cur("services/vault/src/crypto.mjs") + "\nexport const x = () => 1;\n"]]), /^services\/vault/));
  const ownerFn = cur(`${OWNER}.ts`).match(/export function encryptField[\s\S]*?\n}\n/)[0].replace("export function encryptField", "export function myEncrypt");
  t("selftest:token-identical-copy-of-an-owner-function-elsewhere-is-detected", failing(new Map([[R("lib/zz-copy.ts"), `import crypto from "crypto";\nconst PREFIX = "enc:"; let ready = false; let activeVersion: number | null = null; const dekCache = new Map<number, Buffer>(); const LEGACY_KEY = Buffer.alloc(32); function aesEncrypt(k: Buffer, p: string): string { return p; }\n${ownerFn}\n`]]), /^duplicates:no-second-implementation/) || failing(new Map([[R("lib/zz-copy.ts"), "export function decryptField(v: string) { return v; }\n"]]), /^duplicates:no-second-implementation/));
  t("selftest:redeclared-owner-function-name-is-detected", failing(new Map([[R("lib/zz-copy.ts"), "export function encryptField(v: string) { return v; }\n"]]), /^duplicates:no-second-implementation/));
  t("selftest:redeclared-secret-use-case-is-detected", failing(new Map([[R("lib/zz-copy.ts"), "export async function revealSeedPhrase() { return 1; }\n"]]), /^duplicates:secret-use-cases/));
  const oldBody = (() => { const bt = fs.readFileSync(path.join(EVID, "baseline/sources/artifacts__api-server__src__routes__vault.ts"), "utf8"); const i = bt.indexOf('router.post("/vault/validate-key"'); return i < 0 ? null : bt.slice(i, bt.indexOf("\n});\n", i) + 5); })();
  if (oldBody) t("selftest:pasted-copy-of-an-old-secret-handler-body-is-detected", failing(new Map([[R("routes/zz-copy.ts"), `import { Router } from "express";\nconst router = Router();\n${oldBody}\nexport default router;\n`]]), /^duplicates:no-copy/));
  else t("selftest:mutation-anchor-old-body", false, "old handler not found in sealed baseline");
  t("selftest:unlisted-file-change-is-detected-by-diff-audit", diffAudit(new Map([[R("routes/vault.ts"), cur(ROUTE) + "\n// x\n"]])).unexpected.includes(ROUTE));
  t("selftest:unlisted-new-file-is-detected-by-diff-audit", diffAudit(new Map([[R("lib/zz-new.ts"), "export {};\n"]])).unexpected.includes(R("lib/zz-new.ts")));
  t("selftest:deleting-another-file-is-detected-by-diff-audit", diffAudit(new Map([[R("lib/jwt-keys.ts"), null]])).unexpected.includes(R("lib/jwt-keys.ts")));
  const sc = securityChecks(new Map([[R("vault/application/secret/reveal.ts"), cur(R("vault/application/secret/reveal.ts")).replace(/const plaintext = decryptSeedPhrase\(encSeed as string\);/, "const plaintext = decryptSeedPhrase(encSeed as string);")]]));
  t("selftest:negative-control-unchanged-reveal-use-case-passes-security-checks", sc.every((c) => c.passed));
  m = swap(R("vault/application/secret/reveal.ts"), "const plaintext = decryptSeedPhrase(encSeed as string);", 'console.log("revealed", encSeed);\n  const plaintext = decryptSeedPhrase(encSeed as string);'); anchor("log", m);
  if (m) t("selftest:logging-secret-material-is-detected", securityChecks(new Map([[R("vault/application/secret/reveal.ts"), m]])).some((c) => !c.passed && /^logging:/.test(c.name)));
  m = swap(R("vault/infrastructure/repositories/secret-repository.ts"), "eq(vaultEntriesTable.userId, userId)", "eq(vaultEntriesTable.id, id)"); anchor("tenant", m);
  if (m) t("selftest:dropped-tenant-predicate-is-detected", securityChecks(new Map([[R("vault/infrastructure/repositories/secret-repository.ts"), m]])).some((c) => !c.passed && /^tenant-scope:/.test(c.name)));
  const broken = (() => { const x = cur(`${OWNER}.ts`).replace('return (PREFIX + "v" + activeVersion + ":" + aesEncrypt(dekCache.get(activeVersion)!, String(value))) as T;', 'return (PREFIX + "v" + activeVersion + ":" + aesEncrypt(LEGACY_KEY, String(value))) as T;'); return x === cur(`${OWNER}.ts`) ? null : x; })();
  anchor("exec", broken);
  if (broken) { const cases = await executedCryptoBehavior(broken); t("selftest:behavior-regression-in-the-owner-is-detected-by-the-executed-tests (versioned encrypt using the legacy key)", cases.some((c) => !c.passed)); }
  const good = await executedCryptoBehavior(); t("selftest:negative-control-real-owner-passes-every-executed-case", good.every((c) => c.passed) && good.length >= 15, `${good.length} cases`);
  return out;
}
function bypassAttempts() {
  const tries = [{ name: "flag --skip-tests", args: ["--skip-tests"], env: {} }, { name: "flag --force-pass", args: ["--force-pass"], env: {} }, { name: "flag --ignore-failures", args: ["--ignore-failures"], env: {} }, { name: "flag --continue-on-error", args: ["--continue-on-error"], env: {} }, { name: "unknown flag --whatever", args: ["--whatever"], env: {} }, { name: "env ANTAS_BYPASS=true", args: [], env: { ANTAS_BYPASS: "true" } }, { name: "env VALIDATION_DISABLED=true", args: [], env: { VALIDATION_DISABLED: "true" } }];
  return tries.map((tr) => { const r = spawnSync(process.execPath, [HERE, ...tr.args], { encoding: "utf8", env: { ...process.env, ...tr.env }, timeout: 60000 }); return { attempt: tr.name, exit_code: r.status, rejected: r.status === 1 && /bypass mechanism rejected/.test(r.stderr ?? "") }; });
}

// ── 10. Evidence ────────────────────────────────────────────────────────────────────────────────────────────────────
const symbolFps = (text, fileRel) => { const sf = parse(fileRel, text); return sf.statements.filter((s) => !ts.isImportDeclaration(s)).map((s) => { const name = ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) ? s.name?.text : ts.isVariableStatement(s) ? s.declarationList.declarations.map((d) => d.name.getText(sf)).join(",") : ts.SyntaxKind[s.kind]; const tk = []; (function z(x) { if (ts.isJSDoc(x)) return; if (x.getChildCount(sf) === 0) { if (x.kind !== ts.SyntaxKind.EndOfFileToken) tk.push(x.getText(sf)); } else x.getChildren(sf).forEach(z); })(s); return { name, lines: [lineOf(sf, s.getStart(sf)), lineOf(sf, s.end)], tokens: tk.length, fingerprint: sha256(tk.join(" ")) }; }); };
function sourceHashes() {
  const files = [ROUTE, SVC, `${OWNER}.ts`, R("vault/application/secret/reveal.ts"), R("vault/application/secret/wallet.ts"), R("vault/infrastructure/repositories/secret-repository.ts"), ...CONSUMERS, "docs/antas/vault/file-migration-map.md", "docs/antas/vault/architecture.md", "docs/antas/vault/db-touch-inventory.md", "scripts/antas/vault/build-certification.mjs", `${GAP}harness.mjs`, `${GAP}gap-common.mjs`, `${GAP}freeze-vlt-gap-05-D-baseline.mjs`, rel(SEAL_FILE), rel(MANIFEST_FILE)];
  const out = Object.fromEntries([...new Set(files)].map((f) => [f, sha256File(path.join(ROOT, f))])); out[`${COMPAT}.ts`] = "ABSENT"; return out;
}
const writeEv = (name, obj) => { const txt = `${JSON.stringify(obj, null, 2)}\n`; fs.writeFileSync(path.join(EVID, name), txt); return sha256(txt); };
function verifyMode() {
  if (!fs.existsSync(GATE_FILE)) fail("evidence missing: run the validator first");
  const ev = JSON.parse(fs.readFileSync(GATE_FILE, "utf8")); const b = binding(sourceHashes()); const p = [];
  if (ev.sub_phase !== SUB_PHASE) p.push("sub_phase mismatch");
  if (ev.commit_sha !== b.commit_sha) p.push("commit_sha mismatch");
  if (ev.source_tree_sha256 !== b.source_tree_sha256) p.push("source changed since evidence (stale)");
  if (ev.validator_sha256 !== sha256File(HERE)) p.push("different validator version");
  const body = { ...ev }; delete body.evidence_body_sha256; delete body.generated_at;
  if (sha256(JSON.stringify(body)) !== ev.evidence_body_sha256) p.push("evidence body edited after generation");
  for (const f of EVIDENCE_FILES) { const fp = path.join(EVID, f); if (!fs.existsSync(fp)) p.push(`${f} missing`); else if (sha256File(fp) !== ev.evidence_file_sha256?.[f]) p.push(`${f} changed after generation`); }
  if (ev.status !== "PASS") p.push(`recorded status ${ev.status}`);
  if (p.length) fail(`evidence rejected: ${p.join("; ")}`);
  console.log(`${SUB_PHASE} evidence verified (${b.commit_binding})`);
}
async function main() {
  if (process.argv.includes("--verify")) { verifyMode(); return; }
  const started = Date.now(); globalThis.__nodeCrypto = (await import("node:crypto")).default;
  const pre = prerequisite05C(); const g = staticGate(); const exec = await executedCryptoBehavior(); const audit = diffAudit(); const tc = typecheck();
  const selft = await selfTests(); const bypassRes = bypassAttempts();
  const checks = [...sealChecks(pre), ...g.checks];
  checks.push({ name: "behavior:owner-executed-legacy-versioned-rotation-tamper-and-passthrough-cases-all-pass (real node:crypto, in-memory key table)", passed: exec.every((c) => c.passed) && exec.length >= 15, details: canon(exec.filter((c) => !c.passed)) });
  checks.push({ name: "diff-audit:only-the-adapter-deletion-owner-comment-and-the-four-doc/generator-lines-changed", passed: audit.unexpected.length === 0 && audit.removed.includes(`${COMPAT}.ts`) && audit.changed.includes(`${OWNER}.ts`) && RETIRE_FILES.edited.filter((f) => f.startsWith("docs/")).every((f) => audit.doc_changed.includes(f)) && audit.changed.includes("scripts/antas/vault/build-certification.mjs"), details: canon(audit) });
  checks.push({ name: "typecheck:no-syntax-errors-and-no-unresolved-relative-module-in-consumers-owner-or-secret-use-cases", passed: tc.syntactic_errors.length === 0 && tc.unresolved_relative_modules.length === 0, details: canon({ syntactic: tc.syntactic_errors, unresolved: tc.unresolved_relative_modules }) });
  for (const r of selft) checks.push(r);
  checks.push({ name: "selftest:coverage-at-least-40-mutations-executed", passed: selft.length >= 40, details: `${selft.length}` });
  checks.push({ name: "bypass:every-bypass-attempt-is-rejected-by-the-validator-itself", passed: bypassRes.length >= 7 && bypassRes.every((b) => b.rejected), details: canon(bypassRes.filter((b) => !b.rejected)) });
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const bd = binding(hashes); const stamp = { phase: PHASE, sub_phase: SUB_PHASE, commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256, validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE) };
  fs.mkdirSync(EVID, { recursive: true });
  // old-source-fingerprint: the three roadmap sources exactly as they were BEFORE GAP-05 (sealed pre-extraction baseline) and as 05-C certified them
  const baseSrc = (n) => path.join(EVID, "baseline/sources", n);
  const oldFiles = [[ROUTE, "artifacts__api-server__src__routes__vault.ts"], [SVC, "services__vault__src__index.mjs"], [`${COMPAT}.ts`, "artifacts__api-server__src__lib__vault-crypto.ts"]];
  const oldFp = { ...stamp, description: "Roadmap source files for GAP-05 as sealed before extraction (baseline/sources) and as certified by 05-C", sources: oldFiles.map(([f, b]) => { const p = baseSrc(b); const tx = fs.readFileSync(p, "utf8"); return { file: f, pre_extraction_sha256: sha256File(p), pre_extraction_lines: tx.split("\n").length, pre_extraction_symbols: symbolFps(tx, f).length, certified_by_05C_sha256: f === `${COMPAT}.ts` ? SEAL.frozen_files["adapter__lib__vault-crypto.ts"].sha256 : MANIFEST[f] }; }) };
  const curRoute = fs.readFileSync(path.join(ROOT, ROUTE), "utf8");
  const newFp = { ...stamp, description: "Current owner of every GAP-05 behavior and the state of each old source", old_sources_now: [{ file: ROUTE, role: "route adapter", sha256: sha256(curRoute), lines: curRoute.split("\n").length, symbols: symbolFps(curRoute, ROUTE) }, { file: SVC, role: "composition root", sha256: sha256File(path.join(ROOT, SVC)), statements: g.sg.statements }, { file: `${COMPAT}.ts`, role: "RETIRED (file deleted)", exists: false }], owners: [`${OWNER}.ts`, R("vault/application/secret/reveal.ts"), R("vault/application/secret/wallet.ts"), R("vault/infrastructure/repositories/secret-repository.ts")].map((f) => ({ file: f, sha256: sha256File(path.join(ROOT, f)), symbols: symbolFps(fs.readFileSync(path.join(ROOT, f), "utf8"), f) })), consumers_of_owner: g.co.rows, retired_adapter_symbols: OWNER_NAMES.map((n) => ({ symbol: n, old: `${COMPAT}.ts#${n} (re-export)`, owner: `${OWNER}.ts#${n}` })) };
  const thin = { ...stamp, file: ROUTE, summary: { handlers: g.rg.handlers.length, thin_adapters: g.rg.handlers.filter((h) => h.classification === "thin-adapter" || h.classification === "secret-adapter").length, deferred: g.rg.handlers.filter((h) => h.classification.startsWith("deferred")).length, response_mapping: g.rg.handlers.filter((h) => h.classification === "response-mapping").length, lines: g.rg.lines, db_sites: g.rg.db_sites.length, db_sites_outside_deferred_runner: g.rg.db_sites.filter((d) => !d.in_deferred_health_runner).length }, handlers: g.rg.handlers, top_level_symbols: g.rg.symbols, db_sites: g.rg.db_sites, deferrals: Object.entries(DEFERRED_HANDLERS).map(([route, gap]) => ({ route, deferred_to: gap, reason: "health evaluation is owned by the GAP-11 health module; verified free of every secret identifier and column" })), service_composition_root: g.sg, violations: g.rg.violations };
  const dupEv = { ...stamp, ...g.dup, adapter_retired: !exists(`${COMPAT}.ts`), importers_of_retired_adapter: g.refs.importers, code_references_to_retired_path: g.refs.stringRefs, comment_only_mentions: g.refs.commentOnly, comment_only_note: "Comments naming the retired path are documentation, not code; the generated docs/map were updated, historical change-logs and script comments are intentionally left as history.", config_references: g.cfg, duplicate_implementations: [...g.dup.owner_function_matches, ...g.dup.redeclared_owner_names, ...g.dup.redeclared_use_cases, ...g.dup.old_handler_body_copies] };
  const beh = { ...stamp, prerequisite_05C_on_reconstructed_tree: { ok: pre.ok, details: pre.details, tests: pre.c_tests }, executed_owner_cases: exec, owner_token_identity_to_05C_sealed_owner: g.sec.find((c) => /^crypto:owner-code-token-identical/.test(c.name)), consumers_still_importing_owner: g.co.rows.length };
  const secEv = { ...stamp, checks: g.sec, executed_tamper_and_passthrough_cases: exec.filter((c) => /^(tamper|passthrough|no-leak)/.test(c.name)) };
  const files = { "old-source-fingerprint.json": oldFp, "new-source-fingerprint.json": newFp, "route-thinness.json": thin, "duplicate-implementation.json": dupEv, "behavior-regression.json": beh, "security-regression.json": secEv };
  const evFileHashes = Object.fromEntries(Object.entries(files).map(([n, o]) => [n, writeEv(n, o)]));
  const gate = {
    ...stamp, source_hashes: hashes,
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(SEAL_FILE), sealed_at: SEAL.sealed_at, tree_manifest_sha256: SEAL.tree_manifest_sha256, certified_by: SEAL.certified_by },
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-05-D.mjs", "node scripts/antas/vault/gap/validate-vlt-gap-05-C.mjs (full run on a temp copy reconstructed to the 05-C-certified state; runs 05-B differential inside)", "in-process AST retirement/thinness/duplicate/security gate, executed crypto cases, mutation self-tests, differential typecheck, child-process bypass attempts"],
    exit_codes: { prerequisite_05C_reconstructed: pre.ok ? 0 : 1, executed_owner_cases: exec.every((c) => c.passed) ? 0 : 1, mutation_self_tests: selft.every((r) => r.passed) ? 0 : 1, bypass_attempts: bypassRes.every((b) => b.rejected) ? 0 : 1, typecheck_degraded: tc.syntactic_errors.length || tc.unresolved_relative_modules.length ? 1 : 0 },
    symbols_moved: [], retired: [{ file: `${COMPAT}.ts`, kind: "pure re-export compatibility adapter", importers_remaining: g.refs.importers.length, replaced_by: `${OWNER}.ts` }],
    consumers_migrated: [], old_business_symbols_remaining: g.rg.symbols.filter((s) => s.deferred_to).map((s) => `${ROUTE}#${s.name} (deferred to ${s.deferred_to})`),
    duplicate_implementations: dupEv.duplicate_implementations, deferred_carry_overs: [...Object.entries(DEFERRED_HANDLERS).map(([r, gap]) => ({ item: `${r} + runHealthCheck/toHealthInput in routes/vault.ts`, deferred_to: gap })), { item: "single-use reveal-token store (routes/vault-security.ts) injected as a port", deferred_to: "VLT-GAP-06" }, { item: "key-rotation scripts keep their own copies of the envelope code (scripts/src/reencrypt-*.ts, rewrap-encryption-keys.ts); they are standalone operator tools", deferred_to: "VLT-GAP-07", copies_detected: g.dup.deferred_copies }, { item: "organization_extension_policies.disable_seed_reveal writer in routes/organizations.ts", deferred_to: "recorded carry-over (no GAP-05 owner)" }, { item: "snapshot/restore and schema DDL for secret columns", deferred_to: "VLT-GAP-09 / VLT-GAP-12" }],
    evidence_files: EVIDENCE_FILES, evidence_file_sha256: evFileHashes,
    diff_audit: audit, typecheck: tc,
    tests: { executed_owner_cases: exec.length, executed_owner_cases_passed: exec.filter((c) => c.passed).length, mutation_self_tests: selft.length, mutation_self_tests_passed: selft.filter((r) => r.passed).length, bypass_attempts_rejected: bypassRes.filter((b) => b.rejected).length, prerequisite_05C: pre.c_tests },
    notes: [
      "05-D retires lib/vault-crypto.ts: after 05-C it was a pure `export { … } from owner` file with zero importers. It is deleted; the migration map, its generator and the architecture/inventory docs now say RETIRED → vault/crypto/field-encryption.ts.",
      "routes/vault.ts is byte-identical to the 05-C-certified file. Every one of its 36 handlers was re-parsed: 33 are exact 'await useCase(); res.status().json()' delegations, 1 is a response mapping, 2 are the GAP-11 health handlers. The only DB access left in the file is the GAP-11 health runner, which is verified free of every secret identifier and column.",
      "services/vault/src/index.mjs is byte-identical and is a pure composition root (imports, wiring consts, createServiceServer(...).start()); the service's compat shims are pure re-exports of the owned modules. The service and API crypto envelopes remain separate and non-interoperable (05-A finding) — a design decision, not changed here.",
      "The crypto owner is code-identical (token stream) to the 05-C-sealed owner — only its header comment changed — and was executed for legacy, versioned, rotation, tamper and passthrough behavior.",
      "Earlier validators' source-bound evidence for files that GAP-05-C rewired, and 05-C's own in-place --verify, legitimately no longer verify after the adapter is deleted (05-C's evidence binds the deleted file's hash). 05-D therefore re-runs 05-C on a reconstructed copy instead of verifying it in place.",
      "Full tsc/build and the repo's own test suites cannot run here (dependencies are not installed); the typecheck is degraded and the behavior proofs are the harness-executed cases above. Run the repo build and test suites in CI before certifying.",
      "Comment-only mentions of lib/vault-crypto.ts in historical change logs, SQL migration comments and script/schema doc comments were left untouched; they are listed in duplicate-implementation.json.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL", checks,
  };
  const body = { ...gate }; delete body.generated_at; gate.generated_at = new Date().toISOString(); gate.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.writeFileSync(GATE_FILE, `${JSON.stringify(gate, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${gate.status} — adapter-retired=${!exists(`${COMPAT}.ts`)} importers-left=${g.refs.importers.length} handlers=${g.rg.handlers.length} (deferred ${thin.summary.deferred}) db-outside-deferred=${thin.summary.db_sites_outside_deferred_runner} dup=${gate.duplicate_implementations.length} executed=${exec.filter((c) => c.passed).length}/${exec.length} selftests=${selft.filter((r) => r.passed).length}/${selft.length} bypass-rejected=${bypassRes.filter((b) => b.rejected).length}/${bypassRes.length} checks=${checks.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 400) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
