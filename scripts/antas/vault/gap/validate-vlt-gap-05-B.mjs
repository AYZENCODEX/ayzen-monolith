#!/usr/bin/env node
// VLT-GAP-05-B — Secret/Core Actual Move / Extract (source-derived, differential, fail-closed).
// Evidence: reports/antas/vault/gap/VLT-GAP-05/extraction-proof.json
// Baseline: reports/antas/vault/gap/VLT-GAP-05/baseline/ (05-A frozen pre-extraction sources)
//           reports/antas/vault/gap/VLT-GAP-05/baseline-05b/ (write-once tree seal, see freeze-vlt-gap-05-B-baseline.mjs)
//
// 05-B proves that the secret/wallet business behavior still living in routes/vault.ts after GAP-01/02 — seed-phrase reveal
// (org extension policy → entity-PIN reveal token → decrypt → audit → charge-on-success), the fixed Drive-wallet record, the offline
// key validator and the live wallet-worth refresh — MOVED into vault/{application,infrastructure}, that the moved symbols are used,
// that the other 32 handlers are byte-identical, and — by executing the frozen OLD routes/vault.ts and the NEW tree side by side
// under identical stubs — that behavior is unchanged. The reveal-token store (routes/vault-security) belongs to GAP-06 and is
// injected as a port; health (GAP-11), snapshot (GAP-09) and shares (GAP-10) are not touched. services/vault and lib/vault-crypto
// were already composition-root / compat-adapter only; this validator proves they stay that way (no change required).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, summ, createEnv, createLoader, fakeRes, sqlKeyOf } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-05";
const SUB_PHASE = "VLT-GAP-05-B";
const HERE = fileURLToPath(import.meta.url);
const SRC = path.join(ROOT, "artifacts/api-server/src");
const ROUTES = path.join(SRC, "routes");
const EVIDENCE_DIR = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "extraction-proof.json");
const BASE = path.join(EVIDENCE_DIR, "baseline");
const BASE05B = path.join(EVIDENCE_DIR, "baseline-05b");
const R = (p) => `artifacts/api-server/src/${p}`;

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");

// ── Layout under proof ────────────────────────────────────────────────────
const bsrc = (f) => path.join(BASE, "sources", `artifacts__api-server__src__${f.replace(/\//g, "__")}`);
const OLD_ROUTE = { file: "routes/vault.ts", baseline: bsrc("routes/vault.ts") };
const NEW = {
  repo: "vault/infrastructure/repositories/secret-repository.ts",
  reveal: "vault/application/secret/reveal.ts",
  wallet: "vault/application/secret/wallet.ts",
};
const NEW_FILES = Object.values(NEW);
const CHANGED_ALLOWED = new Set([R(OLD_ROUTE.file)]);
const ADDED_ALLOWED = new Set(NEW_FILES.map(R));
const readNew = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
if (!fs.existsSync(OLD_ROUTE.baseline)) fail(`frozen 05-A baseline source missing: ${rel(OLD_ROUTE.baseline)}`);
const OLD_TEXT = fs.readFileSync(OLD_ROUTE.baseline, "utf8");
if (!fs.existsSync(path.join(BASE05B, "SEAL.json"))) fail("baseline-05b/SEAL.json missing; run freeze-vlt-gap-05-B-baseline.mjs on the 05-A tree before extraction");

// The four handlers GAP-01's gate assigned to GAP-05 (secret/wallet) and the use-case each now delegates to.
const HANDLER_MAP = [
  ["GET", "/vault/:id/seed", "reveal", "revealSeedPhrase"],
  ["PATCH", "/vault/:id/drive-wallet", "wallet", "setDriveWallet"],
  ["POST", "/vault/validate-key", "wallet", "validateSecretKey"],
  ["POST", "/vault/:id/refresh-wallet-worth", "wallet", "refreshWalletWorth"],
];
const EXTRACTED_KEYS = new Set(HANDLER_MAP.map(([m, p]) => `${m} ${p}`));
// ── AST helpers ───────────────────────────────────────────────────────────
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function walk(node, fn) { fn(node); ts.forEachChild(node, (c) => walk(c, fn)); }
function tokens(node, sf) { const t = []; (function w(n) { if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) t.push(n.getText(sf)); else n.getChildren(sf).forEach(w); })(node); const out = []; t.forEach((x, i) => { if (x === "," && [")", "]", "}"].includes(t[i + 1])) return; out.push(x); }); return out; }
const fp = (node, sf) => sha256(tokens(node, sf).join(" "));
function topDecls(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    const exported = !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(s) && s.name) out.push({ name: s.name.text, kind: "function", exported, body: s.body ? fp(s.body, sf) : null, lines: s.getText(sf).split("\n").length });
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)); out.push({ name: d.name.getText(sf), kind: fn ? "function" : "const", exported, body: d.initializer ? fp(d.initializer, sf) : null, lines: s.getText(sf).split("\n").length }); }
    else if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) out.push({ name: s.name.text, kind: "type", exported, body: null, lines: 1 });
  }
  return out;
}
const importsOf = (text, name) => { const sf = parse(name, text); return sf.statements.filter(ts.isImportDeclaration).map((s) => s.moduleSpecifier.text); };
const SQLISH = /(?:SELECT |INSERT |UPDATE |DELETE |AND |ORDER BY|BEGIN|COMMIT|ROLLBACK|WHERE )/;
function sqlLiterals(text, name) {
  const sf = parse(name, text); const out = [];
  walk(sf, (n) => {
    let t = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) t = n.text;
    else if (ts.isTemplateExpression(n)) t = n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
    if (t && t.length >= 5 && SQLISH.test(t) && !/^[A-Za-z ,.!']+$/.test(t.trim().slice(0, 3) + "") ) out.push(t.replace(/\s+/g, " ").trim());
    else if (t && t.length >= 5 && SQLISH.test(t)) out.push(t.replace(/\s+/g, " ").trim());
  });
  return out;
}
function routeTable(text, name) {
  const sf = parse(name, text); const out = [];
  const norm = (a) => ts.isIdentifier(a) ? a.text : ts.isCallExpression(a) ? `${a.expression.getText(sf)}(${a.arguments[0] && ts.isStringLiteral(a.arguments[0]) ? a.arguments[0].text : ""})` : "<expr>";
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text)) {
      const a = n.arguments; const h = a[a.length - 1];
      out.push({ method: n.expression.name.text.toUpperCase(), path: a[0].text, middleware: [...a].slice(1, -1).map(norm), handler_lines: h.getText(sf).split("\n").length, handler_text: h.getText(sf) });
    }
  });
  return out;
}

const INLINE_REFS = /\b(db|sql|chargeCredits|decryptSeedPhrase|selectVaultOne|logVaultActivity|formatRow|vaultEntriesTable|and|eq)\b|JSON\.parse|import\(|SELECT |UPDATE |INSERT |DELETE FROM/g;
const FORBIDDEN_VAULT_IMPORTS = [/^express$/, /\/routes\//, /^\.\.\/\.\.\/\.\.\/routes/];
const decl = (name, text, file) => topDecls(text, file).find((d) => d.name === name);
function routeRows(text, name) {
  const sf = parse(name, text); const out = [];
  walk(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text)) {
      const a = n.arguments; const h = a[a.length - 1];
      out.push({ method: n.expression.name.text.toUpperCase(), path: a[0].text, middleware: [...a].slice(1, -1).map((x) => x.getText(sf).replace(/\s+/g, " ")), handler_fp: fp(h, sf), handler_lines: h.getText(sf).split("\n").length, handler_text: h.getText(sf) });
    }
  });
  return out;
}
function nonRouteSymbols(text, name) {
  const sf = parse(name, text); const out = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s)) continue;
    if (ts.isExpressionStatement(s) && /^router\./.test(s.expression.getText(sf))) continue;
    if (ts.isFunctionDeclaration(s) && s.name) out.push({ key: s.name.text, fp: fp(s, sf) });
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) out.push({ key: d.name.getText(sf), fp: fp(d, sf) });
    else if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) out.push({ key: s.name.text, fp: fp(s, sf) });
    else if (ts.isExportAssignment(s)) out.push({ key: "export-default", fp: fp(s, sf) });
    else out.push({ key: `stmt@${sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1}`, fp: fp(s, sf) });
  }
  return out;
}
const namedImports = (text, name) => { const sf = parse(name, text); const out = new Map(); for (const s of sf.statements) if (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)) for (const e of s.importClause.namedBindings.elements) out.set(e.name.text, s.moduleSpecifier.text); return out; };

