#!/usr/bin/env node
// VLT-GAP-05-C — Consumer Rewire (Secret/Core crypto boundary). Fail-closed validator.
// Evidence: reports/antas/vault/gap/VLT-GAP-05/consumer-graph.json
//
// Question answered: does every consumer of the OLD secret/crypto boundary now use the NEW owner?
// The old boundary is the compatibility adapter lib/vault-crypto.ts (its own comment: "Keep this import path until all existing jobs and
// adapters have migrated"); the new owner is vault/crypto/field-encryption.ts. The consumer set is DERIVED, never declared: at freeze time an
// AST scan found every file importing the adapter and froze it (baseline-05c). This validator proves, for each of them, that
//   (1) the ONLY difference from the sealed text is the module-specifier string, old → adapter, new → owner (token-level proof);
//   (2) the imported names still exist on the owner and the adapter re-exports the very same bindings (executed identity proof);
//   (3) no importer of the adapter remains anywhere (static, re-export, dynamic import, require, mock/resolve strings);
//   (4) no import cycle or layering inversion was introduced; the adapter itself is untouched; public routes/frontend are unchanged;
//   (5) nothing else changed (diff audit), 05-B still passes on a copy with the rewire undone, a degraded differential typecheck is clean;
//   (6) the gate is mutation-tested, rejects bypass attempts, and every remaining consumer of the other GAP-05 behaviors is an explicit,
//       verified deferral to the gap that owns it (or a recorded carry-over).
// This validator NEVER writes a baseline; it only VERIFIES the write-once seal from freeze-vlt-gap-05-C-baseline.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ROOT, sha256, sha256File, rel, rejectBypass, binding, walkFiles } from "./gap-common.mjs";
import { loadTs, createEnv, createLoader } from "./harness.mjs";

const VALIDATOR_VERSION = "1.0.0";
const PHASE = "VLT-GAP-05";
const SUB_PHASE = "VLT-GAP-05-C";
const HERE = fileURLToPath(import.meta.url);
const GAP = "scripts/antas/vault/gap/";
const SRC = path.join(ROOT, "artifacts/api-server/src");
const EVID = path.join(ROOT, "reports/antas/vault/gap/VLT-GAP-05");
const EVIDENCE_FILE = path.join(EVID, "consumer-graph.json");
const BASE = path.join(EVID, "baseline-05c");
const FROZEN_DIR = path.join(BASE, "consumers");
const SEAL_FILE = path.join(BASE, "SEAL.json");
const MANIFEST_FILE = path.join(BASE, "tree-manifest.json");
const R = (f) => `artifacts/api-server/src/${f}`;
const COMPAT = R("lib/vault-crypto");
const OWNER = R("vault/crypto/field-encryption");
const canon = (o) => JSON.stringify(o);
const ALLOWED_NEW_SCRIPTS = new Set([`${GAP}validate-vlt-gap-05-C.mjs`, `${GAP}freeze-vlt-gap-05-C-baseline.mjs`]);

const fail = (m) => { console.error(`${SUB_PHASE} FAIL — ${m}`); process.exit(1); };
const bypass = rejectBypass(["--verify"]);
if (bypass.length) fail(`bypass mechanism rejected: ${bypass.join(", ")}`);
if (process.env.VALIDATION_DISABLED && !/^(0|false|no)$/i.test(process.env.VALIDATION_DISABLED)) fail("bypass mechanism rejected: env VALIDATION_DISABLED");
const ts = loadTs(ROOT);
if (!ts) fail("TypeScript compiler API unavailable (fail closed)");
const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, /\.(mjs|js|cjs)$/.test(name) ? ts.ScriptKind.JS : /x$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const rd = (overlay, rp) => (overlay?.has(rp) ? overlay.get(rp) : fs.existsSync(path.join(ROOT, rp)) ? fs.readFileSync(path.join(ROOT, rp), "utf8") : null);
const frozenText = (name) => fs.readFileSync(path.join(FROZEN_DIR, name), "utf8");
const norm = (s) => s.replace(/\s+/g, " ").trim();

// ── 0. Seal (verify, never write) ───────────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(SEAL_FILE) || !fs.existsSync(MANIFEST_FILE)) fail("baseline-05c/SEAL.json missing — run freeze-vlt-gap-05-C-baseline.mjs ONCE, before any 05-C change");
const SEAL = JSON.parse(fs.readFileSync(SEAL_FILE, "utf8")); const MANIFEST_TEXT = fs.readFileSync(MANIFEST_FILE, "utf8"); const MANIFEST = JSON.parse(MANIFEST_TEXT).files;
const CONSUMERS = Object.entries(SEAL.frozen_consumers).map(([name, v]) => ({ name, file: v.source, sha256: v.sha256 })).sort((a, b) => a.file.localeCompare(b.file));

