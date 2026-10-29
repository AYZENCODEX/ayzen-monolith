#!/usr/bin/env node
// VLT-GAP-06-D — Vault re-auth extraction + GAP-06 retirement gate.
// routes/vault-reauth.ts must be a thin adapter, its logic must live in vault/application/security/reauth.ts
// (+ repository, ownership, shared lockout), behavior must equal the frozen pre-extraction route, and the
// legacy lib/vault-pin-guard.ts must be a zero-consumer re-export shim.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { ROOT, binding, rejectBypass, rel, sha256, sha256File, walkFiles } from "./gap-common.mjs";

const SUB_PHASE = "VLT-GAP-06-D";
const DIR = "reports/antas/vault/gap/VLT-GAP-06";
const API = "artifacts/api-server/src";
const ROUTE = `${API}/routes/vault-reauth.ts`;
const APP = `${API}/vault/application/security/reauth.ts`;
const REPO = `${API}/vault/infrastructure/repositories/vault-reauth-repository.ts`;
const OWNERSHIP = `${API}/vault/security/reauth-ownership.ts`;
const LOCKOUT = `${API}/vault/security/lockout.ts`;
const SHIM = `${API}/lib/vault-pin-guard.ts`;
const NEW_FILES = [APP, REPO, OWNERSHIP, LOCKOUT];
const BASELINE = `${DIR}/baseline/sources/artifacts__api-server__src__routes__vault-reauth.ts`;
const MANIFEST = `${DIR}/baseline/repo-manifest.json`;
const PRIOR = { A: `${DIR}/symbol-inventory.json`, B: `${DIR}/extraction-proof.json`, C: `${DIR}/consumer-graph.json` };
const EVIDENCE = `${DIR}/retire-proof.json`;
const MAP = "docs/antas/vault/file-migration-map.md";
const DIFFERENTIAL = "scripts/antas/vault/gap/differential-vlt-gap-06-D.mjs";
const REQUIRED_SYMBOLS = ["getReauthStatus", "sendReauthEmailCode", "verifyStep3", "passkeyOptions", "verifyPasskey", "verifyVaultCredentials", "vaultReauthOtpKey"];
const ROUTES = [
  "GET /vault/reauth/status", "POST /vault/reauth/email-code/send", "POST /vault/reauth/verify-step3",
  "POST /vault/reauth/passkey/options", "POST /vault/reauth/passkey/verify", "POST /vault/reauth/verify",
];
const FORBIDDEN_IN_ROUTE = [/@workspace\/db/, /drizzle-orm/, /\bdb\s*\./, /new\s+Map\s*[<(]/, /verifyPassword|totpVerify|verifyOtp|storeOtp|bcrypt/, /verifyAuthenticationResponse|generateAuthenticationOptions/, /sendEmail/, /FAILED_ATTEMPT_LIMIT|LOCKOUT_MS/];
const MAP_ROWS = [
  "| Vault re-auth (passkey, PIN/password + 2FA, email code) | `artifacts/api-server/src/routes/vault-reauth.ts` | `artifacts/api-server/src/vault/application/security/reauth.ts` | EXTRACTED (VLT-GAP-06-D); route is a thin adapter |",
  "| Vault re-auth DB access | `artifacts/api-server/src/routes/vault-reauth.ts` | `artifacts/api-server/src/vault/infrastructure/repositories/vault-reauth-repository.ts` | EXTRACTED (VLT-GAP-06-D) |",
  "| Vault re-auth passkey ownership | `artifacts/api-server/src/routes/vault-reauth.ts` | `artifacts/api-server/src/vault/security/reauth-ownership.ts` | EXTRACTED (VLT-GAP-06-D) |",
  "| Vault re-auth lockout | `artifacts/api-server/src/routes/vault-reauth.ts` | `artifacts/api-server/src/vault/security/lockout.ts` (kind `reauth`) | EXTRACTED (VLT-GAP-06-D); private Map removed |",
  "| Security PIN guard | `artifacts/api-server/src/lib/vault-pin-guard.ts` | `artifacts/api-server/src/vault/security/pin-guard.ts` | RETIRED (VLT-GAP-06-D); re-export-only shim, zero consumers |",
];

const fail = (message) => { console.error(`${SUB_PHASE} FAIL — ${message}`); process.exit(1); };
const bypass = rejectBypass();
if (bypass.length) fail(`bypass rejected: ${bypass.join(", ")}`);
for (const [key, value] of Object.entries(process.env)) {
  if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(key) && value && !/^(0|false|no)$/i.test(value)) fail(`bypass rejected: ${key}`);
}
const abs = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(abs(f), "utf8");
for (const f of [ROUTE, ...NEW_FILES, SHIM, BASELINE, MANIFEST, MAP, DIFFERENTIAL, ...Object.values(PRIOR), `${API}/routes/index.ts`]) {
  if (!fs.existsSync(abs(f))) fail(`required file/evidence missing: ${f}`);
}
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");
const parse = (f, text) => ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// 1. Earlier gates PASS; frozen baseline intact.
const a = JSON.parse(read(PRIOR.A)), b = JSON.parse(read(PRIOR.B)), c = JSON.parse(read(PRIOR.C));
if (a.status !== "PASS" || a.sub_phase !== "VLT-GAP-06-A") fail("06-A census is not PASS");
if (b.status !== "PASS" || b.sub_phase !== "VLT-GAP-06-B") fail("06-B proof is not PASS");
if (c.status !== "PASS" || c.sub_phase !== "VLT-GAP-06-C") fail("06-C proof is not PASS");
const manifest = JSON.parse(read(MANIFEST));
const frozen = manifest.sources?.find((s) => s.file === ROUTE);
if (!frozen || frozen.baseline_copy !== BASELINE || sha256File(abs(BASELINE)) !== frozen.sha256) fail("06-A frozen vault-reauth baseline missing or corrupt");
const baselineText = read(BASELINE);

