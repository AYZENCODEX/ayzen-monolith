#!/usr/bin/env node
// VLT-GAP-14 — Architecture / dependency enforcement (AST import graph, cycles, layer rules, line-level violations).
//   node validate-vlt-gap-14.mjs               build the import graph of api-server/src, apply gap-configs/vault-architecture.json,
//                                              write reports/antas/vault/gap/VLT-GAP-14/{import-graph,architecture}.json
//   node validate-vlt-gap-14.mjs --self-test   plant violations in a temp repo and prove the scanner rejects each rule
// Rules:  A0 unresolved import · A1 runtime cycle · A2 layer direction · A3 domain purity · A4 banned external (db/http/provider/frontend)
//         A5 route/middleware dependency · A6 cross-feature private import · A7 legacy implementation import · A8 outside deep import
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, rejectBypass, sha256 } from "./gap-common.mjs";

const GAP = "VLT-GAP-14";
const OUT_DIR = path.join(ROOT, "reports/antas/vault/gap", GAP);
const CONFIG_PATH = path.join(ROOT, "scripts/antas/vault/gap/gap-configs/vault-architecture.json");
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const fail = (m) => { console.error(`${GAP} FAIL — ${m}`); process.exit(1); };
const rootIdx = argv.indexOf("--root");
const ROOT_OVERRIDE = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1] ?? "") : null; // 14-D: scan a copy of the tree
if (rootIdx >= 0 && !argv[rootIdx + 1]) { console.error(`${GAP} FAIL — --root needs a directory (fail closed)`); process.exit(1); }
const bad = rejectBypass(["--self-test", "--root"]);
if (bad.length) fail(`bypass rejected: ${bad.join(", ")}`);
for (const [k, v] of Object.entries(process.env)) if (/^(VALIDATION_DISABLED|ANTAS_BYPASS|VLT_BYPASS|VAULT_BYPASS)$/i.test(k) && v && !/^(0|false|no)$/i.test(v)) fail(`bypass rejected: ${k}`);
const ts = createRequire(path.join(ROOT, "package.json"))("typescript");

// ── graph construction ──────────────────────────────────────────────────────────────────────────────────────────
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "build", "coverage", "__tests__", "__mocks__"]);
const isSource = (n) => /\.(ts|tsx|mts|cts)$/.test(n) && !/\.d\.ts$/.test(n) && !/\.(test|spec)\.(ts|tsx)$/.test(n);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (isSource(e.name)) out.push(p);
  }
  return out;
}
const CAND = (base) => [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
function resolveRel(fromFile, spec, fileSet) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const stripped = base.replace(/\.(m|c)?js$/, "");
  for (const c of [...CAND(base), ...CAND(stripped)]) if (fileSet.has(c)) return c;
  return null;
}
const EXT_FILE = ["", ".mjs", ".js", ".cjs", ".json", "/index.js", "/index.mjs"];
function resolveDiskFile(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const x of EXT_FILE) { const c = base + x; try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}
function extractImports(abs) {
  const text = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (spec, n, kind, typeOnly) => out.push({ spec, line: line(n), kind, typeOnly });
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const nb = c?.namedBindings;
      const allTypeNamed = !!c && !c.name && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
      add(n.moduleSpecifier.text, n, "import", !!c?.isTypeOnly || allTypeNamed);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const nb = n.exportClause;
      const allTypeNamed = !!nb && ts.isNamedExports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
      add(n.moduleSpecifier.text, n, "export-from", !!n.isTypeOnly || allTypeNamed);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      add(n.moduleReference.expression.text, n, "require", !!n.isTypeOnly);
    } else if (ts.isCallExpression(n)) {
      const a = n.arguments[0];
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && a && ts.isStringLiteralLike(a)) add(a.text, n, "dynamic-import", false);
      else if (ts.isIdentifier(n.expression) && n.expression.text === "require" && a && ts.isStringLiteralLike(a)) add(a.text, n, "require", false);
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      add(n.argument.literal.text, n, "import-type", true);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function buildGraph(repo, cfg) {
  const srcRoot = path.join(repo, cfg.src_root);
  if (!fs.existsSync(srcRoot)) fail(`source root missing: ${cfg.src_root} (fail closed)`);
  const vaultRoot = path.join(repo, cfg.vault_root);
  if (!fs.existsSync(vaultRoot)) fail(`vault root missing: ${cfg.vault_root} (fail closed)`);
  const files = walk(srcRoot);
  const fileSet = new Set(files);
  const rel = (p) => path.relative(repo, p).split(path.sep).join("/");
  const vaultFiles = files.filter((f) => f.startsWith(vaultRoot + path.sep));
  if (!vaultFiles.length) fail(`no Vault source files under ${cfg.vault_root} (fail closed)`);
  const nodes = new Map();
  const edges = [];
  for (const f of files) {
    nodes.set(f, { file: rel(f), zone: zoneOf(f, repo, cfg) });
    for (const imp of extractImports(f)) {
      const e = { from: f, ...imp, to: null, external: null };
      if (imp.spec.startsWith(".")) {
        e.to = resolveRel(f, imp.spec, fileSet) ?? null;
        if (!e.to) { const d = resolveDiskFile(f, imp.spec); if (d) e.diskFile = path.relative(repo, d).split(path.sep).join("/"); else e.unresolved = true; }
      }
      else e.external = imp.spec;
      edges.push(e);
    }
  }
  return { repo, srcRoot, vaultRoot, files, nodes, edges, rel, vaultFiles };
}
// zone: vault/<layer> | routes | middlewares | frontend | src (everything else under api-server/src)
function zoneOf(abs, repo, cfg) {
  const vr = path.join(repo, cfg.vault_root), sr = path.join(repo, cfg.src_root);
  if (abs.startsWith(vr + path.sep)) {
    const r = path.relative(vr, abs).split(path.sep);
    return r.length === 1 ? "vault:(root)" : `vault:${r[0]}`;
  }
  if (abs.startsWith(sr + path.sep)) {
    const top = path.relative(sr, abs).split(path.sep)[0];
    if (cfg.route_layer.route_dirs.includes(top)) return "routes";
    if (cfg.route_layer.middleware_dirs.includes(top)) return "middlewares";
    return `src:${top}`;
  }
  return "other";
}
const layerOf = (zone) => (zone.startsWith("vault:") ? zone.slice(6) : null);
const featureOf = (abs, vaultRoot, layer) => { const r = path.relative(path.join(vaultRoot, layer), abs).split(path.sep); return r.length > 1 ? r[0] : null; };

