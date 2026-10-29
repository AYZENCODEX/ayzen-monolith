#!/usr/bin/env node
// VLT-GAP-12 extract-method tool. Mechanically moves every direct infrastructure access found in the Vault behavior code into
// vault/infrastructure, without changing anything else:
//   • a database call chain rooted at `db` / a `tx` handle        -> repository function `return <chain verbatim>;`  (free variables become parameters)
//   • `db.transaction` / `cron.schedule` / `cron.validate` callee  -> infrastructure wrapper (callee-only; arguments stay put)
//   • provider / event calls (sendEmail, createNotification, ...)  -> alias re-export port in infrastructure/providers
// validate-gap.mjs (--stage split-verify) re-derives equivalence by inlining every call back and comparing with the sealed baseline,
// so this tool is a convenience, never a source of trust.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./gap-common.mjs";
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const cfg = (await import("./gap-configs/12.mjs")).default.extractMethod;
const DRY = process.argv.includes("--dry");
const API = "artifacts/api-server";
const abs = (p) => path.join(ROOT, p);

const parsed = ts.getParsedCommandLineOfConfigFile(abs(`${API}/tsconfig.json`), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
const roots = [...new Set([...parsed.fileNames, ...cfg.files.map((f) => abs(f.file))])];
const program = ts.createProgram(roots, { ...parsed.options, noEmit: true, skipLibCheck: true });
const checker = program.getTypeChecker();
const ALLOWED_DB_IMPORTS = new Set(cfg.allowedDbImports ?? []);
const DB_ROOTS = new Set(["db"]), TX_ROOTS = new Set(["tx", "trx", "dbHandle"]);
const SAFE_T = /^(number|string|boolean|Date|null|undefined|any|unknown|string\[\]|number\[\]|Record<string, (any|unknown|string)>)$/;
const typeText = (sym, at, fn) => {
  let t; try { t = checker.typeToString(checker.getTypeAtLocation(at), fn, ts.TypeFormatFlags.NoTruncation); } catch { return "any"; }
  t = t.replace(/^"[^"]*"$/, "string").replace(/^-?\d+(\.\d+)?$/, "number").replace(/^(true|false)$/, "boolean");
  return t.split(" | ").every((m) => SAFE_T.test(m)) ? t : "any";
};
const pascal = (s) => s.replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const rel = (from, to) => { let r = path.relative(path.dirname(abs(from)), abs(to)).split(path.sep).join("/").replace(/\.ts$/, ""); return r.startsWith(".") ? r : "./" + r; };
const resolveSpec = (fromFile, spec) => (spec.startsWith(".") ? path.relative(ROOT, path.resolve(path.dirname(abs(fromFile)), spec)).split(path.sep).join("/") : spec);
const isTypePos = (n, stop) => { for (let p = n.parent; p && p !== stop; p = p.parent) if (ts.isTypeNode(p) && !ts.isExpressionWithTypeArguments(p)) return true; return false; };
const isNamePos = (id) => { const p = id.parent; return (ts.isPropertyAccessExpression(p) && p.name === id) || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) || (ts.isBindingElement(p) && p.propertyName === id) || (ts.isQualifiedName(p)) || ts.isImportSpecifier(p) || ts.isLabeledStatement(p) || (ts.isParameter(p) && p.name === id) || (ts.isVariableDeclaration(p) && p.name === id) || (ts.isFunctionDeclaration(p) && p.name === id); };

const repoWork = new Map();   // repo file -> { imports:Map(local-> {spec,kind,imported,type}), fns:[text], names:Set }
const blockers = [], report = [];
const getRepo = (repo) => { if (!repoWork.has(repo)) repoWork.set(repo, { imports: new Map(), fns: [], names: new Set(), existing: fs.existsSync(abs(repo)) ? fs.readFileSync(abs(repo), "utf8") : "" }); return repoWork.get(repo); };

function importInfo(sym) {
  const d = sym?.declarations?.[0]; if (!d) return null;
  let decl = d; while (decl && !ts.isImportDeclaration(decl)) decl = decl.parent;
  if (!decl || !(ts.isImportSpecifier(d) || ts.isNamespaceImport(d) || ts.isImportClause(d))) return null;
  const spec = decl.moduleSpecifier.text, typeOnly = decl.importClause?.isTypeOnly || (ts.isImportSpecifier(d) && d.isTypeOnly);
  if (ts.isImportSpecifier(d)) return { spec, kind: "named", imported: (d.propertyName ?? d.name).text, typeOnly };
  if (ts.isNamespaceImport(d)) return { spec, kind: "ns", typeOnly };
  return { spec, kind: "default", typeOnly };
}