// 2. New owners are real code with the required symbols.
const exportsOf = (tree) => tree.statements.filter((n) => ts.isFunctionDeclaration(n) && n.body && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((n) => n.name.text);
const appTree = parse(APP, read(APP));
for (const f of NEW_FILES) if (parse(f, read(f)).parseDiagnostics.length) fail(`parse error in ${f}`);
const appExports = exportsOf(appTree);
for (const s of REQUIRED_SYMBOLS) if (!appExports.includes(s)) fail(`${APP} does not export ${s}`);
for (const f of NEW_FILES) {
  const t = parse(f, read(f));
  if (!t.statements.some((n) => ts.isFunctionDeclaration(n) && n.body && n.body.statements.length)) fail(`${f} is scaffold-only (no function with a body)`);
}

// 3. Route is a thin adapter.
const routeText = read(ROUTE);
const routeTree = parse(ROUTE, routeText);
if (routeText.split("\n").length > 200) fail("route still too large to be a thin adapter");
for (const re of FORBIDDEN_IN_ROUTE) if (re.test(routeText.replace(/\/\*[\s\S]*?\*\//g, ""))) fail(`route still contains extracted logic matching ${re}`);
const handlers = [];
const visit = (n) => {
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && /^(get|post|put|patch|delete)$/.test(n.expression.name.text) && ts.isStringLiteral(n.arguments[0])) {
    handlers.push({ key: `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`, fn: n.arguments[n.arguments.length - 1] });
  }
  ts.forEachChild(n, visit);
};
visit(routeTree);
if (JSON.stringify(handlers.map((h) => h.key).sort()) !== JSON.stringify([...ROUTES].sort())) fail(`route set changed: ${handlers.map((h) => h.key).join(", ")}`);
for (const h of handlers) {
  const body = h.fn.body?.getText() ?? "";
  if (!/getRequestUserId\(req\)/.test(body) || !/res\.status\(401\)/.test(body)) fail(`${h.key}: missing session guard`);
  if (!/const out = await \w+\(/.test(body) || !/res\.status\(out\.status\)\.json\(out\.body\)/.test(body)) fail(`${h.key}: not a delegating adapter`);
  if (h.fn.body.statements.length > 4) fail(`${h.key}: handler has more than guard + delegate + respond`);
}

// 4. Literal parity: status codes, error codes, route paths, messages, email template.
const literals = (text, f) => {
  const tree = parse(f, text);
  const strings = new Set(), statuses = new Set(), templates = [];
  const walk = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.add(n.text);
    if (ts.isTemplateExpression(n)) { templates.push(n.getText()); strings.add(n.head.text); n.templateSpans.forEach((s) => strings.add(s.literal.text)); }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "status" && ts.isNumericLiteral(n.arguments[0] ?? {})) statuses.add(Number(n.arguments[0].text));
    if (ts.isPropertyAssignment(n) && n.name.getText() === "status" && ts.isNumericLiteral(n.initializer)) statuses.add(Number(n.initializer.text));
    ts.forEachChild(n, walk);
  };
  walk(tree);
  return { strings, statuses, templates };
};
const before = literals(baselineText, BASELINE);
const after = { strings: new Set(), statuses: new Set(), templates: [] };
for (const f of [ROUTE, ...NEW_FILES.filter((x) => x !== LOCKOUT)]) {
  const l = literals(read(f), f);
  l.strings.forEach((s) => after.strings.add(s)); l.statuses.forEach((s) => after.statuses.add(s)); after.templates.push(...l.templates);
}
const lostStrings = [...before.strings].filter((s) => s.trim() && !after.strings.has(s) && !/^[./@]/.test(s) && s.length > 1);
// (the only deliberate removals are import specifiers, already excluded, and comment-only text, which is not a literal)
if (lostStrings.length) fail(`string literals lost in extraction:\n  ${lostStrings.join("\n  ")}`);
// 200 is Express's implicit default in the original (`res.json(...)`) and explicit in the adapter's result objects.
const nonDefault = (set) => [...set].filter((x) => x !== 200).sort();
before.statuses = new Set(nonDefault(before.statuses)); after.statuses = new Set(nonDefault(after.statuses));
if (JSON.stringify([...before.statuses].sort()) !== JSON.stringify([...after.statuses].sort())) fail(`HTTP status-code set changed: ${[...before.statuses].sort()} -> ${[...after.statuses].sort()}`);
const emailBefore = before.templates.filter((t) => t.includes("<!DOCTYPE"));
const emailAfter = after.templates.filter((t) => t.includes("<!DOCTYPE"));
if (emailBefore.length !== 1 || emailAfter.length !== 1 || emailBefore[0] !== emailAfter[0]) fail("Vault unlock email template changed");

// 5. Security-critical call parity (nothing dropped, nothing doubled).
const count = (text, re) => (text.match(re) ?? []).length;
const newAll = [APP, ROUTE].map(read).join("\n");
const parity = {
  verifyPassword: [count(baselineText, /\bverifyPassword\(/g), count(newAll, /\bverifyPassword\(/g)],
  totpVerify: [count(baselineText, /\btotpVerify\(/g), count(newAll, /\btotpVerify\(/g)],
  verifyOtp: [count(baselineText, /\bverifyOtp\(/g), count(newAll, /\bverifyOtp\(/g)],
  storeOtp: [count(baselineText, /\bstoreOtp\(/g), count(newAll, /\bstoreOtp\(/g)],
  consumeChallenge: [count(baselineText, /\bconsumeChallenge\(/g), count(newAll, /\bconsumeChallenge\(/g)],
  verifyAuthenticationResponse: [count(baselineText, /\bverifyAuthenticationResponse\(/g), count(newAll, /\bverifyAuthenticationResponse\(/g)],
  recordFailure: [count(baselineText, /\brecordFailure\(userId\)/g), count(newAll, /\brecordFailure\(userId, "reauth"\)/g)],
  clearFailures: [count(baselineText, /\bclearFailures\(userId\)/g), count(newAll, /\bclearFailures\(userId, "reauth"\)/g)],
  isLockedOut: [count(baselineText, /\bisLockedOut\(userId\)/g), count(newAll, /\bisLockedOut\(userId, "reauth"\)/g)],
};
for (const [k, [x, y]] of Object.entries(parity)) if (x !== y || x === 0) fail(`security call parity broken for ${k}: before ${x}, after ${y}`);

// 6. No duplicate lockout implementation left anywhere in the API tree (outside vault/security/lockout.ts, pin-guard.ts).
const apiFiles = walkFiles(abs(API), [], (p) => /\.tsx?$/.test(p)).map(rel);
const dupLockouts = apiFiles.filter((f) => ![LOCKOUT, `${API}/vault/security/pin-guard.ts`].includes(f) && /FAILED_ATTEMPT_LIMIT\s*=/.test(read(f)) && /new Map<\s*(number|string)\s*,\s*\{\s*count/.test(read(f)));
if (dupLockouts.length) fail(`duplicate lockout implementation(s) remain: ${dupLockouts.join(", ")}`);

// 7. Router still mounted; legacy shim is re-export-only with zero consumers.
const index = read(`${API}/routes/index.ts`);
if (!/import vaultReauthRouter from "\.\/vault-reauth"/.test(index) || !/router\.use\(vaultReauthRouter\)/.test(index)) fail("vault-reauth router is no longer mounted in routes/index.ts");
const shimTree = parse(SHIM, read(SHIM));
const bad = shimTree.statements.filter((n) => !(ts.isExportDeclaration(n) && n.moduleSpecifier));
if (bad.length) fail("lib/vault-pin-guard.ts is not a re-export-only shim");
const shimConsumers = apiFiles.filter((f) => f !== SHIM && parse(f, read(f)).statements.some((n) => (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && /(^|\/)lib\/vault-pin-guard$|^\.\/vault-pin-guard$/.test(n.moduleSpecifier.text)));
if (shimConsumers.length) fail(`legacy pin-guard shim still has consumers: ${shimConsumers.join(", ")}`);

// 8. Migration map.
const mapLines = read(MAP).split("\n");
const staleShimRow = mapLines.find((l) => l.includes("compatibility exports retained until VLT-GAP-06-D"));
if (staleShimRow) fail("migration map still says the pin-guard shim is retained until 06-D; update it");
for (const row of MAP_ROWS) if (!mapLines.includes(row)) fail(`migration map is missing row: ${row.slice(0, 80)}…`);

// 9. Behavior: executed differential (frozen route vs extracted code) + typecheck.
const diff = spawnSync("node", [DIFFERENTIAL], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
if (diff.error || diff.status !== 0) { console.error(`${diff.stdout}${diff.stderr}`.slice(-8000)); fail(`executed differential failed (exit ${diff.status ?? "unknown"})`); }
const diffSummary = diff.stdout.trim().split("\n").pop();
const tc = spawnSync("pnpm", [
  "--filter", "@workspace/api-server", "exec", "tsc",
  "--noEmit", "--skipLibCheck", "--target", "es2022", "--module", "esnext",
  "--moduleResolution", "bundler", "--types", "node", "--strict", "--customConditions", "workspace",
  "src/routes/vault-reauth.ts", "src/vault/application/security/reauth.ts",
  "src/vault/infrastructure/repositories/vault-reauth-repository.ts", "src/vault/security/reauth-ownership.ts",
  "src/vault/security/lockout.ts", "src/routes/vault-security.ts",
], { cwd: ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 12 * 1024 * 1024 });
if (tc.error || tc.status !== 0) { console.error(`${tc.stdout ?? ""}${tc.stderr ?? ""}`.slice(-12_000)); fail(`TypeScript check failed (exit ${tc.status ?? "unknown"})`); }

const paths = [ROUTE, ...NEW_FILES, SHIM, DIFFERENTIAL];
const sourceHashes = Object.fromEntries(paths.map((f) => [f, sha256File(abs(f))]));
const evidence = {
  schema_version: 1,
  phase: "VLT-GAP-06",
  sub_phase: SUB_PHASE,
  ...binding(sourceHashes),
  source_hashes: sourceHashes,
  baseline: { file: BASELINE, sha256: frozen.sha256, lines: baselineText.split("\n").length },
  route: { file: ROUTE, lines: routeText.split("\n").length, handlers: handlers.map((h) => h.key) },
  owners: NEW_FILES,
  required_symbols_found: REQUIRED_SYMBOLS,
  literal_parity: { status_codes: [...after.statuses].sort(), string_literals_lost: [], email_template_identical: true },
  security_call_parity: Object.fromEntries(Object.entries(parity).map(([k, [x, y]]) => [k, { before: x, after: y }])),
  duplicate_lockouts_remaining: [],
  legacy_shim: { file: SHIM, shape: "re-export-only", consumers: [] },
  executed_differential: diffSummary,
  typecheck: { exit_code: tc.status },
  status: "PASS",
};
fs.mkdirSync(path.dirname(abs(EVIDENCE)), { recursive: true });
fs.writeFileSync(abs(EVIDENCE), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${SUB_PHASE} PASS — route ${routeText.split("\n").length} lines (was ${baselineText.split("\n").length}), literal + security-call parity held, ${diffSummary}, typecheck clean`);