// ── Tarjan SCC over runtime (non-type-only) edges ───────────────────────────────────────────────────────────────
function cycles(g) {
  const adj = new Map(); for (const f of g.files) adj.set(f, []);
  const edgeAt = new Map();
  for (const e of g.edges) if (e.to && !e.typeOnly) { adj.get(e.from).push(e.to); if (!edgeAt.has(`${e.from}|${e.to}`)) edgeAt.set(`${e.from}|${e.to}`, e); }
  let idx = 0; const index = new Map(), low = new Map(), on = new Set(), stack = [], sccs = [];
  const strong = (v) => {
    // iterative Tarjan to survive deep graphs
    const work = [[v, 0]]; index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
    while (work.length) {
      const top = work[work.length - 1]; const [node, i] = top; const nb = adj.get(node);
      if (i < nb.length) {
        top[1]++; const w = nb[i];
        if (!index.has(w)) { index.set(w, idx); low.set(w, idx); idx++; stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(node, Math.min(low.get(node), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(node))); }
        if (low.get(node) === index.get(node)) { const comp = []; let w; do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== node); sccs.push(comp); }
      }
    }
  };
  for (const v of g.files) if (!index.has(v)) strong(v);
  return sccs.filter((c) => c.length > 1 || edgeAt.has(`${c[0]}|${c[0]}`)).map((c) => ({ members: c.sort(), edgeAt }));
}

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
function analyze(repo, cfg) {
  const g = buildGraph(repo, cfg);
  const V = [];
  const push = (rule, e, detail, extra = {}) => V.push({ file: g.rel(e.from), line: e.line, rule, from_layer: layerOf(g.nodes.get(e.from).zone), spec: e.spec, type_only: !!e.typeOnly, detail, ...extra });
  const legacy = new Set([...cfg.legacy.files.map((f) => path.join(repo, f))]);
  const re = new RegExp(cfg.legacy.glob_name);
  for (const d of cfg.legacy.glob_dirs) { const dir = path.join(repo, d); if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (re.test(n)) legacy.add(path.join(dir, n)); }
  const bans = Object.entries(cfg.external_bans).filter(([k]) => !k.startsWith("_")).map(([k, v]) => ({ kind: k, re: new RegExp(v.pattern), banned_in: v.banned_in }));
  const frontendPath = new RegExp(cfg.frontend_path_pattern);
  const crossLayers = new Set(cfg.cross_feature.layers), publicSurface = new Set(cfg.cross_feature.public_surface);
  const observed = {}, external_files = new Set();
  const compRoots = new Set((cfg.composition_roots?.files ?? []).map((f) => path.join(repo, f)));

  for (const e of g.edges) {
    const fromZone = g.nodes.get(e.from).zone, fromLayer = layerOf(fromZone);
    const toNode = e.to ? g.nodes.get(e.to) : null, toLayer = toNode ? layerOf(toNode.zone) : null;
    // A7 / A8 apply to every file in api-server/src (consumers outside the Vault too)
    if (e.to && legacy.has(e.to) && e.from !== e.to) push("A7-legacy-import", e, `imports legacy implementation ${g.rel(e.to)} — import the Vault owner instead`);
    if (e.to && !fromLayer && toLayer && !cfg.outside_may_import_from_vault.includes(toLayer) && !compRoots.has(e.from)) push("A8-outside-deep-import", e, `${fromZone} reaches into private Vault layer vault/${toLayer} (${g.rel(e.to)})`);
    if (!fromLayer) continue; // remaining rules govern Vault-owned files

    const key = `${fromLayer} -> ${toLayer ?? (toNode ? toNode.zone : e.external ? "pkg" : e.diskFile ? "workspace-file" : "unresolved")}`;
    observed[key] = (observed[key] ?? 0) + 1;

    if (e.unresolved) { push("A0-unresolved", e, `relative import does not resolve to any file on disk`); continue; }
    if (e.diskFile) { external_files.add(e.diskFile); continue; }
    if (e.to) {
      if (toLayer) {
        if (!cfg.allowed_layer_imports[fromLayer]?.includes(toLayer)) push("A2-layer-direction", e, `${fromLayer} → ${toLayer} is not allowed (allowed: ${(cfg.allowed_layer_imports[fromLayer] ?? []).join(", ") || "none"})`, { to_layer: toLayer });
        if (fromLayer === "domain" && toLayer !== "domain") push("A3-domain-purity", e, `domain imports vault/${toLayer}`);
        if (crossLayers.has(fromLayer) && crossLayers.has(toLayer)) {
          const ff = featureOf(e.from, g.vaultRoot, fromLayer), tf = featureOf(e.to, g.vaultRoot, toLayer);
          const shortTo = g.rel(e.to);
          if (tf && (fromLayer !== toLayer || ff !== tf) && !/\/index\.tsx?$/.test(g.rel(e.from)) && !publicSurface.has(shortTo) && !/\/index\.tsx?$/.test(shortTo)) push("A6-cross-feature-private", e, `${fromLayer}/${ff ?? "(root)"} imports private ${toLayer}/${tf} file ${shortTo}`);
        }
      } else if (toNode) {
        const z = toNode.zone;
        if (z === "routes" && cfg.route_layer.routes_banned_in.some((l) => l === "*" || l === fromLayer)) push("A5-route-import", e, `${fromLayer} depends on route module ${g.rel(e.to)}`, { to_layer: "routes" });
        else if (z === "middlewares" && cfg.route_layer.middlewares_banned_in.includes(fromLayer)) push("A5-middleware-import", e, `${fromLayer} depends on HTTP middleware ${g.rel(e.to)}`, { to_layer: "middlewares" });
        else if (fromLayer === "domain") push("A3-domain-purity", e, `domain imports platform module ${g.rel(e.to)}`);
        if (frontendPath.test(g.rel(e.to))) push("A4-frontend-import", e, `${fromLayer} imports frontend path ${g.rel(e.to)}`);
      }
    }
    if (e.external) for (const b of bans) if (b.re.test(e.external) && (b.banned_in.includes("*") || b.banned_in.includes(fromLayer))) push(`A4-${b.kind}-import`, e, `${fromLayer} imports ${b.kind} module "${e.external}"${e.kind === "dynamic-import" ? " (dynamic)" : ""}${e.typeOnly ? " (type-only)" : ""}`);
  }
  // A1 cycles that include at least one Vault file
  for (const c of cycles(g)) {
    if (!c.members.some((m) => layerOf(g.nodes.get(m).zone))) continue;
    const memberSet = new Set(c.members);
    const inner = g.edges.filter((e) => e.to && !e.typeOnly && memberSet.has(e.from) && memberSet.has(e.to));
    const first = inner.sort((a, b) => (g.rel(a.from) + a.line).localeCompare(g.rel(b.from) + b.line))[0];
    push("A1-cycle", first, `runtime import cycle of ${c.members.length} file(s): ${c.members.map(g.rel).join(" ⇄ ")}`, { cycle: c.members.map(g.rel) });
  }
  V.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { g, V, observed, external_files: [...external_files].sort() };
}