function staticProof() {
  const checks = []; const add = (name, passed, details = "") => checks.push({ name, passed: !!passed, details });
  const newTxt = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [k, readNew(f)]));
  const routeNew = readNew(OLD_ROUTE.file);
  const units = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [f, topDecls(newTxt[k], f)]));
  for (const f of NEW_FILES) add(`destination-exists:${f}`, fs.existsSync(path.join(SRC, f)));
  const fnCount = (k) => units[NEW[k]].filter((d) => d.kind === "function").length;
  add("destination:repository-has-executable-implementation", fnCount("repo") >= 3, `${fnCount("repo")} functions`);
  add("destination:reveal-use-case-has-executable-implementation", fnCount("reveal") >= 1 && decl("revealSeedPhrase", newTxt.reveal, NEW.reveal)?.lines >= 30, `${decl("revealSeedPhrase", newTxt.reveal, NEW.reveal)?.lines} lines`);
  add("destination:wallet-use-cases-have-executable-implementation", fnCount("wallet") >= 3, `${fnCount("wallet")} functions`);

  // route table parity + every non-extracted handler is byte-identical
  const before = routeRows(OLD_TEXT, "old-vault"), after = routeRows(routeNew, "new-vault");
  const sig = (x) => x.map((r) => `${r.method} ${r.path} [${r.middleware.join(" > ")}]`);
  add("routes:table-unchanged (order, paths, middleware chains)", JSON.stringify(sig(before)) === JSON.stringify(sig(after)), `${before.length} → ${after.length} routes`);
  add("routes:census-36", before.length === 36 && after.length === 36, `${before.length}/${after.length}`);
  const changedHandlers = before.filter((b, i) => after[i] && b.handler_fp !== after[i].handler_fp).map((b) => `${b.method} ${b.path}`);
  add("routes:only-the-four-secret-wallet-handlers-changed", JSON.stringify(changedHandlers.sort()) === JSON.stringify([...EXTRACTED_KEYS].sort()), changedHandlers.join(", "));
  const handlerRows = [];
  const dests = { reveal: NEW.reveal, wallet: NEW.wallet };
  for (const [m, p, nk, fn] of HANDLER_MAP) {
    const b = before.find((r) => r.method === m && r.path === p), a = after.find((r) => r.method === m && r.path === p);
    const refsB = (b?.handler_text.match(INLINE_REFS) ?? []).length, refsA = (a?.handler_text.match(INLINE_REFS) ?? []).length;
    const delegates = !!a && new RegExp(`\\b${fn}\\(`).test(a.handler_text);
    const defined = units[dests[nk]].some((d) => d.name === fn && d.exported);
    const mapper = !!a && /res\.status\(out\.status\)\.json\(out\.body\);/.test(a.handler_text);
    handlerRows.push({ method: m, path: p, old_handler_lines: b?.handler_lines, new_handler_lines: a?.handler_lines, old_inline_refs: refsB, new_inline_refs: refsA, delegates_to: `${R(dests[nk])}#${fn}` });
    add(`handler-extracted:${m} ${p}`, !!b && !!a && refsB > 0 && refsA === 0 && delegates && defined && mapper, JSON.stringify({ refsB, refsA, delegates, defined, mapper }));
  }
  // top-level symbols: everything else in vault.ts is untouched
  const oldSyms = nonRouteSymbols(OLD_TEXT, "old"), newSyms = nonRouteSymbols(routeNew, "new");
  const lost = oldSyms.filter((o) => !newSyms.some((n) => n.key === o.key && n.fp === o.fp)).map((o) => o.key);
  const gained = newSyms.filter((n) => !oldSyms.some((o) => o.key === n.key)).map((n) => n.key);
  add("symbols:every-non-route-symbol-of-vault.ts-is-token-identical (health, deps, router, default)", lost.length === 0, lost.join(", "));
  add("symbols:only-new-top-level-symbol-is-secretDeps-wiring", JSON.stringify(gained) === JSON.stringify(["secretDeps"]), gained.join(", "));
  add("symbols:secretDeps-is-plain-port-wiring", /^const secretDeps: SecretRevealDeps = \{ consumeRevealToken, hasNoEntityPin \};$/m.test(routeNew));
  // imports: only the expected moved names left, only the use-cases arrived
  const io = namedImports(OLD_TEXT, "old"), inn = namedImports(routeNew, "new");
  const removed = [...io.keys()].filter((k) => !inn.has(k)).sort(), addedI = [...inn.keys()].filter((k) => !io.has(k)).sort();
  add("imports:removed-only-the-moved-implementation-names", JSON.stringify(removed) === JSON.stringify(["chargeCredits", "decryptSeedPhrase", "sql"]), removed.join(", "));
  add("imports:added-only-the-secret-use-cases-and-deps-type", JSON.stringify(addedI) === JSON.stringify(["SecretRevealDeps", "refreshWalletWorth", "revealSeedPhrase", "setDriveWallet", "validateSecretKey"]), addedI.join(", "));
  add("imports:vault.ts-no-longer-uses-moved-names", !/\b(decryptSeedPhrase|chargeCredits)\b/.test(routeNew.replace(/\/\/.*$/gm, "")) && !/\bsql`/.test(routeNew));
  // SQL / Drizzle parity: statements present in old vault.ts == statements in new vault.ts + secret-repository, exactly
  const sqlOld = [...sqlLiterals(OLD_TEXT, "old")].sort();
  const sqlNew = [...sqlLiterals(routeNew, "new-route"), ...sqlLiterals(newTxt.repo, "repo")].sort();
  add("sql:statement-multiset-identical-old-vs-new", JSON.stringify(sqlOld) === JSON.stringify(sqlNew), `old=${sqlOld.length} new=${sqlNew.length}`);
  add("sql:no-sql-in-application-or-route-seed-handler", [newTxt.reveal, newTxt.wallet].every((t) => sqlLiterals(t, "x").length === 0) && !/organization_members/.test(routeNew));
  const upd = (t) => (t.match(/db\.update\(vaultEntriesTable\)/g) ?? []).length;
  add("drizzle:update-chains-moved-not-copied", upd(OLD_TEXT) === upd(routeNew) + upd(newTxt.repo) && upd(newTxt.repo) === 2 && upd(newTxt.reveal) + upd(newTxt.wallet) === 0, `old=${upd(OLD_TEXT)} route=${upd(routeNew)} repo=${upd(newTxt.repo)}`);
  const scope = (t) => (t.match(/and\(eq\(vaultEntriesTable\.id, id\), eq\(vaultEntriesTable\.userId, userId\)\)/g) ?? []).length;
  add("security:both-repository-updates-are-scoped-by-id-and-userId", scope(newTxt.repo) === 2);
  add("security:org-policy-query-moved-verbatim (disable_seed_reveal, active members, LIMIT 1)", /organization_members om[\s\S]*om\.status = 'active' AND oep\.disable_seed_reveal = TRUE[\s\S]*LIMIT 1/.test(newTxt.repo) && /organization_members om[\s\S]*om\.status = 'active' AND oep\.disable_seed_reveal = TRUE[\s\S]*LIMIT 1/.test(OLD_TEXT));
  // duplicates
  const byBody = new Map(); for (const [f, ds] of Object.entries(units)) for (const d of ds) if (d.body && d.kind === "function" && d.lines > 2) byBody.set(d.body, [...(byBody.get(d.body) ?? []), `${f}#${d.name}`]);
  const dupFn = [...byBody.values()].filter((v) => v.length > 1);
  add("duplicates:no-function-body-duplicated-across-destination", dupFn.length === 0, JSON.stringify(dupFn));
  const dupSql = [...new Set(sqlNew)].filter((s) => sqlNew.filter((x) => x === s).length > sqlOld.filter((x) => x === s).length);
  add("duplicates:no-sql-statement-implemented-twice", dupSql.length === 0, dupSql.join(" | "));
  const reDecl = ["revealSeedPhrase", "setDriveWallet", "validateSecretKey", "refreshWalletWorth", "selectOrgSeedRevealBlock", "updateVaultDriveWallet", "updateVaultWalletWorth"].filter((n) => nonRouteSymbols(routeNew, "n").some((s) => s.key === n));
  add("duplicates:moved-implementation-not-redeclared-in-route", reDecl.length === 0, reDecl.join(", "));
  // every exported destination symbol is used
  const allSrc = { ...Object.fromEntries(NEW_FILES.map((f) => [f, readNew(f)])), [OLD_ROUTE.file]: routeNew };
  const unused = [];
  for (const [f, ds] of Object.entries(units)) for (const d of ds) { if (d.kind === "type" || !d.exported) continue; const uses = Object.entries(allSrc).reduce((n, [g, t]) => n + (t.match(new RegExp(`\\b${d.name}\\b`, "g")) ?? []).length - (g === f ? 1 : 0), 0); if (uses < 1) unused.push(`${f}#${d.name}`); }
  add("usage:every-exported-destination-symbol-is-used", unused.length === 0, unused.join(", "));
  // layering
  const imp = Object.fromEntries(Object.entries(NEW).map(([k, f]) => [k, importsOf(newTxt[k], f)]));
  add("layering:repository-only-db-and-drizzle", imp.repo.every((i) => ["@workspace/db", "drizzle-orm"].includes(i)), imp.repo.join(", "));
  add("layering:application-does-not-touch-http-or-db-directly", [...imp.reveal, ...imp.wallet].every((i) => !/^express$|@workspace\/db|drizzle-orm|\/routes\//.test(i)) && !/\b(Request|Response|req|res)\b/.test(newTxt.reveal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") + newTxt.wallet.replace(/\/\/.*$/gm, "")), "");
  add("layering:application-reaches-persistence-only-via-repositories", imp.reveal.some((i) => /repositories\/secret-repository$/.test(i)) && imp.wallet.some((i) => /repositories\/secret-repository$/.test(i)) && imp.reveal.some((i) => /repositories\/entity-repository$/.test(i)), "");
  add("layering:no-inner-vault-layer-imports-a-route (vault/api is the HTTP barrel and is excluded by definition)", walkFiles(path.join(SRC, "vault"), [], (p) => /\.ts$/.test(p) && !/\/vault\/api\//.test(p)).every((f) => !/from\s+["'](?:\.\.\/)+routes\//.test(fs.readFileSync(f, "utf8"))), "");
  add("layering:reveal-token-store-is-an-injected-port-not-an-import", !/vault-security|consumeRevealToken\s*[,}]\s*from/.test(newTxt.reveal.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").split("export interface SecretRevealDeps")[0]) && /hasNoEntityPin: \(userId: number\) => Promise<boolean>/.test(newTxt.reveal) && /consumeRevealToken: \(userId: number, token: string \| undefined \| null\) => boolean/.test(newTxt.reveal), "");
  // reveal gate order is structural, not only behavioural
  const body = newTxt.reveal; const pos = (s) => body.indexOf(s);
  add("security:reveal-gate-order (org policy → pin/token → lookup → seed present → decrypt → audit → charge)", [pos("selectOrgSeedRevealBlock("), pos("deps.hasNoEntityPin("), pos("deps.consumeRevealToken("), pos("selectVaultOne("), pos("encSeed"), pos("decryptSeedPhrase("), pos('logVaultActivity(id, userId, "seed_revealed")'), pos("chargeCredits(")].every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])), "");
  add("security:charge-only-after-successful-decrypt", pos("chargeCredits(") > pos("if (!plaintext)") && (body.match(/chargeCredits\(/g) ?? []).length === 1);
  // Behavior ownership (GAP-05 required behaviors), each verified against source, with explicit deferrals
  const own = [];
  const verify = (behavior, file, sym, routeNeedle, note) => { const t = fs.existsSync(path.join(SRC, file)) ? fs.readFileSync(path.join(SRC, file), "utf8") : ""; const d = t ? topDecls(t, file).find((x) => x.name === sym) : null; const used = routeNeedle ? new RegExp(routeNeedle).test(routeNew) : true; own.push({ behavior, owner: `${R(file)}#${sym}`, exists: !!d?.exported, route_uses_it: used, note }); add(`ownership:${behavior}→${sym}`, !!d?.exported && used, JSON.stringify({ exists: !!d?.exported, used })); };
  verify("secret-creation", "vault/application/entity/create.ts", "createEntity", "\\bcreateEntity\\(", "POST /vault (GAP-01-B)");
  verify("secret-listing", "vault/application/entity/lifecycle.ts", "listEntities", "\\blistEntities\\(", "GET /vault (GAP-01-B)");
  verify("secret-reveal", "vault/application/secret/reveal.ts", "revealSeedPhrase", "\\brevealSeedPhrase\\(", "GET /vault/:id/seed (05-B); GET /vault/:id reveal is entity/lifecycle#getEntity");
  verify("versioning", "vault/application/entity/update.ts", "updateEntityField", "\\bupdateEntityField\\(", "field change + commit history (GAP-01-B)");
  verify("tenant-scope", "vault/security/entity-ownership.ts", "requireVaultEntryOwnership", "\\brequireVaultEntryOwnership\\(", "per-route ownership gate (GAP-01-B)");
  verify("audit", "vault/application/entity/activity.ts", "logVaultActivity", null, "used by the secret use-cases (seed_revealed, drive_wallet_set, wallet_worth_refreshed)");
  verify("events", "vault/application/entity/lifecycle.ts", "trashEntity", "\\blifecycleDeps\\b", "SSE broadcaster injected as a port (routes/events, API layer)");
  own.push({ behavior: "step-up", owner: "artifacts/api-server/src/routes/vault-security.ts#consumeRevealToken/hasNoEntityPin", exists: /export (async )?function (consumeRevealToken|hasNoEntityPin)/.test(fs.readFileSync(path.join(SRC, "routes/vault-security.ts"), "utf8")), route_uses_it: /\bsecretDeps\b/.test(routeNew), note: "single-use reveal-token store stays in routes/vault-security (GAP-06 owns the security/access surface); 05-B injects it into the reveal use-case as a port, so the use-case enforces the step-up gate but does not own the token store. DEFERRED to GAP-06." });
  add("ownership:step-up-gate-enforced-by-the-use-case-with-token-store-deferred-to-GAP-06", own.at(-1).exists && own.at(-1).route_uses_it);
  // services/vault + lib/vault-crypto need no extraction: prove they are composition-root / compat-adapter only and unchanged
  const idx = fs.readFileSync(path.join(ROOT, "services/vault/src/index.mjs"), "utf8"); const idxSf = parse("index.mjs", idx);
  const idxBad = idxSf.statements.filter((s) => !(ts.isImportDeclaration(s) || ts.isVariableStatement(s) || (ts.isExpressionStatement(s) && /^createServiceServer\(/.test(s.expression.getText(idxSf)))));
  const idxCtl = []; walk(idxSf, (n) => { if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isSwitchStatement(n) || ts.isTryStatement(n)) idxCtl.push(n.getText(idxSf).slice(0, 40)); });
  add("service-entry:index.mjs-is-composition-root-only (imports, wiring consts, createServiceServer(...).start)", idxBad.length === 0 && idxCtl.length === 0, idxBad.map((s) => s.getText(idxSf).slice(0, 60)).join(" | ") + idxCtl.join(" | "));
  const vc = fs.readFileSync(path.join(SRC, "lib/vault-crypto.ts"), "utf8"); const vcSf = parse("vault-crypto.ts", vc);
  add("compat:lib/vault-crypto.ts-is-a-pure-reexport-of-vault/crypto/field-encryption", vcSf.statements.length > 0 && vcSf.statements.every((s) => ts.isExportDeclaration(s) && s.moduleSpecifier && /vault\/crypto\/field-encryption$/.test(s.moduleSpecifier.text)) && fs.existsSync(path.join(SRC, "vault/crypto/field-encryption.ts")));
  const man = JSON.parse(fs.readFileSync(path.join(BASE05B, "tree-manifest.json"), "utf8")).files;
  add("scope:service-and-compat-sources-byte-identical-to-the-05A-seal", ["services/vault/src/index.mjs", R("lib/vault-crypto.ts"), R("routes/vault-security.ts")].every((f) => man[f] === sha256File(path.join(ROOT, f))));
  return { checks, handlerRows, units, ownership: own, routeBefore: before, routeAfter: after, oldSqlCount: sqlOld.length, newSqlCount: sqlNew.length, duplicates: { sql: dupSql, functions: dupFn, redeclared: reDecl }, lost, gained, removed, addedI };
}

// ── 2. Differential harness (frozen OLD routes/vault.ts vs NEW tree, identical stubs) ──────────────────
const K = sqlKeyOf;
const ok = (v) => ({ value: v });
const boom = (m = "boom") => ({ throw: m });
const tableProxy = (name) => new Proxy({ __table: name }, { get: (t, p) => (p === "__table" ? name : typeof p === "symbol" || p === "then" ? undefined : { __col: `${name}.${String(p)}` }) });
function makeEnv(c) {
  const env = createEnv(c.script ?? {}); const st = env.stubs; const log = env.log;
  const f = c.flags ?? {};
  st["@workspace/db"].valueHistoryTable = tableProxy("valueHistoryTable");
  st["routes/events"] = { broadcastEvent: (...a) => { log.push(["broadcastEvent", summ(a)]); } };
  st["routes/notifications"] = { createNotification: async (...a) => { log.push(["createNotification", summ(a)]); } };
  st["lib/telegram"] = { sendToUser: async (...a) => { log.push(["sendToUser", summ(a)]); } };
  st["lib/receipt-theme"] = { streamFantasticReceiptPdf: () => {} };
  st["routes/vault-security"] = {
    hasNoEntityPin: async (uid) => { log.push(["hasNoEntityPin", uid]); if (f.pinThrows) throw new Error("pin store down"); return f.pinless === true; },
    consumeRevealToken: (uid, tok) => { log.push(["consumeRevealToken", summ([uid, tok])]); return tok === "good"; },
  };
  st["services/credit-meter"] = {
    chargeCredits: async (...a) => { log.push(["chargeCredits", summ(a)]); if (f.chargeThrows) throw new Error("ledger down"); return f.chargeFails ? { ok: false } : { ok: true, charged: 25, newBalance: 75 }; },
    requireCreditBalance: (k) => { const m = () => {}; Object.defineProperty(m, "name", { value: `requireCreditBalance(${k})` }); m.__stub = `requireCreditBalance(${k})`; return m; },
  };
  st["vault/crypto/seed-phrase"] = { decryptSeedPhrase: (v) => { log.push(["decryptSeedPhrase", v]); return v === "BAD" ? null : `unseed(${v})`; }, encryptSeedPhrase: (v) => v };
  st["vault/application/entity/representation"] = { formatVaultEntry: (e) => ({ ...e, formatted: true }) };
  st["vault/infrastructure/repositories/entity-repository"] = {
    selectVaultOne: async (id, uid) => { log.push(["selectVaultOne", [id, uid]]); if (f.entryThrows) throw new Error("select failed"); return f.entry === undefined ? null : f.entry; },
    selectVault: async () => [],
  };
  st["lib/wallet-key-validation"] = { validateWalletKey: (v) => { log.push(["validateWalletKey", v]); return { valid: true, kind: "mnemonic", wordCount: 12 }; } };
  st["lib/chain-balance"] = { getMultiChainWalletWorth: async (addrs) => { log.push(["getMultiChainWalletWorth", summ(addrs)]); if (f.chainThrows) throw new Error("rpc down"); return { totalUsd: 123.45, results: [{ address: addrs[0], balance: 1.5, error: null }, { address: "z", balance: 0, error: null }, { address: "e", balance: 0, error: "rpc" }] }; } };
  for (const m of ["lifecycle", "create", "update", "bulk", "analytics", "activity-feed", "admin", "receipt"]) st[`vault/application/entity/${m}`] = {};
  st["vault/application/health"] = { computeAutoScore: () => 5, evalHealthRules: () => [], severityEmoji: () => "!" };
  st["vault/application/local-account/bridge"] = { autoCreateLocalAccountsForEntity: async () => {} };
  return env;
}
const loadOld = (env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadText(OLD_TEXT, OLD_ROUTE.file, ROUTES);
const loadNew = (env) => createLoader({ ts, root: ROOT, srcDir: SRC, env }).loadFile(path.join(SRC, OLD_ROUTE.file));
const U = 7;
const SEED_ROW = { id: 5, encrypted_seed_phrase: "ENC", drive_wallet_address: null };
const ORG_Q = K("SELECT 1 FROM organization_members");
const UPD = "db.update:vaultEntriesTable";
const mk = (name, cat, method, p, req, flags, script) => ({ name, cat, method, path: p, req: { params: { id: "5" }, query: {}, body: {}, headers: {}, ...req }, flags, script });
const seed = (name, cat, req, flags, script) => mk(name, cat, "GET", "/vault/:id/seed", req, { entry: SEED_ROW, ...flags }, script);
const dw = (name, cat, body, flags, script, req) => mk(name, cat, "PATCH", "/vault/:id/drive-wallet", { body, ...req }, { entry: { id: 5 }, ...flags }, script);
const rw = (name, cat, flags, script, req) => mk(name, cat, "POST", "/vault/:id/refresh-wallet-worth", { ...req }, { entry: { id: 5, wallet_addresses: '["0xaaa","0xbbb"]', drive_wallet_address: "0xdrive" }, ...flags }, script);
const GOOD = { headers: { "x-reveal-token": "good" } };
const CASES = [
  // ── GET /vault/:id/seed ──
  seed("seed: pinless user reveals (no token needed)", "success", {}, { pinless: true }),
  seed("seed: reveal token in header", "success", GOOD, {}),
  seed("seed: reveal token in query", "success", { query: { revealToken: "good" } }, {}),
  seed("seed: header token wins over query token", "security", { headers: { "x-reveal-token": "bad" }, query: { revealToken: "good" } }, {}),
  seed("seed: camelCase encryptedSeedPhrase column variant", "success", GOOD, { entry: { id: 5, encryptedSeedPhrase: "ENC2" } }),
  seed("seed: charge response not ok → _credits null", "success", GOOD, { chargeFails: true }),
  seed("seed: org extension policy blocks (403, before PIN/token)", "security", GOOD, {}, { [`db.execute:${ORG_Q}`]: [ok({ rows: [{ "?column?": 1 }] })] }),
  seed("seed: token missing → 403 REVEAL_TOKEN_REQUIRED", "security", {}, {}),
  seed("seed: token wrong → 403", "security", { headers: { "x-reveal-token": "stale" } }, {}),
  seed("seed: entry not found → 404", "failure", GOOD, { entry: null }),
  seed("seed: no seed stored → 404", "failure", GOOD, { entry: { id: 5, encrypted_seed_phrase: null } }),
  seed("seed: decrypt failure → 500, no charge, no audit", "failure", GOOD, { entry: { id: 5, encrypted_seed_phrase: "BAD" } }),
  seed("seed: org query throws → rejection propagates", "failure", GOOD, {}, { [`db.execute:${ORG_Q}`]: [boom("pg down")] }),
  seed("seed: pin lookup throws → rejection propagates", "failure", GOOD, { pinThrows: true }),
  seed("seed: entry lookup throws → rejection propagates", "failure", GOOD, { entryThrows: true }),
  seed("seed: charge throws → rejection propagates after audit", "failure", GOOD, { chargeThrows: true }),
  seed("seed: other user's id still scoped by session user", "security", { ...GOOD, userId: 99 }, {}),
  seed("seed: non-numeric id → NaN passed through unchanged", "security", { ...GOOD, params: { id: "abc" } }, {}),
  seed("seed: array id param takes first", "success", { ...GOOD, params: { id: ["5", "6"] } }, {}),
  // ── PATCH /vault/:id/drive-wallet ──
  dw("drive: set label/address/note", "success", { label: "L", address: "0xabc", note: "n" }, {}, { [UPD]: [ok([{ id: 5, driveWalletAddress: "0xabc" }])] }),
  dw("drive: address trimmed, falsy label/note → null", "success", { label: "", address: "  0xabc  ", note: 0 }, {}, { [UPD]: [ok([{ id: 5 }])] }),
  dw("drive: missing address → 400", "failure", { label: "L" }, {}),
  dw("drive: whitespace address → 400", "failure", { address: "   " }, {}),
  dw("drive: entry not found → 404", "failure", { address: "0x1" }, { entry: null }),
  dw("drive: already set (snake drive_wallet_set_at) → 409", "security", { address: "0x1" }, { entry: { id: 5, drive_wallet_set_at: "2024" } }),
  dw("drive: already set (camel driveWalletSetAt) → 409", "security", { address: "0x1" }, { entry: { id: 5, driveWalletSetAt: "2024" } }),
  dw("drive: already set (address only, snake) → 409", "security", { address: "0x1" }, { entry: { id: 5, drive_wallet_address: "0xold" } }),
  dw("drive: already set (address only, camel) → 409", "security", { address: "0x1" }, { entry: { id: 5, driveWalletAddress: "0xold" } }),
  dw("drive: update returns no row (race/foreign) → 404", "security", { address: "0x1" }, {}, { [UPD]: [ok([])] }),
  dw("drive: update throws → 500 with detail", "failure", { address: "0x1" }, {}, { [UPD]: [boom("write failed")] }),
  dw("drive: select throws → rejection propagates", "failure", { address: "0x1" }, { entryThrows: true }),
  dw("drive: injection-shaped address is stored verbatim via ORM", "security", { address: "0x'; DROP TABLE vault_entries;--" }, {}, { [UPD]: [ok([{ id: 5 }])] }),
  dw("drive: update scoped to session user", "security", { address: "0x1" }, {}, { [UPD]: [ok([{ id: 5 }])] }, { userId: 42 }),
  // ── POST /vault/validate-key ──
  mk("validate-key: valid mnemonic", "success", "POST", "/vault/validate-key", { body: { value: "word ".repeat(12) } }, {}),
  mk("validate-key: value with surrounding spaces is passed untrimmed", "success", "POST", "/vault/validate-key", { body: { value: "  0xkey  " } }, {}),
  mk("validate-key: missing value → 400", "failure", "POST", "/vault/validate-key", { body: {} }, {}),
  mk("validate-key: blank value → 400", "failure", "POST", "/vault/validate-key", { body: { value: "   " } }, {}),
  mk("validate-key: non-string value → 400", "failure", "POST", "/vault/validate-key", { body: { value: 123 } }, {}),
  mk("validate-key: no network/db access (pure offline)", "security", "POST", "/vault/validate-key", { body: { value: "k" } }, {}),
  // ── POST /vault/:id/refresh-wallet-worth ──
  rw("worth: addresses + drive address, update ok", "success", {}, { [UPD]: [ok([{ id: 5, walletWorthSyncedAt: "2026-01-01" }])] }),
  rw("worth: camelCase column variants", "success", { entry: { id: 5, walletAddresses: '["0x1"]', driveWalletAddress: "0xd" } }, { [UPD]: [ok([{ id: 5 }])] }),
  rw("worth: drive address only", "success", { entry: { id: 5, drive_wallet_address: "0xd" } }, { [UPD]: [ok([{ id: 5 }])] }),
  rw("worth: invalid JSON addresses → treated as empty, drive added", "failure", { entry: { id: 5, wallet_addresses: "{bad", drive_wallet_address: "0xd" } }, { [UPD]: [ok([{ id: 5 }])] }),
  rw("worth: no addresses → 400, no rpc", "failure", { entry: { id: 5, wallet_addresses: "[]" } }),
  rw("worth: wallet_addresses null → 400", "failure", { entry: { id: 5 } }),
  rw("worth: entry not found → 404", "failure", { entry: null }),
  rw("worth: rpc throws → 500 with detail, nothing written", "failure", { chainThrows: true }),
  rw("worth: update returns no row → 404", "security", {}, { [UPD]: [ok([])] }),
  rw("worth: update throws → 500", "failure", {}, { [UPD]: [boom("write failed")] }),
  rw("worth: select throws → rejection propagates", "failure", { entryThrows: true }),
  rw("worth: update scoped to session user", "security", {}, { [UPD]: [ok([{ id: 5 }])] }, { userId: 42 }),
];
async function runCase(loader, c, overrides) {
  const env = makeEnv(c); if (overrides) env.overrides = overrides;
  try { loader(env); } catch (e) { return { loadError: String(e.message ?? e), log: env.log }; }
  const loadLog = env.log.splice(0);
  const route = env.routes.find((r) => r.method === c.method && r.path === c.path);
  if (!route) return { missing: `${c.method} ${c.path}` };
  const stack = route.stack.slice(0, -1).map((m) => { const s = { name: m?.__stub ?? m?.name ?? "anon" }; if (m?.__ownership) { const rr = fakeRes(); m.__ownership.opts.onDeny({}, rr); s.ownership = { action: m.__ownership.action, deny: { status: rr.statusCode, body: summ(rr.body) } }; } return s; });
  const hdrs = c.req.headers ?? {};
  const req = { user: { userId: c.req.userId ?? U }, params: c.req.params, query: c.req.query, body: c.req.body, header: (n) => hdrs[String(n).toLowerCase()] };
  const res = fakeRes(); let thrown = null;
  const RealDate = globalThis.Date; const FROZEN = RealDate.parse("2026-01-01T00:00:00.000Z");
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); } static now() { return FROZEN; } };
  const oe = console.error; console.error = (...a) => env.log.push(["console.error", String(a[0]).slice(0, 60)]);
  try { await route.stack[route.stack.length - 1](req, res); } catch (e) { thrown = e?.message ?? "Error"; }
  await new Promise((x) => setTimeout(x, 5));
  globalThis.Date = RealDate; console.error = oe;
  return { statusCode: res.statusCode ?? 200, body: summ(res.body), thrown, stack, loadLog, log: env.log };
}
const canon = (r) => JSON.stringify(r) ?? "undefined";
let OLD_CACHE = null;
async function oldResults() { if (!OLD_CACHE) { OLD_CACHE = []; for (const c of CASES) OLD_CACHE.push(await runCase(loadOld, c)); } return OLD_CACHE; }
async function differentialSuite(overrides) {
  const olds = await oldResults(); const out = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i]; const a = olds[i]; const b = await runCase(loadNew, c, overrides); const diffs = [];
    if (b.loadError || b.missing || a.loadError || a.missing) diffs.push(`load/route problem: old=${a.loadError ?? a.missing ?? "ok"} new=${b.loadError ?? b.missing ?? "ok"}`);
    else for (const f of Object.keys({ ...a, ...b })) if (canon(a[f]) !== canon(b[f])) diffs.push(`${f}: old=${canon(a[f])?.slice(0, 140)} new=${canon(b[f])?.slice(0, 140)}`);
    out.push({ name: c.name, category: c.cat, method: c.method, path: c.path, passed: diffs.length === 0, diffs, log_entries: Array.isArray(b.log) ? b.log.length : 0 });
  }
  return out;
}
async function securitySuite() {
  const res = []; const add = (name, passed, details = "") => res.push({ name: `security:${name}`, passed: !!passed, details });
  const get = async (n) => { const i = CASES.findIndex((c) => c.name === n); if (i < 0) throw new Error(`case ${n}`); return runCase(loadNew, CASES[i]); };
  const L = (r) => r.log.map((e) => JSON.stringify(e)); const has = (r, s) => L(r).some((x) => x.includes(s));
  const idx = (r, s) => L(r).findIndex((x) => x.includes(s));
  let r = await get("seed: reveal token in header");
  add("reveal-returns-plaintext-and-charges-exactly-once-after-decrypt", r.statusCode === 200 && r.body?.seedPhrase === "unseed(ENC)" && L(r).filter((x) => x.includes("chargeCredits")).length === 1 && idx(r, "chargeCredits") > idx(r, "decryptSeedPhrase"));
  add("audit-entry-written-on-success (seed_revealed)", has(r, "seed_revealed"));
  add("reveal-token-checked-with-the-session-user", L(r).some((x) => x.includes("consumeRevealToken") && x.includes("good") && x.includes("7")));
  r = await get("seed: org extension policy blocks (403, before PIN/token)");
  add("org-policy-blocks-before-pin-or-token-and-never-charges", r.statusCode === 403 && r.body?.code === "ORG_SEED_REVEAL_DISABLED" && !has(r, "hasNoEntityPin") && !has(r, "consumeRevealToken") && !has(r, "decryptSeedPhrase") && !has(r, "chargeCredits"));
  r = await get("seed: token missing → 403 REVEAL_TOKEN_REQUIRED");
  add("missing-token-blocks-before-any-entry-read-decrypt-or-charge", r.statusCode === 403 && r.body?.code === "REVEAL_TOKEN_REQUIRED" && !has(r, "selectVaultOne") && !has(r, "decryptSeedPhrase") && !has(r, "chargeCredits"));
  r = await get("seed: token wrong → 403"); add("wrong-token-is-rejected", r.statusCode === 403 && !has(r, "decryptSeedPhrase"));
  r = await get("seed: pinless user reveals (no token needed)"); add("pinless-user-skips-token-but-still-passes-org-policy-and-lookup", r.statusCode === 200 && !has(r, "consumeRevealToken") && idx(r, "selectVaultOne") > idx(r, "hasNoEntityPin"));
  r = await get("seed: decrypt failure → 500, no charge, no audit"); add("decrypt-failure-never-charges-or-audits", r.statusCode === 500 && !has(r, "chargeCredits") && !has(r, "vaultActivityLogTable") && !has(r, "db.insert"));
  r = await get("seed: no seed stored → 404"); add("missing-seed-never-charges", r.statusCode === 404 && !has(r, "chargeCredits") && !has(r, "decryptSeedPhrase"));
  r = await get("seed: other user's id still scoped by session user"); add("entry-lookup-uses-the-session-user-not-the-url", L(r).some((x) => x.includes("selectVaultOne") && x.includes("[5,99]")));
  r = await get("drive: already set (snake drive_wallet_set_at) → 409"); add("drive-wallet-is-write-once-and-never-updates-when-set", r.statusCode === 409 && !has(r, "db.update"));
  r = await get("drive: update scoped to session user"); add("drive-wallet-update-binds-id-and-session-user", L(r).some((x) => x.includes("db.update.where") && x.includes("42")) && has(r, "drive_wallet_set"));
  r = await get("drive: injection-shaped address is stored verbatim via ORM"); add("drive-wallet-address-goes-through-orm-not-sql-text", has(r, "DROP TABLE vault_entries") && !L(r).some((x) => x.includes("db.execute") && x.includes("DROP TABLE")));
  r = await get("drive: missing address → 400"); add("drive-wallet-validation-precedes-any-read-or-write", r.statusCode === 400 && !has(r, "selectVaultOne") && !has(r, "db.update"));
  r = await get("worth: rpc throws → 500 with detail, nothing written"); add("failed-rpc-writes-nothing-and-logs-no-activity", r.statusCode === 500 && !has(r, "db.update") && !has(r, "wallet_worth_refreshed"));
  r = await get("worth: no addresses → 400, no rpc"); add("no-addresses-makes-no-rpc-call", r.statusCode === 400 && !has(r, "getMultiChainWalletWorth"));
  r = await get("worth: addresses + drive address, update ok"); add("rpc-receives-wallet-addresses-then-drive-address", has(r, '["getMultiChainWalletWorth"') && has(r, "0xaaa") && has(r, "0xdrive") && idx(r, "0xdrive") >= 0 && r.body?.walletWorthUsd === 123.45 && r.body?.breakdown?.length === 2);
  r = await get("validate-key: no network/db access (pure offline)"); add("key-validation-touches-no-db-and-no-rpc", r.statusCode === 200 && !has(r, "db.") && !has(r, "getMultiChainWalletWorth") && has(r, "validateWalletKey"));
  r = await get("validate-key: blank value → 400"); add("blank-key-never-reaches-the-validator", r.statusCode === 400 && !has(r, "validateWalletKey"));
  return res;
}