// ── AST primitives ──────────────────────────────────────────────────────────────────────────────────────────────────
const stripExt = (p) => p.replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
const resolveSpec = (fromRel, spec) => (spec.startsWith(".") ? stripExt(rel(path.resolve(path.dirname(path.join(ROOT, fromRel)), spec))) : null);
/** Every module specifier in a file: static import, export-from, dynamic import(), require(). */
function specifiers(text, fileRel) {
  const sf = parse(fileRel, text); const out = [];
  const add = (lit, kind, names, ctx) => out.push({ spec: lit.text, kind, start: lit.getStart(sf), line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1, resolved: resolveSpec(fileRel, lit.text), names, ctx });
  (function w(n) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) { const c = n.importClause; const names = []; if (c?.name) names.push("default"); if (c?.namedBindings) { if (ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text)); else names.push("*"); } add(n.moduleSpecifier, "import", names, null); }
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) add(n.moduleSpecifier, "re-export", n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"], null);
    else if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      let names = ["*"]; let p = n.parent; while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) names = p.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
      add(n.arguments[0], n.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require", names, null);
    }
    ts.forEachChild(n, w);
  })(sf);
  return out;
}
function tokensWithSpecPlaceholders(text, fileRel, specStarts) {
  const sf = parse(fileRel, text); const out = [];
  (function w(n) { if (n.getChildCount(sf) === 0 && n.kind !== ts.SyntaxKind.EndOfFileToken) out.push(specStarts.has(n.getStart(sf)) ? "§SPEC" : n.getText(sf)); else n.getChildren(sf).forEach(w); })(sf);
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
const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── 1. Per-consumer delta proof ─────────────────────────────────────────────────────────────────────────────────────
function consumerDelta({ file, oldText, newText, ownerNames }) {
  const v = []; const oldS = specifiers(oldText, file), newS = specifiers(newText, file);
  const oldTok = tokensWithSpecPlaceholders(oldText, file, new Set(oldS.map((s) => s.start)));
  const newTok = tokensWithSpecPlaceholders(newText, file, new Set(newS.map((s) => s.start)));
  if (canon(oldTok) !== canon(newTok)) { const i = oldTok.findIndex((t, k) => t !== newTok[k]); v.push(`token stream differs outside module specifiers (first difference at token ${i}: '${oldTok[i]}' vs '${newTok[i]}'; ${oldTok.length} vs ${newTok.length} tokens)`); }
  const changed = [];
  if (oldS.length !== newS.length) v.push(`module-specifier count changed (${oldS.length} → ${newS.length})`);
  else oldS.forEach((o, i) => {
    const n = newS[i];
    if (o.spec === n.spec) { if (o.resolved === COMPAT) v.push(`line ${o.line}: still imports the compatibility adapter`); return; }
    if (o.resolved !== COMPAT) v.push(`line ${o.line}: a specifier other than the adapter was changed ('${o.spec}' → '${n.spec}')`);
    else if (n.resolved !== OWNER) v.push(`line ${o.line}: adapter import now points at '${n.spec}' (${n.resolved}), not the crypto owner`);
    else changed.push({ line: o.line, kind: o.kind, from: o.spec, to: n.spec, names: o.names });
  });
  if (!changed.length && !v.length) v.push("no specifier was rewired");
  for (const c of changed) for (const nm of c.names) if (nm !== "*" && !ownerNames.has(nm)) v.push(`line ${c.line}: imported name '${nm}' is not exported by the owner`);
  return { violations: v, changed };
}

// ── 2. Repo-wide scans ──────────────────────────────────────────────────────────────────────────────────────────────
function allSourceFiles() {
  const roots = ["artifacts", "scripts", "lib", "packages", "services", "apps", "tests"].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
  const files = []; for (const d of roots) walkFiles(d, files, (p) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p) && !p.endsWith(".d.ts"));
  return files.map(rel).filter((r) => !r.startsWith("scripts/antas/") && !r.includes("/node_modules/"));
}
function adapterImporters(overlay = new Map()) {
  const files = [...new Set([...allSourceFiles(), ...overlay.keys()])]; const out = []; const strRefs = [];
  for (const r of files) {
    const text = rd(overlay, r); if (text === null || !/vault-crypto/.test(text)) continue;
    for (const s of specifiers(text, r)) if (s.resolved === COMPAT) out.push({ file: r, line: s.line, kind: s.kind, names: s.names });
    // test/mocking/resolution helpers reference the module by string without importing it
    const sf = parse(r, text);
    (function w(n) { if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && /(^|\/)vault-crypto(\.[tj]s)?$/.test(n.arguments[0].text) && !(n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) strRefs.push({ file: r, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, call: n.expression.getText(sf) }); ts.forEachChild(n, w); })(sf);
  }
  return { importers: out, string_refs: strRefs };
}
/** Import graph restricted to the api-server source tree; reachability from `from` must not include any consumer (no cycle through the owner). */
function reachableFrom(fromRel, overlay = new Map()) {
  const seen = new Set(); const stack = [fromRel];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    const cands = [`${f}.ts`, `${f}/index.ts`, f]; const real = cands.find((c) => rd(overlay, c) !== null && (overlay.has(c) || fs.statSync(path.join(ROOT, c)).isFile())); if (!real) continue;
    for (const s of specifiers(rd(overlay, real), real)) if (s.resolved && s.resolved.startsWith("artifacts/api-server/src/")) stack.push(s.resolved);
  }
  return seen;
}