// ── self-test: planted violations must be caught; clean and look-alike code must pass ──────────────────────────
if (SELF_TEST) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gap14-"));
  const S = path.join(tmp, cfg.src_root), V = path.join(tmp, cfg.vault_root);
  const put = (rel, body) => { const p = path.join(S, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  // clean baseline
  put("vault/domain/pure.ts", `export const A = 1;\n`);
  put("vault/crypto/c.ts", `import { A } from "../domain/pure";\nexport const B = A;\n`);
  put("vault/infrastructure/repo.ts", `import { db } from "@workspace/db";\nimport { A } from "../domain/pure";\nexport const r = () => [db, A];\n`);
  put("vault/security/g.ts", `import type { Request } from "express";\nimport { r } from "../infrastructure/repo";\nexport const g = (q: Request) => [q, r];\n`);
  put("vault/application/entity/own.ts", `import { r } from "../../infrastructure/repo";\nimport { k } from "../kernel";\nexport const o = () => [r, k];\n`);
  put("vault/application/kernel.ts", `export const k = 1;\n`);
  put("vault/application/entity/index.ts", `export * from "./own";\n`);
  put("vault/shared/s.ts", `import { o } from "../application/entity";\nexport const s = o;\n`);
  put("vault/api/a.ts", `import { s } from "../shared/s";\nexport const a = s;\n`);
  put("routes/ok.ts", `import { a } from "../vault/api/a";\nexport default a;\n`);
  put("lib/vault-pin-guard.ts", `export const legacy = 1;\n`);
  put("middlewares/auth.ts", `export const requireAuth = 1;\n`);
  put("lib/x.ts", `export const x = 1;\n`);
  // type-only cycle is erased at runtime → must NOT be reported
  put("vault/application/tc/a.ts", `import type { B } from "./b";\nexport type A = { b: B };\n`);
  put("vault/application/tc/b.ts", `import type { A } from "./a";\nexport type B = { a: A };\n`);
  put("index.ts", `import "./vault/infrastructure/repo";\n`); // composition root may reach into infrastructure
  put("vault/application/entity/viaMjs.ts", `import { z } from "../../../../../../packages/vault-crypto/src/aes-gcm.mjs";\nexport const v = z;\n`);
  fs.mkdirSync(path.join(tmp, "packages/vault-crypto/src"), { recursive: true }); fs.writeFileSync(path.join(tmp, "packages/vault-crypto/src/aes-gcm.mjs"), "export const z = 1;\n");
  put("vault/application/kyc/index.ts", `export * from "../entity/own";\n`); // barrel importer exempt from A6
  const cases = [
    { name: "clean-tree(+composition-root,+mjs-package,+barrel)", rules: [] },
    { name: "A1-cycle", plant: () => { put("vault/application/cy/a.ts", `import { b } from "./b";\nexport const a = () => b;\n`); put("vault/application/cy/b.ts", `import { a } from "./a";\nexport const b = () => a;\n`); }, rules: ["A1-cycle"] },
    { name: "A2-infrastructure→application", plant: () => put("vault/infrastructure/bad.ts", `import { o } from "../application/entity/own";\nexport const bad = o;\n`), rules: ["A2-layer-direction"] },
    { name: "A2-crypto→infrastructure", plant: () => put("vault/crypto/bad.ts", `import { r } from "../infrastructure/repo";\nexport const bad = r;\n`), rules: ["A2-layer-direction"] },
    { name: "A3-domain→platform-lib", plant: () => put("vault/domain/bad.ts", `import { x } from "../../lib/x";\nexport const bad = x;\n`), rules: ["A3-domain-purity"] },
    { name: "A3-domain→vault-layer", plant: () => put("vault/domain/bad2.ts", `import { r } from "../infrastructure/repo";\nexport const bad = r;\n`), rules: ["A3-domain-purity", "A2-layer-direction"] },
    { name: "A4-domain→db", plant: () => put("vault/domain/db.ts", `import { db } from "@workspace/db";\nexport const bad = db;\n`), rules: ["A4-db-import"] },
    { name: "A4-application→drizzle(type-only)", plant: () => put("vault/application/entity/t.ts", `import type { SQL } from "drizzle-orm";\nexport type T = SQL;\n`), rules: ["A4-db-import"], typeOnly: true },
    { name: "A4-application→express", plant: () => put("vault/application/entity/h.ts", `import { Request } from "express";\nexport const h = (r: Request) => r;\n`), rules: ["A4-http-import"] },
    { name: "A4-application→dynamic-db", plant: () => put("vault/application/entity/d.ts", `export const d = async () => (await import("@workspace/db")).db;\n`), rules: ["A4-db-import"] },
    { name: "A4-application→require(pg)", plant: () => put("vault/application/entity/rq.ts", `const pg = require("pg");\nexport const rq = pg;\n`), rules: ["A4-db-import"] },
    { name: "A4-application→provider(fs)", plant: () => put("vault/application/entity/p.ts", `import fs from "node:fs";\nexport const p = fs;\n`), rules: ["A4-provider-import"] },
    { name: "A4-application→frontend(react)", plant: () => put("vault/application/entity/f.ts", `import React from "react";\nexport const f = React;\n`), rules: ["A4-frontend-import"] },
    { name: "A4-infrastructure→express", plant: () => put("vault/infrastructure/h.ts", `import type { Response } from "express";\nexport type H = Response;\n`), rules: ["A4-http-import"] },
    { name: "A5-application→route", plant: () => { put("routes/foo.ts", `export default 1;\n`); put("vault/application/entity/r.ts", `import foo from "../../../routes/foo";\nexport const r = foo;\n`); }, rules: ["A5-route-import"] },
    { name: "A5-api→route", plant: () => { put("routes/foo.ts", `export default 1;\n`); put("vault/api/r.ts", `export { default as foo } from "../../routes/foo";\n`); }, rules: ["A5-route-import"] },
    { name: "A5-infrastructure→route", plant: () => { put("routes/foo.ts", `export default 1;\n`); put("vault/infrastructure/r.ts", `export { default as foo } from "../../routes/foo";\n`); }, rules: ["A5-route-import"] },
    { name: "A5-application→middleware", plant: () => put("vault/application/entity/m.ts", `import { requireAuth } from "../../../middlewares/auth";\nexport const m = requireAuth;\n`), rules: ["A5-middleware-import"] },
    { name: "A6-cross-feature-private", plant: () => put("vault/application/kyc/x.ts", `import { o } from "../entity/own";\nexport const x = o;\n`), rules: ["A6-cross-feature-private"] },
    { name: "A7-legacy-import(outside)", plant: () => put("routes/passkey.ts", `import { legacy } from "../lib/vault-pin-guard";\nexport default legacy;\n`), rules: ["A7-legacy-import"] },
    { name: "A7-legacy-import(vault)", plant: () => put("vault/security/leg.ts", `import { legacy } from "../../lib/vault-pin-guard";\nexport const l = legacy;\n`), rules: ["A7-legacy-import"] },
    { name: "A8-outside-deep-import", plant: () => put("routes/bypass.ts", `import { r } from "../vault/infrastructure/repo";\nexport default r;\n`), rules: ["A8-outside-deep-import"] },
    { name: "A8-composition-root-exempt-but-routes-not", plant: () => put("routes/bypass.ts", `import { r } from "../vault/infrastructure/repo";\nexport default r;\n`), rules: ["A8-outside-deep-import"] },
    { name: "A0-unresolved", plant: () => put("vault/application/entity/u.ts", `import { nope } from "./does-not-exist";\nexport const u = nope;\n`), rules: ["A0-unresolved"] },
  ];
  const results = [];
  const snapshot = (dir) => { const o = {}; for (const f of walk(dir)) o[f] = fs.readFileSync(f, "utf8"); return o; };
  const clean = snapshot(S);
  for (const c of cases) {
    // reset tree to clean, plant exactly one case
    for (const f of walk(S)) if (!(f in clean)) fs.rmSync(f);
    c.plant?.();
    const { V: found } = analyze(tmp, cfg);
    const got = [...new Set(found.map((v) => v.rule))];
    const ok = c.rules.length === 0 ? got.length === 0 : c.rules.every((r) => got.includes(r)) && got.every((r) => c.rules.includes(r))
      && (c.typeOnly === undefined || found.some((v) => c.rules.includes(v.rule) && v.type_only === c.typeOnly));
    const withLine = c.rules.length === 0 || found.every((v) => v.line >= 1 && v.file);
    results.push({ case: c.name, expected: c.rules, caught: got, ok: ok && withLine });
    if (!(ok && withLine)) { fs.rmSync(tmp, { recursive: true, force: true }); fail(`self-test: ${c.name} expected ${JSON.stringify(c.rules)}, scanner reported ${JSON.stringify(got)}`); }
  }
  // fail closed on empty / missing roots
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "gap14-empty-"));
  fs.mkdirSync(path.join(empty, cfg.vault_root), { recursive: true });
  const probe = (r) => { try { analyze(r, cfg); return false; } catch { return true; } };
  const origExit = process.exit, origErr = console.error; let closed = 0;
  process.exit = () => { throw new Error("exit"); }; console.error = () => {};
  closed += probe(empty) ? 1 : 0; closed += probe(path.join(empty, "nope")) ? 1 : 0;
  process.exit = origExit; console.error = origErr;
  fs.rmSync(empty, { recursive: true, force: true });
  if (closed !== 2) { fs.rmSync(tmp, { recursive: true, force: true }); fail("self-test: empty/missing Vault root did not fail closed"); }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "ci-fail-proof.json"), JSON.stringify({ gap: GAP, kind: "intentional-violation-self-test", config_sha256: sha256(fs.readFileSync(CONFIG_PATH, "utf8")), cases: results, fail_closed_probes: 2, status: "PASS" }, null, 2) + "\n");
  console.log(`${GAP}/self-test PASS — ${results.length} cases behaved as expected (${results.filter((r) => r.expected.length).length} violations caught, clean tree + type-only cycle accepted, empty/missing root fails closed)`);
  process.exit(0);
}

