#!/usr/bin/env node
// VLT-GAP-13 — Route thinness enforcement (AST scan, line-level violations, CI gate, self-test).
//   node validate-vlt-gap-13.mjs             scan every Vault route; write reports/antas/vault/gap/VLT-GAP-13/
//   node validate-vlt-gap-13.mjs --self-test plant violations in a temp route dir and prove the scanner rejects them
// A route file may only parse the request, guard auth, call an application/security owner and map its result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, rel, rejectBypass, walkFiles, sha256 } from "./gap-common.mjs";

const GAP = "VLT-GAP-13";
const OUT_DIR = path.join(ROOT, "reports/antas/vault/gap", GAP);
const argv = process.argv.slice(2);
const bad = rejectBypass(["--self-test", "--root"]).filter((b) => !/^unknown flag --root$/.test(b) && !/^arg --root/.test(b));
const ri = argv.indexOf("--root");
const SCAN_ROOT = ri >= 0 ? path.resolve(argv[ri + 1]) : path.join(ROOT, "artifacts/api-server/src/routes");
const SELF_TEST = argv.includes("--self-test");
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);

const ts = createRequire(path.join(ROOT, "package.json"))("typescript");

// ── scope: every Vault-owned route module ───────────────────────────────────────────────────────────────────────
const VAULT_ROUTE = /^(vault[\w-]*|local-accounts|kyc[\w-]*|game-entries|marketplace-game|marketplace-vault)\.ts$/;
// ── adapter allowlist / denylist ────────────────────────────────────────────────────────────────────────────
const DB_MODULES = /^(@workspace\/db|drizzle-orm|pg|postgres|mysql2?|better-sqlite3|\.\.\/(\.\.\/)?db)(\/|$)/;
const PROVIDER_MODULES = /^(node:)?(fs|fs\/promises|crypto|child_process|net|http|https|nodemailer|@aws-sdk\/.*|aws-sdk|googleapis|axios|node-fetch|stripe|twilio|bcrypt\w*|argon2|jsonwebtoken)$/;
const SQL_TEXT = /\b(SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM)\b/i;
const DB_CALL = /^db$|^pool$|^client$|^tx$/;
const DB_METHODS = new Set(["select", "insert", "update", "delete", "execute", "transaction", "query", "from", "where"]);
const SECURITY_POLICY = /\b(bcrypt\w*|argon2|scrypt\w*|createHash|createHmac|timingSafeEqual|randomBytes|jwt|lockedUntil|failedAttempts|failed_attempts|lockout\w*|MAX_ATTEMPTS|hashPassword|verifyPassword)\b/;
const ROUTE_VERB = /^(get|post|put|patch|delete|all|use)$/;
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "set", "add", "delete", "clear", "sort", "reverse"]);
const HOF_CALC = new Set(["reduce", "reduceRight", "sort", "flatMap"]);
const MAX_HANDLER_LINES = 40;
const MAX_HANDLER_STATEMENTS = 18;

