#!/usr/bin/env node
// VLT-GAP-16 — Duplicate / legacy implementation elimination (AST scan, classification, CI gate, self-test).
//   node validate-vlt-gap-16.mjs              scan the Vault source tree; write reports/antas/vault/gap/VLT-GAP-16/
//   node validate-vlt-gap-16.mjs --self-test  plant duplicates/legacy consumers in a temp tree and prove the scanner rejects them
// Findings (all must be 0 for PASS):
//   D1 duplicate business implementation  — same semantic fingerprint (locals/params alpha-renamed) in two places
//   L1 unexpected legacy consumer         — a file imports a legacy module that is not an allowed compat shim
//   L2 legacy source-of-truth             — a legacy-located file still owns logic (not a pure re-export shim)
//   C1 duplicate crypto logic             — AES/HKDF/cipher primitives outside the shared crypto owner
//   S1 duplicate security logic           — hashing/lockout/timing-safe policy outside vault/security + owners
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, rel, rejectBypass, sha256, sha256File } from "./gap-common.mjs";
import { loadTs } from "./harness.mjs";

const GAP = "VLT-GAP-16";
const OUT_DIR = path.join(ROOT, "reports/antas/vault/gap", GAP);
const argv = process.argv.slice(2);
const bad = rejectBypass(["--self-test", "--root"]).filter((b) => !/^unknown flag --root$/.test(b) && !/^arg --root/.test(b));
const ri = argv.indexOf("--root");
const SELF_TEST = argv.includes("--self-test");
if (ri >= 0 && (!argv[ri + 1] || argv[ri + 1].startsWith("-"))) { console.error("VLT-GAP-16 FAIL — --root needs a directory (fail closed)"); process.exit(1); }
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const ts = loadTs(ROOT);
if (!ts) fail("typescript compiler not found (fail closed)");

// ── config ──────────────────────────────────────────────────────────────────────────────────────────────────────
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/antas/vault/gap/gap-configs/vault-duplicates.json"), "utf8"));
const MIN_STATEMENTS = CFG.min_statements, MIN_CHARS = CFG.min_normalized_chars;
const re = (s) => new RegExp(s);
const LEGACY_FILE = re(CFG.legacy_file_regex);          // path (relative to scan root) of files that sit in legacy locations
const SCOPE_FILE = re(CFG.scope_file_regex);            // files whose functions are fingerprinted
const CRYPTO_OWNERS = new Set(CFG.crypto_owners), SECURITY_OWNER = re(CFG.security_owner_regex);
const INLINE_CRYPTO = re(CFG.inline_crypto_regex), SECURITY_POLICY = re(CFG.security_policy_regex);
// an exemption is only honoured while its reason is given and every `requires` substring still exists in the named file
const evidenceHolds = (e) => !!e.reason && Array.isArray(e.requires) && e.requires.length > 0 && e.requires.every((r) => { const p = path.join(ROOT, r.file); return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(r.contains); });
const walk = (dir, out = []) => { if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|mts|mjs)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p); } return out; };