for (const item of cfg.files) {
  const sf = program.getSourceFile(abs(item.file)); if (!sf) { blockers.push(`${item.file}: not in program`); continue; }
  const text = sf.getFullText(); const edits = []; const usedNewImports = new Map(); // module-> Set(names)
  const repoPath = item.repo;
  const topOf = (n) => { let p = n; while (p.parent && p.parent !== sf) p = p.parent; return p; };
  const callerName = (n) => { const t = topOf(n); if (ts.isFunctionDeclaration(t) && t.name) return t.name.text; if (ts.isVariableStatement(t)) { const d = t.declarationList.declarations[0]; if (ts.isIdentifier(d.name)) return d.name.text; } return "module"; };
  const addImportTo = (name, module) => { if (!usedNewImports.has(module)) usedNewImports.set(module, new Set()); usedNewImports.get(module).add(name); };
  const nameFor = (verb, table, caller) => { const repo = getRepo(repoPath); const base = `${verb}${table}For${caller[0].toUpperCase()}${caller.slice(1)}`; let n = base, i = 2; while (repo.names.has(n) || new RegExp(`\\b${n}\\b`).test(repo.existing)) n = `${base}${i++}`; repo.names.add(n); return n; };

  const covered = [];
  const extractUnit = (n, cur, firstMember, isDb, isTx) => {
  const unit = cur; covered.push([unit.pos, unit.end]); const fn = topOf(unit); const caller = callerName(unit);
        // free variables / imports
        const free = new Map(), imps = new Map(); let bad = null;
        const scan = (m) => {
          if (ts.isAwaitExpression(m) || ts.isYieldExpression(m)) bad = "await/yield inside the chain";
          if (m.kind === ts.SyntaxKind.ThisKeyword) bad = "this inside the chain";
          if (ts.isIdentifier(m) && !isTypePos(m, unit) && !(isNamePos(m) && !(ts.isParameter(m.parent) || ts.isVariableDeclaration(m.parent) || ts.isFunctionDeclaration(m.parent)))) {
            let s = checker.getSymbolAtLocation(m); if (ts.isShorthandPropertyAssignment(m.parent)) s = checker.getShorthandAssignmentValueSymbol(m.parent);
            const d = s?.declarations?.[0]; if (!d) return;
            const ii = importInfo(s);
            if (ii) { imps.set(m.text, ii); return; }
            const inUnit = d.pos >= unit.pos && d.end <= unit.end; if (inUnit) return;
            if (m === n && isDb) return;
            if (d.getSourceFile() === sf) { if (!free.has(m.text)) free.set(m.text, { sym: s, at: m }); }
          }
          ts.forEachChild(m, scan);
        };
        scan(unit);
        if (bad) { blockers.push(`${item.file}:${sf.getLineAndCharacterOfPosition(unit.getStart(sf)).line + 1} ${bad} in ${caller}`); return; }
        let verb = firstMember, table = "Sql";
        const first = unit.getText(sf);
        const m1 = /\.(?:from|insert|update|delete|into)\(\s*([A-Za-z_]\w*)\s*\)/.exec(first.replace(/\s+/g, " ")) ; if (m1) table = pascal(m1[1].replace(/Table$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase());
        else { const m2 = /(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/i.exec(first); if (m2) table = pascal(m2[1].toLowerCase()); }
        if (!["select", "insert", "update", "delete", "execute", "sql", "ref"].includes(verb)) verb = "query";
        const name = nameFor(verb, table, caller);
        const params = [...free.entries()].map(([nm, v]) => `${nm}: ${TX_ROOTS.has(nm) && v.sym.declarations[0] && ts.isParameter(v.sym.declarations[0]) && n.text === nm ? "DbExecutor" : typeText(v.sym, v.at, fn)}`);
        const args = [...free.keys()];
        const repo = getRepo(repoPath);
        for (const [loc, ii] of imps) repo.imports.set(loc, { ...ii, spec: resolveSpec(item.file, ii.spec) });
        if (isTx || [...free.keys()].some((k) => TX_ROOTS.has(k))) repo.needsExecutor = true;
        repo.fns.push(`export function ${name}(${params.join(", ")}) {\n  return ${first};\n}`);
        edits.push({ start: unit.getStart(sf), end: unit.getEnd(), text: `${name}(${args.join(", ")})`, kind: "db", alias: name, caller });
        addImportTo(name, repoPath);
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n)) return;
    if (covered.some(([s0, e0]) => n.pos >= s0 && n.end <= e0)) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      const dp = (cfg.dynamicImportPorts ?? []).find((d) => d.from === resolveSpec(item.file, n.arguments[0].text));
      if (dp) {
        let names = []; const vd = n.parent && ts.isAwaitExpression(n.parent) ? n.parent.parent : null;
        if (vd && ts.isVariableDeclaration(vd) && ts.isObjectBindingPattern(vd.name)) names = vd.name.elements.map((e) => (e.propertyName ?? e.name).text);
        edits.push({ start: n.arguments[0].getStart(sf), end: n.arguments[0].getEnd(), text: JSON.stringify(rel(item.file, dp.to)), kind: "dynamic", dp, names });
        return;
      }
    }
    if (ts.isIdentifier(n) && !isNamePos(n) && !isTypePos(n, sf)) {
      const sym = checker.getSymbolAtLocation(n); const imp = importInfo(sym);
      const isDb = imp && imp.spec === "@workspace/db" && n.text === "db" && !imp.typeOnly;
      const sym2 = sym; const decl = sym2?.declarations?.[0];
      const isTx = TX_ROOTS.has(n.text) && decl && ts.isParameter(decl);
      // call-site ports / cron callees
      if (imp && !imp.typeOnly && ts.isCallExpression(n.parent) && n.parent.expression === n && cfg.ports[n.text] && cfg.ports[n.text].from === resolveSpec(item.file, imp.spec)) {
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: cfg.ports[n.text].alias, kind: "port", orig: n.text, spec: resolveSpec(item.file, imp.spec), alias: cfg.ports[n.text].alias });
        return;
      }
      if (imp && imp.kind === "default" && imp.spec === "node-cron" && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent && (n.parent.name.text === "schedule" || n.parent.name.text === "validate")) {
        const m = n.parent.name.text, alias = m === "schedule" ? "scheduleCronJob" : "validateCronExpression";
        edits.push({ start: n.parent.getStart(sf), end: n.parent.getEnd(), text: alias, kind: "cron", alias, orig: `cron.${m}` });
        return;
      }
      const isSql = imp && imp.spec === "drizzle-orm" && n.text === "sql" && !imp.typeOnly;
      const isTable = imp && imp.spec === "@workspace/db" && !imp.typeOnly && n.text !== "db" && !ALLOWED_DB_IMPORTS.has(n.text);
      if (isSql || isTable) {
        const p = n.parent; let cur = n;
        if (ts.isTaggedTemplateExpression(p) && p.tag === n) cur = p;
        else if (ts.isPropertyAccessExpression(p) && p.expression === n) { while (cur.parent && ((ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && !/^(then|catch|finally)$/.test(cur.parent.name.text)) || (ts.isCallExpression(cur.parent) && cur.parent.expression === cur))) cur = cur.parent; }
        else { blockers.push(`${item.file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} bare ${n.text} (${isSql ? "drizzle sql" : "table"} reference outside a chain)`); return; }
        extractUnit(n, cur, isSql ? "sql" : "ref", false, false);
        return;
      }
      if (isDb || isTx) {
        const p = n.parent;
        if (!(ts.isPropertyAccessExpression(p) && p.expression === n)) {
          // a bare `tx` is an opaque handle being passed along (not an access); a bare `db` is replaced by the infrastructure `defaultDb` alias
          if (isDb) edits.push({ start: n.getStart(sf), end: n.getEnd(), text: "defaultDb", kind: "bare", alias: "defaultDb", orig: "db" });
          return;
        }
        if (isDb && p.name.text === "transaction") { edits.push({ start: p.getStart(sf), end: p.getEnd(), text: "runInTransaction", kind: "tx", alias: "runInTransaction", orig: "db.transaction" }); ts.forEachChild(n.parent.parent, visit); return; }
        let cur = n; while (cur.parent && ((ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && !/^(then|catch|finally)$/.test(cur.parent.name.text)) || (ts.isCallExpression(cur.parent) && cur.parent.expression === cur))) cur = cur.parent;
        extractUnit(n, cur, p.name.text, isDb, isTx);
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // overlapping edits (nested units) cannot happen: units are outermost and `return` before recursing.
  edits.sort((a, b) => b.start - a.start);
  let out = text; for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  item.edits = edits; item.out = out; item.newImports = usedNewImports;
  report.push(`${item.file}: ${edits.filter((e) => e.kind === "db").length} db, ${edits.filter((e) => e.kind === "tx").length} tx, ${edits.filter((e) => e.kind === "cron").length} cron, ${edits.filter((e) => e.kind === "port").length} provider`);
}
console.log(report.join("\n"));
if (blockers.length) { console.log("\nBLOCKERS:\n  " + blockers.join("\n  ")); }
if (DRY || blockers.length) process.exit(blockers.length ? 2 : 0);
globalThis.__extract = { cfg, repoWork, ts, abs, rel, resolveSpec };
await import("./extract-infra-write.mjs");