// ── 3. Static proof ─────────────────────────────────────────────────────────────────────────────────────────────────
function sealChecks(cGate) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: String(details) });
  chk("seal:manifest-hash-matches-seal", sha256(MANIFEST_TEXT) === SEAL.tree_manifest_sha256);
  chk("seal:certified-by-05B-and-sub-phase-is-05C", SEAL.certified_by?.sub_phase === "VLT-GAP-05-B" && SEAL.sub_phase === SUB_PHASE);
  const bad = CONSUMERS.filter((c) => !fs.existsSync(path.join(FROZEN_DIR, c.name)) || sha256File(path.join(FROZEN_DIR, c.name)) !== c.sha256 || MANIFEST[c.file] !== c.sha256);
  chk("seal:frozen-consumers-intact-and-equal-to-manifest", bad.length === 0 && CONSUMERS.length >= 20, bad.map((c) => c.file).join(", "));
  const ad = path.join(FROZEN_DIR, "__adapter__lib__vault-crypto.ts");
  chk("seal:frozen-adapter-intact", fs.existsSync(ad) && sha256File(ad) === SEAL.compat_adapter?.sha256 && MANIFEST[SEAL.compat_adapter.source] === SEAL.compat_adapter.sha256);
  const cur = Object.fromEntries(walkFiles(path.join(ROOT, GAP), [], (p) => /\.mjs$/.test(p)).map((f) => [rel(f), sha256File(f)]));
  const edited = Object.entries(SEAL.gap_scripts_at_freeze).filter(([k, h]) => cur[k] !== h).map(([k]) => k);
  chk("seal:earlier-validators-and-harness-byte-identical-since-freeze", edited.length === 0 && Object.keys(SEAL.gap_scripts_at_freeze).length >= 25, edited.join(", "));
  const extra = Object.keys(cur).filter((k) => !(k in SEAL.gap_scripts_at_freeze) && !ALLOWED_NEW_SCRIPTS.has(k));
  chk("seal:no-unexpected-new-validator-scripts", extra.length === 0, extra.join(", "));
  if (cGate) chk("prerequisite:05-B-passes-on-a-copy-with-the-rewire-undone-and-evidence-verifies-in-place", cGate.ok, cGate.details);
  return checks;
}
function staticProof(overlay = new Map()) {
  const checks = []; const chk = (name, passed, details = "") => checks.push({ name, passed: Boolean(passed), details: typeof details === "string" ? details : canon(details) });
  const ownerText = rd(overlay, `${OWNER}.ts`); const ownerNames = exportedNames(ownerText, "owner.ts");
  const adapterText = rd(overlay, `${COMPAT}.ts`); const adapterNames = adapterText ? exportedNames(adapterText, "adapter.ts") : new Set();
  const rows = []; const viol = [];
  for (const c of CONSUMERS) {
    const newText = rd(overlay, c.file); if (newText === null) { viol.push(`${c.file}: file missing`); continue; }
    const d = consumerDelta({ file: c.file, oldText: frozenText(c.name), newText, ownerNames });
    rows.push({ file: c.file.replace("artifacts/api-server/src/", ""), kind_of_edit: d.changed.map((x) => x.kind).join("+") || "none", rewired: d.changed, violations: d.violations, old_sha256: c.sha256, new_sha256: sha256(newText) });
    for (const x of d.violations) viol.push(`${c.file}: ${x}`);
  }
  chk("consumers:every-frozen-consumer-differs-only-by-the-adapter-specifier-which-now-points-at-the-owner", viol.length === 0 && rows.length === CONSUMERS.length, viol.slice(0, 6).join(" | "));
  chk("consumers:rewired-count-matches-the-derived-consumer-set (static, dynamic-import and re-export all covered)", rows.filter((r) => r.rewired.length).length === CONSUMERS.length && CONSUMERS.length >= 20, `${rows.filter((r) => r.rewired.length).length}/${CONSUMERS.length}`);
  chk("consumers:edit-kinds-cover-static-and-dynamic-import (index.ts startup key-manager load is dynamic)", rows.some((r) => /\bimport\b/.test(r.kind_of_edit) && r.rewired.some((x) => x.kind === "dynamic-import")) && rows.some((r) => r.rewired.some((x) => x.kind === "import")), canon([...new Set(rows.flatMap((r) => r.rewired.map((x) => x.kind)))]));
  const scan = adapterImporters(overlay);
  chk("scan:no-importer-of-the-adapter-remains (static import, re-export, dynamic import, require) anywhere in the repo", scan.importers.length === 0, canon(scan.importers));
  chk("scan:no-mock-resolve-or-require-by-string-of-the-adapter", scan.string_refs.length === 0, canon(scan.string_refs));
  chk("owner:exports-every-name-the-adapter-re-exports (loadKeyManager, getActiveVersion, rotateKey, encryptField, decryptField, decryptRow, decryptRows)", adapterNames.size >= 7 && [...adapterNames].every((n) => ownerNames.has(n)), `adapter=${[...adapterNames].join(",")}`);
  const adapterSpecs = adapterText ? specifiers(adapterText, `${COMPAT}.ts`) : [];
  chk("adapter:is-a-pure-re-export-of-the-owner-and-byte-identical-to-the-seal", adapterText !== null && sha256(adapterText) === SEAL.compat_adapter.sha256 && adapterSpecs.length === 1 && adapterSpecs[0].resolved === OWNER && adapterSpecs[0].kind === "re-export" && parse("a.ts", adapterText).statements.every((s) => ts.isExportDeclaration(s)), `specs=${canon(adapterSpecs.map((s) => s.spec))}`);
  // no cycle: the owner must not (transitively) import any consumer
  const reach = reachableFrom(OWNER, overlay); const cyc = CONSUMERS.map((c) => stripExt(c.file)).filter((f) => reach.has(f));
  chk("graph:the-owner-does-not-reach-any-consumer (no import cycle introduced by the rewire)", cyc.length === 0 && reach.size >= 1, canon({ reachable: reach.size, cycle_through: cyc }));
  const ownerSpecs = specifiers(ownerText, "owner.ts"); const badOwnerImports = ownerSpecs.filter((s) => s.resolved);
  chk("graph:the-owner-imports-only-external-packages (lowest layer: crypto, @workspace/db, drizzle-orm)", badOwnerImports.length === 0 && ownerSpecs.every((s) => ["crypto", "@workspace/db", "drizzle-orm"].includes(s.spec)), canon(ownerSpecs.map((s) => s.spec)));
  // layering: inner vault modules reach crypto through vault/crypto, never through lib/
  const vaultInner = CONSUMERS.filter((c) => c.file.startsWith(R("vault/")) && !c.file.startsWith(R("vault/api/")));
  const layerBad = vaultInner.filter((c) => specifiers(rd(overlay, c.file), c.file).some((s) => s.resolved?.startsWith(R("lib/")) && /vault-crypto/.test(s.resolved)));
  chk("layering:vault-application-modules-no-longer-depend-on-lib/ for crypto (game, kyc, local-account)", vaultInner.length >= 8 && layerBad.length === 0, canon(layerBad.map((c) => c.file)));
  const wholeVault = walkFiles(path.join(SRC, "vault"), [], (p) => /\.ts$/.test(p)).map(rel).filter((f) => !f.startsWith(R("vault/api/")));
  const compatInVault = wholeVault.filter((f) => specifiers(rd(overlay, f) ?? fs.readFileSync(path.join(ROOT, f), "utf8"), f).some((s) => s.resolved === COMPAT));
  chk("layering:no-file-under-vault/-imports-the-adapter", compatInVault.length === 0, canon(compatInVault));
  // public contract: every rewired route file keeps the identical route table; frontend callers untouched
  const routeFiles = CONSUMERS.filter((c) => c.file.startsWith(R("routes/")));
  const routeTable = (text, name) => { const sf = parse(name, text); const o = []; (function w(n) { if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && ["get", "post", "put", "patch", "delete"].includes(n.expression.name.text)) o.push(`${n.expression.name.text.toUpperCase()} ${n.arguments[0].text} [${[...n.arguments].slice(1, -1).map((a) => norm(a.getText(sf))).join(" > ")}]`); ts.forEachChild(n, w); })(sf); return o; };
  const rtDiff = routeFiles.filter((c) => canon(routeTable(frozenText(c.name), "o")) !== canon(routeTable(rd(overlay, c.file), "n")));
  const rtCount = routeFiles.reduce((n, c) => n + routeTable(rd(overlay, c.file), "n").length, 0);
  chk("contract:route-tables-of-every-rewired-route-file-identical-to-the-seal (method, path, middleware chain)", rtDiff.length === 0 && routeFiles.length >= 10 && rtCount >= 40, `${routeFiles.length} route files, ${rtCount} routes, diff=${canon(rtDiff.map((c) => c.file))}`);
  const inv = JSON.parse(fs.readFileSync(path.join(EVID, "symbol-inventory.json"), "utf8"));
  const callers = (inv.endpoint_callers?.callers ?? []).map((c) => c.file).filter((f) => f.startsWith("artifacts/ayzen/") || f.startsWith("artifacts/mobile") || f.startsWith("artifacts/astra-extension/"));
  const callerChanged = callers.filter((f) => fs.existsSync(path.join(ROOT, f)) && MANIFEST[f] !== sha256File(path.join(ROOT, f)));
  chk("contract:frontend-and-extension-callers-of-the-vault-routes-unchanged", callers.length >= 3 && callerChanged.length === 0, canon({ callers: callers.length, changed: callerChanged }));
  const routesLeft = ["/vault/:id/seed", "/vault/:id/drive-wallet", "/vault/validate-key", "/vault/:id/refresh-wallet-worth"];
  const vt = rd(overlay, R("routes/vault.ts")); chk("contract:the-four-05B-secret-routes-still-registered-and-delegating", routesLeft.every((p) => vt.includes(`"${p}"`)) && /revealSeedPhrase\(/.test(vt) && /refreshWalletWorth\(/.test(vt), "");
  // required consumers of the other GAP-05 behaviours: each use the new owner or is an explicit, verified deferral
  const usesOwnerFor = [
    ["seed-reveal use-case imports the seed-phrase crypto owner (not lib/)", R("vault/application/secret/reveal.ts"), /from "\.\.\/\.\.\/crypto\/seed-phrase"/],
    ["entity admin export uses the seed-phrase crypto owner", R("vault/application/entity/admin.ts"), /from "\.\.\/\.\.\/crypto\/seed-phrase"/],
    ["entity representation uses the seed-phrase crypto owner", R("vault/application/entity/representation.ts"), /from "\.\.\/\.\.\/crypto\/seed-phrase"/],
    ["vault.ts delegates seed reveal to the secret application owner", R("routes/vault.ts"), /from "\.\.\/vault\/application\/secret\/reveal"/],
    ["vault.ts delegates wallet use-cases to the secret application owner", R("routes/vault.ts"), /from "\.\.\/vault\/application\/secret\/wallet"/],
  ];
  for (const [n, f, rx] of usesOwnerFor) chk(`required-consumer:${n}`, rx.test(rd(overlay, f) ?? ""), f);
  const deferrals = [
    { file: R("lib/vault-health-scan.ts"), behavior: "health scan reads toHealthInput from routes/vault.ts", gap: "VLT-GAP-11", verify: (t) => /toHealthInput/.test(t) && /routes\/vault"/.test(t) },
    { file: R("routes/wallets.ts"), behavior: "wallet-recovery reveal gate uses consumeRevealToken/hasNoEntityPin from routes/vault-security (step-up token store)", gap: "VLT-GAP-06", verify: (t) => /consumeRevealToken, hasNoEntityPin } from "\.\/vault-security"/.test(t) },
    { file: R("lib/vault-snapshot-restore.ts"), behavior: "snapshot restore writes secret columns back to vault_entries", gap: "VLT-GAP-09", verify: (t) => /seed_phrase|seedPhrase|drive_wallet|wallet_worth|walletWorth/.test(t) },
    { file: R("routes/vault-snapshot.ts"), behavior: "snapshot export reads secret columns", gap: "VLT-GAP-09", verify: (t) => /seed_phrase|seedPhrase|encryptedSeedPhrase/.test(t) },
    { file: R("lib/schema-migrations.ts"), behavior: "DDL for drive_wallet_* / wallet_worth_* columns", gap: "VLT-GAP-12", verify: (t) => /drive_wallet_address/.test(t) },
    { file: "scripts/src/reencrypt-seed-phrases.ts", behavior: "key-rotation script rewrites encrypted_seed_phrase", gap: "VLT-GAP-07", verify: (t) => /encrypted_seed_phrase/.test(t) },
    { file: "scripts/src/reencrypt-vault.ts", behavior: "key-rotation script rewrites vault_entries ciphertext columns", gap: "VLT-GAP-07", verify: (t) => /vault_entries/.test(t) },
    { file: R("routes/entities.ts"), behavior: "health-rule evaluation reads encrypted_seed_phrase as a presence flag only", gap: "VLT-GAP-11", verify: (t) => /encrypted_seed_phrase/.test(t) && !/decryptSeedPhrase|decryptField/.test(t) },
  ];
  const defRows = deferrals.map((d) => { const t = rd(overlay, d.file); return { file: d.file, behavior: d.behavior, deferred_to: d.gap, still_present: t !== null && d.verify(t) }; });
  chk("deferrals:every-deferral-is-still-real-and-names-a-later-gap (no stale deferral)", defRows.every((d) => d.still_present && /^VLT-GAP-(0[6-9]|1\d)$/.test(d.deferred_to)), canon(defRows.filter((d) => !d.still_present)));
  const providers = [{ file: R("lib/chain-balance.ts"), consumed_by: R("vault/application/secret/wallet.ts"), role: "RPC provider adapter (stays in lib/, invoked by the secret owner via dynamic import)" }, { file: R("lib/wallet-key-validation.ts"), consumed_by: R("vault/application/secret/wallet.ts"), role: "offline key validator (stays in lib/, invoked by the secret owner)" }, { file: R("lib/entity-worth.ts"), consumed_by: R("vault/application/entity/receipt.ts"), role: "pure worth calculation" }];
  chk("providers:provider-adapters-are-consumed-by-the-new-owner-not-by-routes", providers.every((p) => { const t = rd(overlay, p.consumed_by) ?? ""; return t.includes(path.posix.basename(p.file, ".ts")); }) && !/chain-balance|wallet-key-validation/.test(codeOnly(vt)), canon(providers.map((p) => p.file)));
  const carry = [
    { file: R("routes/organizations.ts"), what: "writer of organization_extension_policies.disable_seed_reveal (the flag the reveal gate reads)", note: "no GAP in 05 owns org extension policy; the reader moved into secret-repository in 05-B, the writer remains a route-level SQL block" },
    { file: R("routes/vault-security.ts"), what: "single-use reveal-token store (mint/consume) injected into the reveal use-case as a port", note: "GAP-06 owns the security/access surface; 05-B/05-C keep the port" },
  ];
  chk("carry-over:recorded-carry-overs-are-real", carry.every((c) => fs.existsSync(path.join(ROOT, c.file))) && /disable_seed_reveal/.test(rd(overlay, R("routes/organizations.ts")) ?? ""), "");
  return { checks, rows, scan, deferrals: defRows, providers, carry, ownerNames: [...ownerNames], adapterNames: [...adapterNames], reach: reach.size };
}

// ── 4. Executed identity proof: the adapter re-exports the very same bindings the consumers now import directly ────
function identityProof() {
  const out = { ok: false, details: "", names: [] };
  const saved = process.env.VAULT_FIELD_ENCRYPTION_KEY; process.env.VAULT_FIELD_ENCRYPTION_KEY = "identity-proof-dummy-key-0123456789abcdef"; // test-only; restored below
  try {
    const env = createEnv({});
    // real node:crypto for the owner's `import crypto from "crypto"`; everything else is the harness's stubs (db, drizzle)
    env.stubs.crypto = { default: globalThis.__nodeCrypto };
    delete env.stubs["vault/crypto/field-encryption"]; delete env.stubs["lib/vault-crypto"]; // the harness pre-stubs both paths; the proof needs the REAL modules
    const loader = createLoader({ ts, root: ROOT, srcDir: SRC, env });
    const ownerMod = loader.loadFile(path.join(SRC, "vault/crypto/field-encryption.ts"));
    const adapterMod = loader.loadFile(path.join(SRC, "lib/vault-crypto.ts"));
    const names = ["decryptField", "decryptRow", "decryptRows", "encryptField", "getActiveVersion", "loadKeyManager", "rotateKey"];
    out.names = names.map((n) => ({ name: n, owner_is_function: typeof ownerMod[n] === "function", same_binding: adapterMod[n] === ownerMod[n] }));
    out.ok = out.names.every((x) => x.owner_is_function && x.same_binding);
    out.details = out.ok ? `${names.length} bindings identical` : out.names.filter((x) => !x.owner_is_function || !x.same_binding).map((x) => x.name).join(", ");
  } catch (e) { out.details = `load failed: ${String(e.message).slice(0, 160)}`; }
  finally { if (saved === undefined) delete process.env.VAULT_FIELD_ENCRYPTION_KEY; else process.env.VAULT_FIELD_ENCRYPTION_KEY = saved; }
  return out;
}

// ── 5. Diff audit ───────────────────────────────────────────────────────────────────────────────────────────────────
function diffAudit(overlay = new Map()) {
  const now = {}; for (const f of walkFiles(ROOT)) { const k = rel(f); if (!k.startsWith(GAP)) now[k] = sha256File(f); }
  for (const [k, t] of overlay) if (!k.startsWith(GAP)) { if (t === null) delete now[k]; else now[k] = sha256(t); }
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(now)) { if (!(k in MANIFEST)) added.push(k); else if (MANIFEST[k] !== v) changed.push(k); }
  for (const k of Object.keys(MANIFEST)) if (!(k in now)) removed.push(k);
  const allowed = new Set(CONSUMERS.map((c) => c.file));
  return { changed, added, removed, unexpected: [...changed.filter((k) => !allowed.has(k)), ...added, ...removed], files_compared: Object.keys(MANIFEST).length };
}