function scanFile(abs) {
  const text = fs.readFileSync(abs, "utf8");
  const f = rel(abs);
  const tree = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const line = (n) => tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1;
  const v = (rule, n, detail, handler) => out.push({ file: f, line: line(n), rule, handler: handler ?? null, detail: String(detail).slice(0, 140) });

  // module scope: imports + module-level bindings (for mutation checks)
  const moduleBindings = new Set();
  for (const s of tree.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text;
      if (DB_MODULES.test(spec)) v("R1-db-import", s, spec);
      if (PROVIDER_MODULES.test(spec)) v("R3-provider-import", s, spec);
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(abs), spec);
        if (path.dirname(target) === path.dirname(abs) && !/\/(index)$/.test(spec)) v("R7-route-to-route", s, spec);
      }
    }
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) moduleBindings.add(d.name.text);
    if (ts.isFunctionDeclaration(s) && s.name) moduleBindings.add(s.name.text);
  }
  // a route file may declare nothing but the router (+ trivial constants)
  const routerNames = new Set();
  // names imported from the application / security / infrastructure owners (the only things a handler may delegate to)
  const ownerImports = new Set();
  for (const st of tree.statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /\/vault\/(application|security|api|infrastructure|shared)\//.test(st.moduleSpecifier.text) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) for (const el of st.importClause.namedBindings.elements) ownerImports.add(el.name.text);
  for (const s of tree.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) v("R4-business-helper", s, `module-level function ${s.name.text}() in a route file`);
    if (ts.isClassDeclaration(s)) v("R4-business-helper", s, "class in a route file");
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
      const i = d.initializer; if (!i) continue;
      if (ts.isCallExpression(i) && ts.isIdentifier(i.expression) && i.expression.text === "Router" && ts.isIdentifier(d.name)) { routerNames.add(d.name.text); continue; }
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) v("R4-business-helper", s, `module-level function ${d.name.getText(tree)} in a route file`);
      else if (ts.isNewExpression(i) && /^(Map|Set|WeakMap|Array)$/.test(i.expression.getText(tree))) v("R5-state-mutation", s, `module-level state ${d.name.getText(tree)}`);
      else if (!(ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const))) v("R5-state-mutation", s, `module-level let/var ${d.name.getText(tree)}`);
    }
  }

  const handlers = [];
  const find = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && routerNames.has(n.expression.expression.text) && ROUTE_VERB.test(n.expression.name.text)) {
      const last = n.arguments[n.arguments.length - 1];
      if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) handlers.push({ fn: last, name: `${n.expression.name.text.toUpperCase()} ${n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : "?"}` });
    }
    ts.forEachChild(n, find);
  };
  find(tree);

  for (const { fn, name } of handlers) {
    const body = fn.body;
    const lines = tree.getLineAndCharacterOfPosition(fn.getEnd()).line - tree.getLineAndCharacterOfPosition(fn.getStart(tree)).line + 1;
    let stmts = 0, hasDelegate = false;
    const locals = new Set(fn.parameters.map((p) => p.name.getText(tree)));
    const walk = (n) => {
      if (ts.isStatement(n) && !ts.isBlock(n)) stmts++;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) locals.add(n.name.text);
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) v("R4-business-calc", n, "loop in handler", name);
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ownerImports.has(n.expression.text)) hasDelegate = true;
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if (ts.isIdentifier(e) && e.text === "fetch") v("R3-provider-access", n, "fetch(", name);
        if (ts.isIdentifier(e) && /^(sendEmail|sendToUser|createNotification|sendTelegram\w*)$/.test(e.text)) v("R3-provider-access", n, `${e.text}(`, name);
        if (ts.isPropertyAccessExpression(e)) {
          const obj = e.expression, m = e.name.text;
          if (ts.isIdentifier(obj) && DB_CALL.test(obj.text) && DB_METHODS.has(m)) v("R2-raw-sql/db", n, `${obj.text}.${m}(`, name);
          if (ts.isIdentifier(obj) && obj.text === "Math") v("R4-business-calc", n, `Math.${m}`, name);
          if (ts.isIdentifier(obj) && obj.text === "JSON" && m === "parse") v("R4-business-calc", n, "JSON.parse", name);
          if (HOF_CALC.has(m)) v("R4-business-calc", n, `.${m}(`, name);
          if (MUTATORS.has(m) && ts.isIdentifier(obj) && moduleBindings.has(obj.text) && !locals.has(obj.text)) v("R5-state-mutation", n, `${obj.text}.${m}( on module-level state`, name);
          if (ts.isIdentifier(obj) && /^(fs|crypto|child_process|s3|storage)$/.test(obj.text)) v("R3-provider-access", n, `${obj.text}.${m}`, name);
        }
      }
      if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === "sql") v("R2-raw-sql/db", n, "sql`…` template", name);
      if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) { const t = ts.isTemplateExpression(n) ? n.getText(tree) : n.text; if (SQL_TEXT.test(t)) v("R2-raw-sql/db", n, t.replace(/\s+/g, " "), name); }
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
          let t = n.left; while (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) t = t.expression;
          if (ts.isIdentifier(t) && moduleBindings.has(t.text) && !locals.has(t.text)) v("R5-state-mutation", n, `assignment to module-level ${t.text}`, name);
        }
        if ([ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken].includes(k)
          && !(ts.isNumericLiteral(n.left) && ts.isNumericLiteral(n.right))) v("R4-business-calc", n, `arithmetic ${n.getText(tree)}`, name);
      }
      if (ts.isIdentifier(n) && SECURITY_POLICY.test(n.text) && !ts.isImportSpecifier(n.parent)) v("R6-security-policy", n, n.text, name);
      ts.forEachChild(n, walk);
    };
    if (body) walk(body);
    if (lines > MAX_HANDLER_LINES) v("R8-handler-size", fn, `${lines} lines (max ${MAX_HANDLER_LINES})`, name);
    if (stmts > MAX_HANDLER_STATEMENTS) v("R8-handler-size", fn, `${stmts} statements (max ${MAX_HANDLER_STATEMENTS})`, name);
    if (!hasDelegate && !/^\s*\{?\s*res\.(status|json|send|redirect|end)/.test(body?.getText(tree) ?? "")) v("R9-no-delegate", fn, "handler never calls an application/security owner", name);
  }
  return { file: f, handlers: handlers.length, lines: text.split("\n").length, violations: out };
}