// ── real scan ───────────────────────────────────────────────────────────────────────────────────────────────────
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { g, V: violations, observed, external_files } = analyze(ROOT_OVERRIDE ?? ROOT, cfg);
const byRule = {}, byLayer = {};
for (const x of violations) { byRule[x.rule] = (byRule[x.rule] ?? 0) + 1; const k = x.from_layer ?? "outside-vault"; byLayer[k] = (byLayer[k] ?? 0) + 1; }
const vaultEdges = g.edges.filter((e) => layerOf(g.nodes.get(e.from).zone) || (e.to && layerOf(g.nodes.get(e.to).zone)));
const graph = {
  gap: GAP, generated_at: new Date().toISOString(),
  files: g.files.length, vault_files: g.vaultFiles.length, edges_total: g.edges.length, edges_touching_vault: vaultEdges.length,
  nodes: [...g.nodes.values()].filter((n) => n.zone.startsWith("vault:")).map((n) => n).sort((a, b) => a.file.localeCompare(b.file)),
  edges: vaultEdges.map((e) => ({ from: g.rel(e.from), to: e.to ? g.rel(e.to) : null, external: e.external, line: e.line, kind: e.kind, type_only: e.typeOnly })).sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line),
};
const report = {
  gap: GAP, sub_phase: "VLT-GAP-14-A", scanned_at: new Date().toISOString(), config_sha256: sha256(fs.readFileSync(CONFIG_PATH, "utf8")),
  files_scanned: g.files.length, vault_files: g.vaultFiles.length, edges_total: g.edges.length,
  vault_imports_of_non_ts_workspace_files: external_files,
  observed_vault_edges: Object.fromEntries(Object.entries(observed).sort()),
  violations_total: violations.length, violations_by_rule: byRule, violations_by_layer: byLayer,
  cycles: violations.filter((v) => v.rule === "A1-cycle").map((v) => v.cycle),
  violations, status: violations.length === 0 ? "PASS" : "FAIL",
};
if (!ROOT_OVERRIDE) { // evidence is only written for the real tree; --root runs (14-D planted copies) must not overwrite it
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "import-graph.json"), JSON.stringify(graph, null, 1) + "\n");
fs.writeFileSync(path.join(OUT_DIR, "architecture.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`${GAP}: ${g.vaultFiles.length} Vault files / ${g.files.length} api-server files / ${g.edges.length} imports — graph written`);
for (const [r, n] of Object.entries(byRule).sort()) console.log(`  ${r.padEnd(26)} ${n}`);
if (violations.length) {
  for (const x of violations.slice(0, 60)) console.error(`  ${x.file}:${x.line} [${x.rule}] ${x.detail}`);
  if (violations.length > 60) console.error(`  … ${violations.length - 60} more (see reports/antas/vault/gap/${GAP}/architecture.json)`);
  fail(`${violations.length} architecture violation(s) ${JSON.stringify(byRule)}`);
}
console.log(`${GAP} PASS — 0 architecture violations, 0 runtime cycles`);