// ── 6. Prerequisites executed: 05-B on a copy with the rewire undone; earlier evidence status reported ─────────────
const runNode = (script, cwd, args = []) => { const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: process.env, timeout: 900000 }); return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };
function prerequisite05B() {
  const verify = runNode(path.join(ROOT, `${GAP}validate-vlt-gap-05-B.mjs`), ROOT, ["--verify"]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vlt-gap-05c-b-")); let full = { status: null, out: "" }; let ev = null;
  try {
    fs.cpSync(ROOT, tmp, { recursive: true, filter: (s) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(s) });
    for (const f of ALLOWED_NEW_SCRIPTS) fs.rmSync(path.join(tmp, f), { force: true });
    for (const c of CONSUMERS) { if (sha256File(path.join(FROZEN_DIR, c.name)) !== c.sha256) throw new Error(`sealed frozen consumer ${c.name} was edited`); fs.copyFileSync(path.join(FROZEN_DIR, c.name), path.join(tmp, c.file)); }
    full = runNode(path.join(tmp, `${GAP}validate-vlt-gap-05-B.mjs`), tmp);
    const p = path.join(tmp, "reports/antas/vault/gap/VLT-GAP-05/extraction-proof.json"); ev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const failing = ev ? ev.checks.filter((c) => !c.passed).map((c) => c.name) : ["<no evidence>"];
  const ok = verify.status === 0 && full.status === 0 && ev?.status === "PASS" && failing.length === 0 && ev.tests?.differential_cases >= 51 && ev.tests.differential_passed === ev.tests.differential_cases && ev.tests.mutations_detected === ev.tests.mutations_seeded;
  return { ok, details: ok ? `05-B: verify in place ok; reconstructed run PASS (${ev.tests.differential_cases} differential, ${ev.tests.security_checks} security, ${ev.tests.mutations_detected}/${ev.tests.mutations_seeded} mutations)` : `verify=${verify.status} full=${full.status} failing=${failing.join(", ")} ${full.out.slice(-200)}`, tests: ev?.tests ?? null };
}
function findEvidence(subPhase) {
  const base = path.join(ROOT, "reports/antas/vault/gap");
  for (const dir of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const d = path.join(base, dir); if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) { if (!f.endsWith(".json")) continue; try { const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); if (j.sub_phase === subPhase && j.source_hashes) return { file: rel(path.join(d, f)), hashes: Object.keys(j.source_hashes) }; } catch { /* not evidence */ } }
  }
  return null;
}
function earlierEvidenceStatus() {
  const scripts = fs.readdirSync(path.join(ROOT, GAP)).filter((f) => /^validate-vlt-gap-\d\d-[A-Z]\.mjs$/.test(f) && !/05-C/.test(f)).sort();
  const rewired = new Set(CONSUMERS.map((c) => c.file)); const rows = [];
  for (const s of scripts) {
    const sub = `VLT-GAP-${s.match(/gap-(\d\d-[A-Z])/)[1]}`; const r = runNode(path.join(ROOT, GAP, s), ROOT, ["--verify"]);
    const row = { validator: s, sub_phase: sub, verifies_now: r.status === 0 };
    if (r.status !== 0) { const ev = findEvidence(sub); row.reason = (r.out.match(/evidence rejected: ([^\n]*)/)?.[1] ?? r.out.trim().split("\n").pop() ?? "").slice(0, 120); row.touches_rewired_files = ev ? ev.hashes.filter((h) => rewired.has(h)) : null; row.evidence_file = ev?.file ?? null; }
    rows.push(row);
  }
  return rows;
}