// ── 3. Mutation tests: seeded regressions in the NEW tree must be caught ──
const MUT_ROUTE = OLD_ROUTE.file;
const MUTATIONS = [
  [NEW.reveal, "org extension policy ignored", "if (orgBlock.length) {", "if (false) {"],
  [NEW.reveal, "org-block error code changed", `code: "ORG_SEED_REVEAL_DISABLED"`, `code: "X"`],
  [NEW.reveal, "pin gate inverted", "if (!pinless) {", "if (pinless) {"],
  [NEW.reveal, "reveal token not enforced", "if (!deps.consumeRevealToken(userId, token)) {", "if (false) {"],
  [NEW.reveal, "query token wins over header token", "(headerToken ?? queryToken)", "(queryToken ?? headerToken)"],
  [NEW.reveal, "missing-seed message changed", `"No seed phrase stored for this entity"`, `"No seed"`],
  [NEW.reveal, "decrypt failure status changed", `status: 500, body: { error: "Failed to decrypt seed phrase" }`, `status: 502, body: { error: "Failed to decrypt seed phrase" }`],
  [NEW.reveal, "audit action renamed", `"seed_revealed"`, `"seed_viewed"`],
  [NEW.reveal, "audit entry dropped", `  logVaultActivity(id, userId, "seed_revealed");\n`, ``],
  [NEW.reveal, "wrong credit action charged", `chargeCredits(userId, "sylo.credential_access")`, `chargeCredits(userId, "sylo.vault_entity_view")`],
  [NEW.reveal, "credit receipt zeroed", "charged: charge.charged", "charged: 0"],
  [NEW.reveal, "entry lookup unscoped from session user", "selectVaultOne(id, userId)", "selectVaultOne(id, 1)"],
  [NEW.reveal, "plaintext check dropped (empty plaintext revealed)", "if (!plaintext) return", "if (false) return"],
  [NEW.wallet, "drive wallet address message changed", `"Wallet address is required"`, `"Address required"`],
  [NEW.wallet, "already-set check ignores address-only variant", "?? entry.drive_wallet_address ?? (entry as any).driveWalletAddress;", ";"],
  [NEW.wallet, "already-set conflict becomes 400", `status: 409, body: { error: "Drive wallet is already set`, `status: 400, body: { error: "Drive wallet is already set`],
  [NEW.wallet, "drive wallet audit renamed", `"drive_wallet_set"`, `"x"`],
  [NEW.wallet, "worth ignores drive address", "if (driveAddress) addresses = [...addresses, driveAddress];", ""],
  [NEW.wallet, "no-address status changed", `status: 400, body: { error: "This entity has no wallet addresses to check" }`, `status: 404, body: { error: "This entity has no wallet addresses to check" }`],
  [NEW.wallet, "rpc failure status changed", `status: 500, body: { error: "Unable to refresh live wallet worth"`, `status: 502, body: { error: "Unable to refresh live wallet worth"`],
  [NEW.wallet, "breakdown filter dropped", "r.balance > 0 || r.error", "true"],
  [NEW.wallet, "validate-key accepts whitespace", "!value.trim()", "!value"],
  [NEW.wallet, "worth audit dropped", `    logVaultActivity(id, userId, "wallet_worth_refreshed");\n`, ``],
  [NEW.repo, "drive wallet update loses user scope", ".where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))", ".where(eq(vaultEntriesTable.id, id))"],
  [NEW.repo, "drive wallet address no longer trimmed", "String(w.address).trim()", "String(w.address)"],
  [NEW.repo, "drive wallet label no longer nulled", "w.label || null", "w.label"],
  [NEW.repo, "org policy ignores membership status", " AND om.status = 'active'", ""],
  [NEW.repo, "org policy ignores disable flag", " AND oep.disable_seed_reveal = TRUE", ""],
  [MUT_ROUTE, "route passes a fixed user to the reveal", "revealSeedPhrase(req.user!.userId,", "revealSeedPhrase(1,"],
  [MUT_ROUTE, "route stops sending the reveal header", `req.header("x-reveal-token")`, "undefined"],
  [MUT_ROUTE, "route always accepts reveal tokens", "{ consumeRevealToken, hasNoEntityPin }", "{ consumeRevealToken: () => true, hasNoEntityPin }"],
  [MUT_ROUTE, "route ignores the use-case status", "const out = await refreshWalletWorth(req.user!.userId, req.params.id);\n  res.status(out.status).json(out.body);", "const out = await refreshWalletWorth(req.user!.userId, req.params.id);\n  res.status(200).json(out.body);"],
  [MUT_ROUTE, "route ownership action renamed on drive-wallet", `"vault_entry.drive_wallet.update"`, `"vault_entry.drive.update"`],
  [MUT_ROUTE, "route validates the wrong body", "validateSecretKey(req.body)", "validateSecretKey(req.query)"],
];
async function mutationTests() {
  const out = [];
  for (const [file, name, from, to] of MUTATIONS) {
    const abs = path.join(SRC, file); const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(from)) { out.push({ name: `mutation:${name}`, passed: false, details: "mutation not applicable (pattern absent) — seeded regression was NOT exercised" }); continue; }
    let detected = false, how = "";
    try { const r = await differentialSuite(new Map([[abs, text.replace(from, to)]])); const bad = r.filter((x) => !x.passed); detected = bad.length > 0; how = bad.slice(0, 2).map((x) => x.name).join("; "); }
    catch (e) { detected = true; how = `load/runtime error: ${String(e.message).slice(0, 80)}`; }
    out.push({ name: `mutation:${name}`, passed: detected, details: detected ? `detected by ${how}` : "NOT detected by any differential case" });
  }
  return out;
}
// ── 4. Diff audit ─────────────────────────────────────────────────────────
function diffAudit() {
  const man = JSON.parse(fs.readFileSync(path.join(BASE05B, "tree-manifest.json"), "utf8")).files;
  const seal = JSON.parse(fs.readFileSync(path.join(BASE05B, "SEAL.json"), "utf8"));
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith("scripts/antas/vault/gap/")) now[k] = sha256File(f); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in man)) added.push(k); else if (man[k] !== v) changed.push(k); }
  for (const k of Object.keys(man)) if (!(k in now)) removed.push(k);
  const gapNow = {}; for (const f of walkFiles(path.join(ROOT, "scripts/antas/vault/gap"))) gapNow[rel(f)] = sha256File(f);
  const gapEdited = Object.entries(seal.gap_scripts_at_freeze).filter(([k, v]) => gapNow[k] !== v).map(([k]) => k);
  const unexpected = [...changed.filter((k) => !CHANGED_ALLOWED.has(k)), ...added.filter((k) => !ADDED_ALLOWED.has(k)), ...removed];
  return { changed, added, removed, unexpected, earlier_validators_edited: gapEdited, tree_manifest_sha256_matches_seal: sha256(fs.readFileSync(path.join(BASE05B, "tree-manifest.json"), "utf8")) === seal.tree_manifest_sha256 };
}