// ── semantic fingerprint: scope-aware alpha-renaming of every identifier DECLARED inside the function ──────────────
// Declarations get a placeholder numbered by order of declaration; references resolve through a scope stack, so two
// copies that differ only in local/param names (including shadowing) hash identically. Free identifiers, property
// names, string/number literals and operators are kept verbatim; type annotations are ignored.
function fingerprint(sf, fn) {
  let counter = 0;
  const scopes = [new Map()];
  const declare = (name) => { scopes[scopes.length - 1].set(name, `$${counter++}`); };
  const lookup = (name) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return null; };
  const bindNames = (name) => { if (ts.isIdentifier(name)) declare(name.text); else for (const el of name.elements ?? name.properties ?? []) { if (ts.isOmittedExpression(el)) continue; bindNames(el.name ?? el.initializer ?? el); } };
  const hoist = (stmts) => { for (const st of stmts) { if (ts.isVariableStatement(st)) st.declarationList.declarations.forEach((d) => bindNames(d.name)); else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) declare(st.name.text); } };
  const toks = [];
  const walkNode = (node) => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isPropName = p && ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) || (ts.isQualifiedName(p) && p.right === node));
      const mapped = !isPropName ? lookup(node.text) : null;
      toks.push(mapped ?? (p && ts.isShorthandPropertyAssignment(p) ? `short:${node.text}` : node.text));
      return;
    }
    if (ts.isStringLiteralLike(node)) { toks.push(JSON.stringify(node.text)); return; }
    if (ts.isNumericLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node) || ts.isBigIntLiteral(node)) { toks.push(`${ts.SyntaxKind[node.kind]}:${JSON.stringify(node.text)}`); return; }
    if (node.kind >= ts.SyntaxKind.FirstPunctuation && node.kind <= ts.SyntaxKind.LastPunctuation) { toks.push(ts.tokenToString(node.kind)); return; }
    if (ts.isTypeNode(node)) return;
    const scoped = ts.isBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isCatchClause(node) || ts.isCaseBlock(node) || ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node !== fn);
    if (scoped) {
      scopes.push(new Map());
      if (ts.isBlock(node)) hoist(node.statements);
      if (ts.isCaseBlock(node)) node.clauses.forEach((c) => hoist(c.statements));
      if (ts.isCatchClause(node) && node.variableDeclaration) bindNames(node.variableDeclaration.name);
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) node.initializer.declarations.forEach((d) => bindNames(d.name));
      if (node.parameters) node.parameters.forEach((p) => bindNames(p.name));
    }
    toks.push(`<${ts.SyntaxKind[node.kind]}`);
    ts.forEachChild(node, walkNode);
    toks.push(">");
    if (scoped) scopes.pop();
  };
  fn.parameters?.forEach((p) => bindNames(p.name));
  hoist(fn.body.statements);
  fn.body.statements.forEach(walkNode);
  const text = toks.join(" ");
  return { hash: sha256(text), chars: text.length };
}
const stmtCount = (body) => { let c = 0; const v = (n) => { if (ts.isStatement(n) && !ts.isBlock(n)) c++; ts.forEachChild(n, v); }; ts.forEachChild(body, v); return c; };
const nameOf = (node) => (node.name && ts.isIdentifier(node.name) ? node.name.text : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : null);