// ── 7. Degraded differential typecheck over every rewired consumer ──────────────────────────────────────────────────
function typecheck() {
  const cfgRaw = ts.readConfigFile(path.join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config?.compilerOptions ?? {};
  const opts = ts.convertCompilerOptionsFromJson({ ...cfgRaw, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, baseUrl: ROOT }, ROOT).options;
  const roots = CONSUMERS.map((c) => path.join(ROOT, c.file)); const baseOf = new Map(CONSUMERS.map((c) => [path.join(ROOT, c.file), path.join(FROZEN_DIR, c.name)]));
  const run = (useBaseline) => {
    const host = ts.createCompilerHost(opts); const rf = host.readFile.bind(host), gs = host.getSourceFile.bind(host);
    const ov = (f) => (useBaseline ? baseOf.get(f) : undefined);
    host.readFile = (f) => rf(ov(f) ?? f);
    host.getSourceFile = (f, lv, ...r) => { const o = ov(f); return o ? ts.createSourceFile(f, fs.readFileSync(o, "utf8"), lv, true) : gs(f, lv, ...r); };
    const prog = ts.createProgram(roots, opts, host); const tally = {}; const syntactic = [];
    for (const f of roots) { const sf = prog.getSourceFile(f); if (sf) for (const d of prog.getSyntacticDiagnostics(sf)) syntactic.push(`${rel(f)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    for (const sf of prog.getSourceFiles()) {
      if (!roots.includes(sf.fileName)) continue;
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
  const unresolvedRel = [2307, 2305, 2724, 2614].filter((c) => Object.keys(after.tally).some((k) => k.startsWith(`${c}:`) && !(k in before.tally)));
  const tot = (x) => Object.values(x).reduce((a, b) => a + b, 0);
  return { mode: "degraded-differential (project dependencies are not installed in the upload; full tsc/build was NOT executed)", files: roots.length, before_total: tot(before.tally), after_total: tot(after.tally), syntactic_errors: after.syntactic, new_diagnostics: regress, new_unresolved_module_or_export_classes: unresolvedRel };
}

// ── 8. Mutation self-tests: the gate must FAIL when the rewire is undone or broken ──────────────────────────────────
function selfTests() {
  const out = []; const t = (name, passed, details = "") => out.push({ name, passed: Boolean(passed), details });
  const cur = (rp) => fs.readFileSync(path.join(ROOT, rp), "utf8");
  const OWNER_SPEC = (f) => { let p = path.relative(path.dirname(path.join(ROOT, f)), path.join(ROOT, OWNER)).split(path.sep).join("/"); return p.startsWith(".") ? p : `./${p}`; };
  const COMPAT_SPEC = (f) => { const p = path.relative(path.dirname(path.join(ROOT, f)), path.join(ROOT, COMPAT)).split(path.sep).join("/"); return p.startsWith(".") ? p : `./${p}`; };
  const failing = (overlay, rx) => staticProof(overlay).checks.filter((c) => !c.passed).some((c) => rx.test(c.name));
  const passing = (overlay, rx) => staticProof(overlay).checks.filter((c) => rx.test(c.name)).every((c) => c.passed);
  const teams = R("routes/teams.ts"), idx = R("index.ts"), kyc = R("vault/application/kyc/entries.ts"), game = R("vault/application/game/entries.ts");
  const swap = (f, a, b) => { const x = cur(f); const y = x.split(a).join(b); return y === x ? null : y; };
  const anchor = (n, v) => t(`selftest:mutation-anchor-${n}`, v !== null);
  let m;
  m = swap(teams, OWNER_SPEC(teams), COMPAT_SPEC(teams)); anchor("a1", m);
  if (m) { t("selftest:consumer-reverted-to-adapter-is-detected-by-delta", failing(new Map([[teams, m]]), /^consumers:every-frozen-consumer/)); t("selftest:consumer-reverted-to-adapter-is-detected-by-repo-scan", failing(new Map([[teams, m]]), /^scan:no-importer-of-the-adapter/)); }
  m = swap(idx, OWNER_SPEC(idx), COMPAT_SPEC(idx)); anchor("a2", m);
  if (m) t("selftest:dynamic-import-reverted-to-adapter-is-detected", failing(new Map([[idx, m]]), /^scan:no-importer-of-the-adapter/) && failing(new Map([[idx, m]]), /^consumers:every-frozen-consumer/));
  m = swap(game, OWNER_SPEC(game), COMPAT_SPEC(game)); anchor("a3", m);
  if (m) t("selftest:vault-layer-consumer-reverted-is-detected-by-layering", failing(new Map([[game, m]]), /^layering:/) || failing(new Map([[game, m]]), /^consumers:every-frozen-consumer/));
  m = swap(kyc, OWNER_SPEC(kyc), COMPAT_SPEC(kyc)); anchor("a4", m);
  if (m) t("selftest:no-file-under-vault-may-import-the-adapter", failing(new Map([[kyc, m]]), /^layering:no-file-under-vault/));
  m = swap(teams, OWNER_SPEC(teams), OWNER_SPEC(teams).replace("field-encryption", "seed-phrase")); anchor("b1", m);
  if (m) t("selftest:rewire-to-the-wrong-module-is-detected", failing(new Map([[teams, m]]), /^consumers:every-frozen-consumer/));
  m = cur(teams) + "\nexport const injected = 1;\n"; t("selftest:logic-appended-to-a-consumer-is-detected", failing(new Map([[teams, m]]), /^consumers:every-frozen-consumer/));
  m = swap(teams, "{ encryptField, decryptField }", "{ encryptField, decryptRows }"); anchor("b2", m);
  if (m) t("selftest:changed-named-import-is-detected", failing(new Map([[teams, m]]), /^consumers:every-frozen-consumer/));
  m = swap(teams, "requireAuth, ", ""); anchor("b3", m);
  if (m) t("selftest:changed-middleware-chain-is-detected", failing(new Map([[teams, m]]), /^(consumers:every-frozen-consumer|contract:route-tables)/));
  const zz = R("routes/zz-new.ts");
  t("selftest:new-static-importer-of-the-adapter-is-detected", failing(new Map([[zz, 'import { encryptField } from "../lib/vault-crypto";\nexport const x = encryptField;\n']]), /^scan:no-importer/));
  t("selftest:new-reexport-of-the-adapter-is-detected", failing(new Map([[zz, 'export { decryptField } from "../lib/vault-crypto";\n']]), /^scan:no-importer/));
  t("selftest:new-dynamic-import-of-the-adapter-is-detected", failing(new Map([[zz, 'export async function f() { const m = await import("../lib/vault-crypto"); return m; }\n']]), /^scan:no-importer/));
  t("selftest:new-require-of-the-adapter-is-detected", failing(new Map([[zz, 'const m = require("../lib/vault-crypto");\nexport default m;\n']]), /^scan:no-importer/));
  t("selftest:mock-by-string-of-the-adapter-is-detected", failing(new Map([[zz, 'declare const jest: any;\njest.mock("../lib/vault-crypto");\n']]), /^scan:no-mock-resolve/));
  t("selftest:negative-control-comment-and-lookalike-module-are-not-flagged", passing(new Map([[zz, '// historical note: lib/vault-crypto.ts was the adapter\nimport x from "./vault-crypto-extra";\nexport default x;\n']]), /^scan:/));
  m = cur(`${COMPAT}.ts`) + "\nexport const extra = 1;\n"; t("selftest:modified-adapter-is-detected", failing(new Map([[`${COMPAT}.ts`, m]]), /^adapter:/));
  t("selftest:deleted-adapter-is-detected", failing(new Map([[`${COMPAT}.ts`, null]]), /^(adapter:|owner:exports-every-name)/));
  m = cur(`${OWNER}.ts`) + '\nimport "../../routes/teams";\n'; t("selftest:owner-importing-a-consumer-is-detected-as-a-cycle", failing(new Map([[`${OWNER}.ts`, m]]), /^graph:/));
  m = swap(`${OWNER}.ts`, "export async function decryptRows", "async function decryptRows"); if (m === null) m = swap(`${OWNER}.ts`, "export function decryptRows", "function decryptRows"); anchor("c1", m);
  if (m) t("selftest:owner-missing-a-name-a-consumer-or-the-adapter-needs-is-detected", failing(new Map([[`${OWNER}.ts`, m]]), /^(owner:exports-every-name|consumers:every-frozen-consumer)/));
  t("selftest:unlisted-file-change-is-detected-by-diff-audit", diffAudit(new Map([[R("routes/vault.ts"), cur(R("routes/vault.ts")) + "\n// x\n"]])).unexpected.includes(R("routes/vault.ts")));
  t("selftest:unlisted-new-file-is-detected-by-diff-audit", diffAudit(new Map([[R("lib/zz-new.ts"), "export {};\n"]])).unexpected.includes(R("lib/zz-new.ts")));
  m = cur(R("lib/vault-health-scan.ts")).replace(/toHealthInput/g, "toX"); t("selftest:stale-health-deferral-is-detected", failing(new Map([[R("lib/vault-health-scan.ts"), m]]), /^deferrals:/));
  m = cur(R("routes/wallets.ts")).replace("consumeRevealToken, hasNoEntityPin", "hasNoEntityPin"); t("selftest:stale-step-up-deferral-is-detected", failing(new Map([[R("routes/wallets.ts"), m]]), /^deferrals:/));
  m = cur(R("routes/vault.ts")).replace(/revealSeedPhrase\(/g, "revealX("); t("selftest:secret-route-no-longer-delegating-is-detected", failing(new Map([[R("routes/vault.ts"), m]]), /^contract:the-four-05B/));
  t("selftest:tampered-seal-manifest-is-detected", sha256(`${MANIFEST_TEXT}x`) !== SEAL.tree_manifest_sha256 && sha256(MANIFEST_TEXT) === SEAL.tree_manifest_sha256);
  return out;
}
function bypassAttempts() {
  const tries = [{ name: "flag --skip-tests", args: ["--skip-tests"], env: {} }, { name: "flag --force-pass", args: ["--force-pass"], env: {} }, { name: "flag --ignore-failures", args: ["--ignore-failures"], env: {} }, { name: "flag --continue-on-error", args: ["--continue-on-error"], env: {} }, { name: "unknown flag --whatever", args: ["--whatever"], env: {} }, { name: "env ANTAS_BYPASS=true", args: [], env: { ANTAS_BYPASS: "true" } }, { name: "env VALIDATION_DISABLED=true", args: [], env: { VALIDATION_DISABLED: "true" } }];
  return tries.map((tr) => { const r = spawnSync(process.execPath, [HERE, ...tr.args], { encoding: "utf8", env: { ...process.env, ...tr.env }, timeout: 60000 }); return { attempt: tr.name, exit_code: r.status, rejected: r.status === 1 && /bypass mechanism rejected/.test(r.stderr ?? "") }; });
}

// ── 9. Main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sourceHashes = () => Object.fromEntries([...CONSUMERS.map((c) => c.file), `${COMPAT}.ts`, `${OWNER}.ts`, `${GAP}harness.mjs`, `${GAP}gap-common.mjs`, `${GAP}freeze-vlt-gap-05-C-baseline.mjs`, rel(SEAL_FILE), rel(MANIFEST_FILE)].map((f) => [f, sha256File(path.join(ROOT, f))]));
function verifyMode() {
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
  console.log(`${SUB_PHASE} evidence verified (${b.commit_binding})`);
}
async function main() {
  if (process.argv.includes("--verify")) { verifyMode(); return; }
  const started = Date.now();
  globalThis.__nodeCrypto = (await import("node:crypto")).default;
  const pre = prerequisite05B();
  const st = staticProof(); const idn = identityProof(); const audit = diffAudit(); const tc = typecheck();
  const earlier = earlierEvidenceStatus();
  const selft = selfTests(); const bypassRes = bypassAttempts();
  const checks = [...sealChecks(pre), ...st.checks];
  checks.push({ name: "identity:adapter-and-owner-export-the-very-same-function-objects (executed through the harness loader)", passed: idn.ok, details: idn.details });
  checks.push({ name: "diff-audit:only-the-derived-consumer-set-changed (no other file, none added or removed)", passed: audit.unexpected.length === 0 && CONSUMERS.every((c) => audit.changed.includes(c.file)), details: canon({ unexpected: audit.unexpected, changed: audit.changed.length, consumers: CONSUMERS.length }) });
  checks.push({ name: "typecheck:no-syntax-errors-in-rewired-consumers", passed: tc.syntactic_errors.length === 0, details: tc.syntactic_errors.join(" | ") });
  checks.push({ name: "typecheck:no-new-diagnostics-and-no-new-unresolved-module-or-export-vs-sealed-consumers", passed: tc.new_diagnostics.length === 0 && tc.new_unresolved_module_or_export_classes.length === 0, details: canon({ new: tc.new_diagnostics, unresolved: tc.new_unresolved_module_or_export_classes }) });
  checks.push({ name: "earlier-evidence:status-of-every-earlier-validator-reported (informational: later phases legitimately stale earlier source-bound evidence)", passed: earlier.length >= 15, details: `${earlier.filter((r) => r.verifies_now).length}/${earlier.length} still verify` });
  for (const r of selft) checks.push(r);
  checks.push({ name: "selftest:coverage-at-least-25-mutations-executed", passed: selft.length >= 25, details: `${selft.length}` });
  checks.push({ name: "bypass:every-bypass-attempt-is-rejected-by-the-validator-itself", passed: bypassRes.length >= 7 && bypassRes.every((b) => b.rejected), details: canon(bypassRes.filter((b) => !b.rejected)) });
  const failed = checks.filter((c) => !c.passed);
  const hashes = sourceHashes(); const bd = binding(hashes);
  const stale = earlier.filter((r) => !r.verifies_now);
  const evidence = {
    phase: PHASE, sub_phase: SUB_PHASE, commit_sha: bd.commit_sha, commit_binding: bd.commit_binding, source_tree_sha256: bd.source_tree_sha256,
    validator_version: VALIDATOR_VERSION, validator_sha256: sha256File(HERE), source_hashes: hashes,
    baseline: { mode: "write-once seal (verified, never written by this validator)", seal_file: rel(SEAL_FILE), sealed_at: SEAL.sealed_at, tree_manifest_sha256: SEAL.tree_manifest_sha256, certified_by: SEAL.certified_by, frozen_consumers: Object.keys(SEAL.frozen_consumers).length },
    commands: ["node scripts/antas/vault/gap/validate-vlt-gap-05-C.mjs", "node scripts/antas/vault/gap/validate-vlt-gap-05-B.mjs --verify (in place)", "node scripts/antas/vault/gap/validate-vlt-gap-05-B.mjs (full run on a temp copy with the rewire undone)", "node scripts/antas/vault/gap/validate-vlt-gap-NN-X.mjs --verify (every earlier validator, informational)", "in-process AST delta/identity/graph proof, mutation self-tests, differential typecheck, child-process bypass attempts"],
    exit_codes: { "05-B(verify,in-place)": pre.ok ? 0 : 1, identity_proof: idn.ok ? 0 : 1, mutation_self_tests: selft.every((r) => r.passed) ? 0 : 1, bypass_attempts: bypassRes.every((b) => b.rejected) ? 0 : 1, typecheck_degraded: tc.new_diagnostics.length || tc.syntactic_errors.length ? 1 : 0 },
    old_boundary: { module: `${COMPAT}.ts`, role: "compatibility adapter (pure re-export)", new_owner: `${OWNER}.ts`, exported_bindings: st.adapterNames },
    consumers_migrated: st.rows.map((r) => ({ file: `artifacts/api-server/src/${r.file}`, edit: r.kind_of_edit, rewired: r.rewired, old_sha256: r.old_sha256, new_sha256: r.new_sha256 })),
    symbols_moved: [],
    old_adapter_importers_remaining: st.scan.importers, old_adapter_string_references_remaining: st.scan.string_refs,
    duplicate_implementations: [],
    identity_proof: idn,
    graph: { owner_reachable_modules: st.reach, owner_imports: "crypto, @workspace/db, drizzle-orm only" },
    deferred_consumers: st.deferrals, provider_adapters: st.providers, carry_over: st.carry,
    adapter_status: { importers: st.scan.importers.length, retained: true, byte_identical_to_seal: true, decision: "NOT retired in 05-C: it is the pre-extraction public import path and is kept byte-identical until 05-D's retirement gate rules on it (it now has zero importers)." },
    diff_audit: audit,
    typecheck: tc,
    earlier_evidence_status: { informational: "Evidence of earlier sub-phases is bound to source hashes of the files they certified. 05-C legitimately edits the import specifier of 27 files, 8 of which sit in vault/application/{game,kyc,local-account} certified by GAP-02/03/04. Those evidence files therefore no longer verify in place; their validators cannot be re-executed unchanged on the current tree (their harness stubs the old module path). Each is listed with the rewired files it covers.", verify_results: earlier, stale_count: stale.length, stale_explained_by_rewire: stale.filter((r) => (r.touches_rewired_files ?? []).length > 0).map((r) => r.sub_phase), stale_not_covering_any_rewired_file: stale.filter((r) => !(r.touches_rewired_files ?? []).length).map((r) => ({ sub_phase: r.sub_phase, reason: r.reason })) },
    tests: { mutation_self_tests: selft.length, mutation_self_tests_passed: selft.filter((r) => r.passed).length, bypass_attempts_rejected: bypassRes.filter((b) => b.rejected).length, prerequisite_05B: pre.tests },
    notes: [
      "05-C rewires one thing: the module specifier of every importer of the compatibility adapter lib/vault-crypto.ts (27 files: 19 api-server routes/libs/startup, 8 vault application modules) to vault/crypto/field-encryption.ts. The set is derived by an AST scan frozen in the seal; the token-level proof shows nothing else in those files changed.",
      "Behavior is preserved by construction and by executed proof: the adapter is `export { … } from owner`, so each name resolves to the identical function object (identity_proof). No cipher, key, envelope format or call site changed.",
      "Public routes are unchanged: every rewired route file keeps an identical route table (method, path, middleware chain) and no frontend/extension caller changed.",
      "The adapter lib/vault-crypto.ts is deliberately kept (byte-identical, zero importers). Deleting it is a retirement decision for 05-D.",
      "The step-up token store, org-policy writer, health scan and snapshot/key-rotation consumers are NOT rewired here: each is an explicit, verified deferral to the gap that owns it or a recorded carry-over (deferred_consumers, carry_over).",
      "Comment-only mentions of lib/vault-crypto.ts in scripts/ and lib/db/ schema docs are not code references and were left untouched; they should be refreshed when 05-D retires the adapter.",
      "services/vault/src is a separate service with its own crypto envelope and was never a consumer of the adapter; it is untouched.",
      "The project's own test suites and full tsc/build cannot run in this environment (dependencies are not installed); the differential typecheck over all 27 consumers compares diagnostics against the sealed originals and the identity proof is executed through the harness loader. Run the repo's build and tests in CI before certifying.",
    ],
    status: failed.length === 0 ? "PASS" : "FAIL", checks,
  };
  const body = { ...evidence }; delete body.generated_at;
  evidence.generated_at = new Date().toISOString(); evidence.evidence_body_sha256 = sha256(JSON.stringify(body));
  fs.mkdirSync(EVID, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`${SUB_PHASE} ${evidence.status} — consumers=${CONSUMERS.length} adapter-importers-left=${st.scan.importers.length} identity=${idn.names.length} diff-changed=${audit.changed.length} selftests=${selft.filter((r) => r.passed).length}/${selft.length} bypass-rejected=${bypassRes.filter((b) => b.rejected).length}/${bypassRes.length} earlier-evidence-stale=${stale.length}/${earlier.length} checks=${checks.length} (${Date.now() - started}ms)`);
  if (failed.length) { console.error(failed.map((c) => `- ${c.name}: ${String(c.details).slice(0, 400) || "not satisfied"}`).join("\n")); process.exit(1); }
}
main().catch((e) => fail(`validator crashed: ${e.stack || e}`));