// ── 5. Degraded differential typecheck (project deps are not installed in the upload) ──
function typecheckDifferential() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const routeAbs = path.join(SRC, OLD_ROUTE.file); const newAbs = NEW_FILES.map((f) => path.join(SRC, f)); const scopeAbs = [routeAbs, ...newAbs];
  const baselineFor = new Map([[routeAbs, OLD_ROUTE.baseline]]);
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? baselineFor.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const roots = useBaseline ? [routeAbs] : scopeAbs;
    const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
    for (const f of roots) { const sf = prog.getSourceFile(f); if (!sf) continue; for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    for (const sf of prog.getSourceFiles()) {
      if (!scopeAbs.includes(sf.fileName)) continue;
      for (const d of prog.getSemanticDiagnostics(sf)) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if ([2307, 7016, 2792].includes(d.code)) { const mm = msg.match(/module '([^']+)'/) ?? msg.match(/'([^']+)'/); if (mm && !mm[1].startsWith(".")) { tally.__external_unresolved = (tally.__external_unresolved ?? 0) + 1; continue; } }
        const k = `${d.code}: ${msg.replace(/'[^']*'/g, "'…'").slice(0, 90)}`; tally[k] = (tally[k] ?? 0) + 1;
      }
    }
    return { tally, syntactic };
  };
  const before = run(true), after = run(false); const regress = [];
  for (const [k, n] of Object.entries(after.tally)) if (k !== "__external_unresolved" && n > (before.tally[k] ?? 0)) regress.push(`${k} (+${n - (before.tally[k] ?? 0)})`);
  const tot = (x) => Object.values(x).reduce((a, b) => a + b, 0);
  return { before_total: tot(before.tally), after_total: tot(after.tally), syntactic_errors: after.syntactic, new_diagnostics: regress, before_by_class: before.tally, after_by_class: after.tally };
}
// ── 6. Main ───────────────────────────────────────────────────────────────
const sourceHashes = () => Object.fromEntries([OLD_ROUTE.file, ...NEW_FILES].map((f) => [R(f), sha256File(path.join(SRC, f))]).concat(["scripts/antas/vault/gap/harness.mjs", "scripts/antas/vault/gap/gap-common.mjs"].map((f) => [f, sha256File(path.join(ROOT, f))])));
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
  const started = Date.now();
  const st = staticProof();
  const diff = await differentialSuite(); const sec = await securitySuite();
  const mut = await mutationTests(); const audit = diffAudit(); const tc = typecheckDifferential();
  const checks = [...st.checks];
  for (const r of diff) checks.push({ name: `differential:${r.name}`, passed: r.passed, details: r.diffs.join("; ") });
  for (const r of [...sec, ...mut]) checks.push({ name: r.name, passed: r.passed, details: r.details ?? "" });
  const cats = new Set(diff.map((d) => d.category));
  for (const c of ["success", "failure", "security"]) checks.push({ name: `coverage:category:${c}`, passed: cats.has(c), details: "" });
  const has = (m, p, k) => CASES.some((c) => c.method === m && c.path === p && (k ? c.cat === k : true));
  checks.push({ name: "coverage:every-extracted-route-has-success-failure-and-security-cases", passed: HANDLER_MAP.every(([m, p]) => ["success", "failure", "security"].every((k) => has(m, p, k)) || (m === "POST" && p === "/vault/validate-key" && ["success", "failure", "security"].every((k) => has(m, p, k)))), details: HANDLER_MAP.filter(([m, p]) => !["success", "failure", "security"].every((k) => has(m, p, k))).map(([m, p]) => `${m} ${p}`).join(", ") });
  checks.push({ name: "coverage:ownership-middleware-stack-compared-on-every-extracted-route", passed: HANDLER_MAP.every(([m, p]) => CASES.some((c) => c.method === m && c.path === p)), details: "" });
  checks.push({ name: "no-skipped-tests", passed: CASES.length > 0 && diff.length === CASES.length, details: `${diff.length}/${CASES.length}` });
  checks.push({ name: "differential-cases-executed-interactions", passed: diff.filter((d) => d.log_entries > 0).length >= 40, details: `${diff.filter((d) => d.log_entries > 0).length} cases recorded interactions` });
  checks.push({ name: "mutation-suite-size", passed: mut.length >= 30, details: `${mut.length} seeded regressions` });
  checks.push({ name: "diff-audit:no-unrelated-changes", passed: audit.unexpected.length === 0, details: audit.unexpected.join(", ") });
  checks.push({ name: "diff-audit:no-earlier-validator-edited", passed: audit.earlier_validators_edited.length === 0, details: audit.earlier_validators_edited.join(", ") });
  checks.push({ name: "diff-audit:baseline-seal-intact", passed: audit.tree_manifest_sha256_matches_seal, details: "" });
  checks.push({ name: "diff-audit:every-declared-destination-file-was-added-and-vault.ts-changed", passed: [...ADDED_ALLOWED].every((f) => audit.added.includes(f)) && [...CHANGED_ALLOWED].every((f) => audit.changed.includes(f)), details: canon({ added: audit.added, changed: audit.changed }) });
  checks.push({ name: "typecheck:no-syntax-errors", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join("; ") });
  checks.push({ name: "typecheck:no-new-diagnostics-vs-baseline", passed: tc.new_diagnostics.length === 0, details: tc.new_diagnostics.join("; ") });
  const exit_codes = { differential_suite: diff.every((d) => d.passed) ? 0 : 1, security_suite: sec.every((d) => d.passed) ? 0 : 1, mutation_suite: mut.every((d) => d.passed) ? 0 : 1, typecheck_differential: tc.new_diagnostics.length === 0 && tc.syntactic_errors.length === 0 ? 0 : 1 };
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const b = binding(hashes);
  const thin = (t) => ({ routes: t.length, with_inline_refs: t.filter((r) => (r.handler_text.match(INLINE_REFS) ?? []).length > 0).length, handler_lines: t.reduce((a, r) => a + r.handler_lines, 0) });
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE, commit_sha: b.commit_sha, commit_binding: b.commit_binding, source_tree_sha256: b.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE), source_hashes: hashes,
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-05-B.mjs", "in-process differential suite (frozen baseline routes/vault.ts vs new source)", "in-process seeded-mutation suite", "in-process differential typecheck"],
    exit_codes,
    symbols_moved: st.handlerRows.map((h) => `${R(OLD_ROUTE.file)}#${h.method} ${h.path} → ${h.delegates_to}`).concat(["routes/vault.ts inline db.execute(org policy) → vault/infrastructure/repositories/secret-repository.ts#selectOrgSeedRevealBlock", "routes/vault.ts inline db.update(drive wallet) → secret-repository.ts#updateVaultDriveWallet", "routes/vault.ts inline db.update(wallet worth) → secret-repository.ts#updateVaultWalletWorth"]),
    handlers_extracted: st.handlerRows,
    behavior_ownership: st.ownership,
    consumers_migrated: [],
    old_business_symbols_remaining: { route_handlers_with_inline_db_crypto_credit_refs: st.routeAfter.filter((r) => EXTRACTED_KEYS.has(`${r.method} ${r.path}`) && (r.handler_text.match(INLINE_REFS) ?? []).length > 0).map((r) => `${r.method} ${r.path}`), not_gap_05_and_left_in_place: ["toHealthInput", "runHealthCheck", "GET /vault/health-report", "POST /vault/health-check (GAP-11)", "GET /vault/receipt/:token/pdf (GAP-01 receipt use-case; provider call stays in receipt use-case)"] },
    duplicate_implementations: st.duplicates,
    route_thinness: { before: thin(st.routeBefore.filter((r) => EXTRACTED_KEYS.has(`${r.method} ${r.path}`))), after: thin(st.routeAfter.filter((r) => EXTRACTED_KEYS.has(`${r.method} ${r.path}`))) },
    sql: { old_statements: st.oldSqlCount, new_statements: st.newSqlCount },
    destination_functions: Object.fromEntries(Object.entries(st.units).map(([f, u]) => [f, u.filter((x) => x.kind !== "type").map((x) => x.name)])),
    diff_audit: audit,
    typecheck: { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build is NOT executed)", before_total: tc.before_total, after_total: tc.after_total, syntactic_errors: tc.syntactic_errors, new_diagnostics: tc.new_diagnostics, before_by_class: tc.before_by_class, after_by_class: tc.after_by_class },
    tests: { differential_cases: diff.length, differential_passed: diff.filter((d) => d.passed).length, security_checks: sec.length, security_passed: sec.filter((d) => d.passed).length, mutations_seeded: mut.length, mutations_detected: mut.filter((d) => d.passed).length },
    notes: [
      "Scope follows the GAP-01 gate's deferral table: the code in routes/vault.ts that GAP-01/02 left to GAP-05 (secret/wallet) was exactly GET /vault/:id/seed, PATCH /vault/:id/drive-wallet, POST /vault/validate-key and POST /vault/:id/refresh-wallet-worth. Those four handlers were extracted; the other 32 handlers, all non-route symbols, and the route table are token-identical to the baseline.",
      "Behavior is preserved exactly, including pre-existing quirks: parseInt(id) NaN is passed through unchanged; the reveal token is read from the x-reveal-token header first and the revealToken query parameter second; the audit write (logVaultActivity) stays fire-and-forget; credits are charged only after a successful decrypt; the Drive wallet is write-once; wallet_addresses that fail JSON.parse are treated as empty; dynamic imports of lib/wallet-key-validation and lib/chain-balance are preserved.",
      "Step-up: the single-use reveal-token store and PIN lookup live in routes/vault-security.ts, which GAP-06 owns. 05-B does not move them; it injects them into the reveal use-case as a port (SecretRevealDeps), so the gate is enforced by vault/application/secret/reveal.ts but the store is a recorded GAP-06 deferral. The same pattern applies to the SSE broadcaster (events).",
      "services/vault/src/index.mjs is a composition root (imports, wiring consts, createServiceServer(...).start) and lib/vault-crypto.ts is a pure re-export of vault/crypto/field-encryption.ts; both are proven composition/compat-only and byte-identical to the 05-A seal, so no code needed to move out of them. The service's own implementation (services/vault/src/{application,domain,crypto,security,infrastructure,api}) is already layered and is not modified.",
      "05-A findings that need a decision before any behavioural change and are therefore NOT changed here: the service and the api-server use different, non-interoperable ciphertext formats and separate secret stores; the service stamps version 1 and has no increment path; its step-up single-use state is an in-process Set.",
      "The project's own test suites and full tsc/build cannot run in this environment (dependencies are not installed); the differential suite executes the frozen OLD routes/vault.ts and the NEW tree under identical stubbed dependencies and compares every DB call, credit charge, reveal-token call, audit write, RPC call, status code and body. Run the repo's build and tests in CI before certifying.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL", checks,
  };
  const body = { ...evidence }; delete body.generated_at;
  evidence.generated_at = new Date().toISOString(); evidence.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — ${diff.length} differential cases, ${sec.length} security checks, ${mut.filter((m) => m.passed).length}/${mut.length} mutations detected, ${st.checks.length} static checks (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${c.details || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`unhandled: ${e.stack ?? e}`));