function parseFile(abs) {
  const text = fs.readFileSync(abs, "utf8");
  return { abs, text, sf: ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(abs) ? ts.ScriptKind.TSX : /\.mjs$/.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS) };
}
function functionsOf(f) {
  const out = [];
  const visit = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.body && ts.isBlock(node.body)) {
      const name = nameOf(node);
      if (name) out.push({ name, node, line: f.sf.getLineAndCharacterOfPosition(node.getStart(f.sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
  return out;
}
const importsOf = (f) => { const o = []; const v = (n) => { if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) o.push({ spec: n.moduleSpecifier.text, line: f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1 }); else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) o.push({ spec: n.arguments[0].text, line: f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1 }); ts.forEachChild(n, v); }; v(f.sf); return o; };
// a file is a pure shim iff every top-level statement is an import or an `export … from` / `export *` re-export (or a comment-only file)
function isPureShim(f) { return f.sf.statements.every((s) => ts.isImportDeclaration(s) || (ts.isExportDeclaration(s) && !!s.moduleSpecifier) || (ts.isExportDeclaration(s) && !s.moduleSpecifier && false) || ts.isEmptyStatement(s)); }
const hasLogic = (f) => !isPureShim(f);

function scan(root, { checkAllowlists = true } = {}) {
  const files = walk(root).map(parseFile);
  const relp = (f) => path.relative(root, f.abs).split(path.sep).join("/");
  const byRel = new Map(files.map((f) => [relp(f), f]));
  const resolve = (from, spec) => { if (!spec.startsWith(".")) return null; const base = path.posix.normalize(path.posix.join(path.posix.dirname(relp(from)), spec)); for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`]) if (byRel.has(c)) return c; return null; };
  const findings = [];
  const add = (rule, file, line, detail, extra = {}) => findings.push({ rule, file, line, detail, ...extra });

  // D1 — semantic duplicates
  const groups = new Map();
  for (const f of files) {
    if (!SCOPE_FILE.test(relp(f))) continue;
    for (const fn of functionsOf(f)) {
      if (stmtCount(fn.node.body) < MIN_STATEMENTS) continue;
      const fp = fingerprint(f.sf, fn.node);
      if (fp.chars < MIN_CHARS) continue;
      (groups.get(fp.hash) ?? groups.set(fp.hash, []).get(fp.hash)).push({ file: relp(f), name: fn.name, line: fn.line, chars: fp.chars });
    }
  }
  const dupGroups = [];
  for (const [hash, locs] of groups) {
    const uniq = new Map(locs.map((l) => [`${l.file}#${l.name}`, l]));
    if (uniq.size < 2) continue;
    const members = [...uniq.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    dupGroups.push({ fingerprint: hash.slice(0, 16), chars: members[0].chars, members });
    for (const m of members.slice(1)) add("D1-duplicate-implementation", m.file, m.line, `${m.name} duplicates ${members[0].name} (${members[0].file}:${members[0].line})`, { fingerprint: hash.slice(0, 16) });
  }

  // L1/L2 — legacy modules, consumers, classification
  const classification = [];
  for (const f of files.filter((x) => LEGACY_FILE.test(relp(x)))) {
    const shim = isPureShim(f);
    const consumers = [];
    for (const g of files) if (g !== f) for (const imp of importsOf(g)) if (resolve(g, imp.spec) === relp(f)) consumers.push({ file: relp(g), line: imp.line });
    const allowed = CFG.allowed_shims.find((a) => a.file === relp(f) && evidenceHolds(a));
    classification.push({ file: relp(f), class: shim ? "SHIM(re-export only)" : "OWNS_LOGIC", lines: f.text.split("\n").length, consumers: consumers.length, allowed_shim: !!allowed });
    if (!shim) add("L2-legacy-source-of-truth", relp(f), 1, "file in a legacy location still owns logic (not a re-export shim)");
    if (shim && !allowed) add("L2-legacy-source-of-truth", relp(f), 1, "legacy shim is not listed in allowed_shims (retire it or justify it)");
    if (shim && allowed) for (const c of consumers) if (!(allowed.consumers ?? []).includes(c.file)) add("L1-unexpected-legacy-consumer", c.file, c.line, `imports legacy shim ${relp(f)} directly (not in its allowed consumer list)`);
    if (!shim) for (const c of consumers) add("L1-unexpected-legacy-consumer", c.file, c.line, `imports legacy module ${relp(f)} that still owns logic`);
  }
  if (checkAllowlists) for (const a of CFG.allowed_shims) if (!evidenceHolds(a)) add("L2-legacy-source-of-truth", a.file, 1, "allowed_shims entry has no reason or its `requires` evidence no longer holds");
  if (checkAllowlists) for (const a of CFG.allowed_shims) if (!byRel.has(a.file)) classification.push({ file: a.file, class: "RETIRED(absent)", note: "listed in allowed_shims but no longer exists — remove the entry" }) && add("L2-legacy-source-of-truth", a.file, 1, "allowed_shims lists a file that no longer exists; delete the stale entry");

  // C1 / S1 — logic that must live in exactly one owner
  for (const f of files) {
    const r = relp(f);
    const code = [];
    const v = (n) => { if (ts.isIdentifier(n)) code.push({ t: n.text, line: f.sf.getLineAndCharacterOfPosition(n.getStart(f.sf)).line + 1 }); ts.forEachChild(n, v); };
    v(f.sf);
    if (!SCOPE_FILE.test(r)) continue;
    if (!CRYPTO_OWNERS.has(r) && !CFG.crypto_exempt.some((x) => re(x).test(r))) for (const c of code) if (INLINE_CRYPTO.test(c.t) && !CFG.crypto_import_only_ok) add("C1-duplicate-crypto-logic", r, c.line, `${c.t} used outside the shared crypto owner`);
    if (!SECURITY_OWNER.test(r)) {
      // identifiers bound by an import from an approved shared owner (e.g. lib/password) are consumption, not duplication
      const approvedBound = new Set();
      for (const st of f.sf.statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && re(CFG.approved_security_import_regex).test(st.moduleSpecifier.text)) {
        const nb = st.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) { approvedBound.add(el.name.text); if (el.propertyName) approvedBound.add(el.propertyName.text); }
      }
      const uses = new Map();
      for (const c of code) if (SECURITY_POLICY.test(c.t) && !approvedBound.has(c.t)) { const u = uses.get(c.t) ?? { n: 0, line: c.line }; u.n++; uses.set(c.t, u); }
      for (const [t, u] of uses) {
        const allow = CFG.security_primitive_allow.find((a) => a.file === r && a.identifier === t && evidenceHolds(a));
        if (allow && u.n <= allow.max_uses) continue;
        add("S1-duplicate-security-logic", r, u.line, allow ? `${t} used ${u.n}x, allowlist permits ${allow.max_uses}` : `${t} (security policy primitive) outside vault/security owner and not imported from an approved owner`);
      }
    }
  }
  return { files: files.length, vaultFiles: files.filter((f) => relp(f).startsWith("vault/")).length, findings, dupGroups, classification };
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────────────────────
if (SELF_TEST) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gap16-"));
  const w = (p, s) => { const a = path.join(tmp, p); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, s); };
  const body = (a, b) => `export function ${a}(items: number[], k: number) {\n  const out: number[] = [];\n  for (const ${b} of items) {\n    if (${b} > k) { out.push(${b} * 2); } else { out.push(${b} + k); }\n  }\n  const total = out.reduce((s, x) => s + x, 0);\n  if (total > 1000) { throw new Error("too large"); }\n  return { out, total, label: "calc-v1" };\n}\n`;
  const cases = [
    ["D1 renamed duplicate", () => { w("vault/application/a.ts", body("calcA", "x")); w("vault/application/b.ts", body("calcB", "item")); }, ["D1-duplicate-implementation"]],
    ["D1 literal change is not a duplicate", () => { w("vault/application/a.ts", body("calcA", "x")); w("vault/application/b.ts", body("calcB", "x").replace("calc-v1", "calc-v2")); }, []],
    ["L2 legacy file owns logic", () => { w("lib/vault-old.ts", body("legacy", "x")); }, ["L2-legacy-source-of-truth"]],
    ["L2 unlisted shim", () => { w("lib/vault-old.ts", `export { thing } from "../vault/application/a";\n`); w("vault/application/a.ts", `export const thing = 1;\n`); }, ["L2-legacy-source-of-truth"]],
    ["L1 consumer of logic-owning legacy", () => { w("lib/vault-old.ts", body("legacy", "x")); w("routes/vault.ts", `import { legacy } from "../lib/vault-old";\nexport const r = legacy;\n`); }, ["L1-unexpected-legacy-consumer", "L2-legacy-source-of-truth"]],
    ["C1 inline cipher", () => { w("vault/application/c.ts", `import { createCipheriv } from "node:crypto";\nexport const f = () => createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));\n`); }, ["C1-duplicate-crypto-logic"]],
    ["S1 inline timing-safe compare", () => { w("vault/application/d.ts", `import { timingSafeEqual } from "node:crypto";\nexport const g = (a: Buffer, b: Buffer) => timingSafeEqual(a, b);\n`); }, ["S1-duplicate-security-logic"]],
    ["S1 approved shared-owner import is not duplication", () => { w("vault/application/e.ts", `import { hashPassword, verifyPassword } from "../../lib/password";\nexport const h = (p: string) => hashPassword(p);\nexport const v = (p: string, x: string) => verifyPassword(p, x);\n`); }, []],
    ["S1 aliased approved-owner import is not duplication", () => { w("vault/application/e.ts", `import { hashPassword as hp } from "../../lib/password";\nexport const h = (p: string) => hp(p);\n`); }, []],
    ["S1 unlisted scrypt", () => { w("vault/application/f.ts", `import crypto from "crypto";\nexport const k = (p: string) => crypto.scryptSync(p, "salt", 32);\n`); }, ["S1-duplicate-security-logic"]],
    ["S1 allowlisted primitive over its cap", () => { w("vault/crypto/seed-phrase.ts", `import crypto from "crypto";\n// ayzen_seed_salt\nexport const a = crypto.scryptSync("a", "ayzen_seed_salt", 32);\nexport const b = crypto.scryptSync("b", "ayzen_seed_salt", 32);\n`); }, ["S1-duplicate-security-logic"]],
    ["L1 allowed shim gains a consumer", () => { w("lib/vault-pin-guard.ts", `export { requireVaultPin } from "../vault/security/pin-guard";\n`); w("vault/security/pin-guard.ts", `export const requireVaultPin = 1;\n`); w("routes/vault.ts", `import { requireVaultPin } from "../lib/vault-pin-guard";\nexport const r = requireVaultPin;\n`); }, ["L1-unexpected-legacy-consumer"]],
    ["allowed zero-consumer shim is accepted", () => { w("lib/vault-pin-guard.ts", `export { requireVaultPin } from "../vault/security/pin-guard";\n`); w("vault/security/pin-guard.ts", `export const requireVaultPin = 1;\n`); }, []],
    ["clean tree", () => { w("vault/application/a.ts", body("calcA", "x")); w("vault/application/b.ts", `export const two = (n: number) => n + 2;\n`); }, []],
  ];
  const results = [];
  for (const [name, setup, expect] of cases) {
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    setup();
    const got = [...new Set(scan(tmp, { checkAllowlists: false }).findings.map((x) => x.rule))];
    const ok = expect.length === 0 ? got.length === 0 : expect.every((e) => got.includes(e)) && got.every((g) => expect.includes(g));
    results.push({ case: name, expected: expect, caught: got, ok });
    if (!ok) { fs.rmSync(tmp, { recursive: true, force: true }); fail(`self-test: "${name}" expected ${JSON.stringify(expect)}, scanner reported ${JSON.stringify(got)}`); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ci-fail-proof.json"), JSON.stringify({ gap: GAP, kind: "intentional-duplicate-self-test", cases: results, status: "PASS" }, null, 2) + "\n");
  console.log(`${GAP}/self-test PASS — ${results.length} planted cases behaved as expected`);
  process.exit(0);
}

// ── scan the real tree ──────────────────────────────────────────────────────────────────────────────────────────
const SCAN_ROOT = ri >= 0 ? path.resolve(argv[ri + 1]) : path.join(ROOT, CFG.src_root);
const r = scan(SCAN_ROOT);
if (r.files === 0) fail(`scan scope is empty: no source files under ${SCAN_ROOT} (fail closed)`);
if (r.vaultFiles === 0) fail(`scan scope has no vault/ files under ${SCAN_ROOT} (fail closed)`);
const byRule = {}; for (const x of r.findings) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
const report = {
  gap: GAP, scanned_at: new Date().toISOString(), config_sha256: sha256File(path.join(ROOT, "scripts/antas/vault/gap/gap-configs/vault-duplicates.json")),
  files_scanned: r.files, vault_files: r.vaultFiles, thresholds: { min_statements: MIN_STATEMENTS, min_normalized_chars: MIN_CHARS },
  duplicate_groups: r.dupGroups, legacy_classification: r.classification, findings_by_rule: byRule, findings: r.findings,
  totals: { duplicate_business_implementations: r.dupGroups.length, unexpected_legacy_consumers: byRule["L1-unexpected-legacy-consumer"] ?? 0, old_source_of_truth_modules: byRule["L2-legacy-source-of-truth"] ?? 0 },
  status: r.findings.length === 0 ? "PASS" : "FAIL",
};
if (SCAN_ROOT.startsWith(path.join(ROOT, "artifacts"))) { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, "duplicate-scan.json"), JSON.stringify(report, null, 2) + "\n"); }
if (r.findings.length) {
  for (const x of r.findings.slice(0, 80)) console.error(`  ${x.file}:${x.line} [${x.rule}] ${x.detail}`);
  if (r.findings.length > 80) console.error(`  … ${r.findings.length - 80} more (see reports/antas/vault/gap/${GAP}/duplicate-scan.json)`);
  fail(`${r.findings.length} finding(s) ${JSON.stringify(byRule)}; duplicate groups ${r.dupGroups.length}`);
}
console.log(`${GAP} PASS — ${r.files} files scanned, duplicate business implementations = 0, unexpected legacy consumers = 0, old source-of-truth modules = 0`);