function scanAll(dir) {
  if (!fs.existsSync(dir)) fail(`route directory missing: ${dir}`);
  const files = fs.readdirSync(dir).filter((n) => VAULT_ROUTE.test(n)).sort().map((n) => path.join(dir, n));
  if (!files.length) fail(`no Vault route files found in ${dir} (fail closed)`);
  return files.map(scanFile);
}

// ── self-test: planted violations must be caught; a clean adapter must pass ────────────────────────────────────
if (SELF_TEST) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gap13-"));
  const clean = `import { Router } from "express";\nimport { requireAuth, getRequestUserId } from "../middlewares/auth";\nimport { getThing } from "../vault/application/thing";\nconst router = Router();\nrouter.get("/vault/thing", requireAuth, async (req, res): Promise<void> => {\n  const userId = getRequestUserId(req);\n  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }\n  const out = await getThing(userId);\n  res.status(out.status).json(out.body);\n});\nexport default router;\n`;
  const planted = {
    "vault-clean.ts": [clean, []],
    "vault-r1.ts": [clean.replace(`import { getThing }`, `import { db } from "@workspace/db";\nimport { getThing }`), ["R1-db-import"]],
    "vault-r2.ts": [clean.replace("const out", `await db.select().from(t);\n  const out`), ["R2-raw-sql/db"]],
    "vault-r2b.ts": [clean.replace("const out", `const q = "SELECT id FROM vault_entries";\n  const out`), ["R2-raw-sql/db"]],
    "vault-r3.ts": [clean.replace("const out", `await fetch("https://x");\n  const out`), ["R3-provider-access"]],
    "vault-r4.ts": [clean.replace("const out", `let t = 0; for (const x of [1]) t += x;\n  const out`), ["R4-business-calc"]],
    "vault-r5.ts": [clean.replace("const router", `const cache = new Map();\nconst router`), ["R5-state-mutation"]],
    "vault-r6.ts": [clean.replace("const out", `const h = createHash("sha256");\n  const out`), ["R6-security-policy"]],
    "vault-r7.ts": [clean.replace(`import { getThing }`, `import other from "./vault-other";\nimport { getThing }`), ["R7-route-to-route"]],
    "vault-r9.ts": [clean.replace("await getThing(userId)", "{ status: 200, body: {} }"), ["R9-no-delegate"]],
  };
  const results = [];
  for (const [name, [src, expect]] of Object.entries(planted)) {
    fs.writeFileSync(path.join(tmp, name), src);
    const r = scanFile(path.join(tmp, name));
    const got = [...new Set(r.violations.map((x) => x.rule))];
    const ok = expect.length === 0 ? got.length === 0 : expect.every((e) => got.includes(e));
    results.push({ case: name, expected: expect, caught: got, ok });
    if (!ok) fail(`self-test: ${name} expected ${JSON.stringify(expect)}, scanner reported ${JSON.stringify(got)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ci-fail-proof.json"), JSON.stringify({ gap: GAP, kind: "intentional-violation-self-test", cases: results, status: "PASS" }, null, 2) + "\n");
  console.log(`${GAP}/self-test PASS — ${results.length} planted cases behaved as expected (${results.filter((r) => r.expected.length).length} violations caught, clean adapter accepted)`);
  process.exit(0);
}

// ── scan ───────────────────────────────────────────────────────────────────────────────────────────────────────
const files = scanAll(SCAN_ROOT);
const violations = files.flatMap((f) => f.violations);
const byRule = {};
for (const x of violations) byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
const report = {
  gap: GAP, scanned_at: new Date().toISOString(),
  route_files: files.map((f) => ({ file: f.file, handlers: f.handlers, lines: f.lines, violations: f.violations.length })),
  total_handlers: files.reduce((n, f) => n + f.handlers, 0),
  violations_by_rule: byRule, violations,
  status: violations.length === 0 ? "PASS" : "FAIL",
};
if (SCAN_ROOT.startsWith(path.join(ROOT, "artifacts"))) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "route-thinness.json"), JSON.stringify(report, null, 2) + "\n");
}
for (const f of files) console.log(`${f.violations.length === 0 ? "ok  " : "FAIL"} ${f.file} (${f.handlers} handlers, ${f.lines} lines, ${f.violations.length} violations)`);
if (violations.length) {
  for (const x of violations.slice(0, 60)) console.error(`  ${x.file}:${x.line} [${x.rule}] ${x.handler ?? "module"} — ${x.detail}`);
  if (violations.length > 60) console.error(`  … ${violations.length - 60} more (see reports/antas/vault/gap/${GAP}/route-thinness.json)`);
  fail(`${violations.length} prohibited business operation(s) remain in Vault routes ${JSON.stringify(byRule)}`);
}
console.log(`${GAP} PASS — ${files.length} route files, ${report.total_handlers} handlers, 0 violations`);
