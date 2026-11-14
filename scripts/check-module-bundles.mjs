#!/usr/bin/env node
/**
 * scripts/check-module-bundles.mjs — W2-P2 CI check (blocking): "the Sylo bundle contains 0 Verve/Skarn pages" for every pair.
 * Install-free stand-in for the bundle analyzer: it walks the SPA import graph from src/main.tsx exactly the way the module
 * build resolves it (other modules' pages stubbed), then proves the other modules' pages are unreachable. The real build runs
 * the same proof on the finished chunks (vite.module.config.ts fails the build and writes dist/module-reports/<id>.json).
 *   node scripts/check-module-bundles.mjs              # check
 *   node scripts/check-module-bundles.mjs --self-test  # prove each rule fails on a deliberate breakage
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as registry from "../packages/module-registry/src/index.mjs";
import { analyzeRouteConfig, excludedPagesFor, propagateOwnership } from "../artifacts/ayzen/build/module-pages.mjs";
import { importsOf, walk } from "../artifacts/ayzen/build/import-graph.mjs";
import { renderAll } from "./gen-module-deploy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AYZEN = "artifacts/ayzen";
const read = (root, f) => readFileSync(join(root, f), "utf8");
const abs = (src) => (rel) => [".tsx", ".ts"].map((e) => join(src, rel + e)).find((p) => existsSync(p)) ?? null;

/** Everything the rules need, computed from a tree root (the repo, or a mutated copy of it in self-test). */
function analyze(root) {
  const src = join(root, AYZEN, "src");
  const toAbs = abs(src);
  const routeSrc = read(root, `${AYZEN}/src/lib/route-config.tsx`);
  const raw = analyzeRouteConfig(routeSrc, registry);
  const rawOwners = new Map([...raw.pages].map(([k, e]) => [k, { owners: new Set(e.owners), shared: e.shared }]));
  const propagated = propagateOwnership(analyzeRouteConfig(routeSrc, registry), (f) => importsOf(f, src), toAbs);
  const entry = join(src, "main.tsx");
  const builds = {};
  for (const m of registry.MODULE_IDS) {
    const stubbed = new Set(excludedPagesFor(propagated, m).map(toAbs).filter(Boolean));
    const w = walk(entry, src, stubbed);
    builds[m] = { stubbed, ...w, pages: new Set([...w.reachable].map((f) => relative(src, f).replace(/\.tsx?$/, "").replace(/\\/g, "/")).filter((r) => r.startsWith("pages/"))) };
  }
  return { root, src, toAbs, raw, rawOwners, propagated, builds, unresolved: raw.unresolved };
}

const allowlist = (root) => new Map(JSON.parse(read(root, `${AYZEN}/build/shared-page-allowlist.json`)).pages.map((p) => [p.page, p]));

const RULES = [
  ["route-config fully resolves: every route's component maps to a lazy page import", (a) => (a.unresolved.length ? `unresolved: ${a.unresolved.slice(0, 5).join("; ")}` : a.raw.pages.size < 100 ? `only ${a.raw.pages.size} pages parsed` : null)],
  ["every module build stubs other modules' pages (non-empty exclusion) and keeps its own owned pages reachable", (a) => {
    const min = JSON.parse(read(a.root, `${AYZEN}/build/shared-page-allowlist.json`)).minOwnedPages ?? {};
    for (const m of registry.MODULE_IDS) {
      const owned = [...a.rawOwners].filter(([, e]) => !e.shared && e.owners.has(m)).length;
      if (owned < (min[m] ?? 1)) return `${m}: owns ${owned} pages, ratchet says at least ${min[m]} (a route moved out of its prefix?)`;
      if (a.builds[m].stubbed.size === 0) return `${m}: nothing is excluded`;
      for (const [page, e] of a.rawOwners) {
        if (!e.shared && e.owners.has(m) && !a.builds[m].pages.has(page)) return `${m}: own page ${page} is not in its bundle`;
      }
    }
    return null;
  }],
  ["PROOF: no module bundle reaches another module's page (beyond the audited allow-list)", (a) => {
    const allowed = allowlist(a.root);
    const leaks = new Map();
    for (const m of registry.MODULE_IDS) for (const [page, e] of a.rawOwners) {
      if (e.shared || e.owners.size === 0 || e.owners.has(m)) continue;
      if (a.builds[m].pages.has(page)) leaks.set(page, [...(leaks.get(page) ?? []), m]);
    }
    const unexpected = [...leaks].filter(([p]) => !allowed.has(p));
    if (unexpected.length) return `${unexpected.length} page(s) leak into other modules: ${unexpected.slice(0, 4).map(([p, ms]) => `${p} -> ${ms.join("/")}`).join("; ")}`;
    const stale = [...allowed.keys()].filter((p) => !leaks.has(p));
    return stale.length ? `stale allow-list entries (remove them): ${stale.join(", ")}` : null;
  }],
  ["the Sylo bundle has 0 Verve and 0 Skarn pages (the roadmap's done criterion, named explicitly)", (a) => {
    const allowed = allowlist(a.root);
    const bad = [];
    for (const [page, e] of a.rawOwners) {
      if (e.shared || allowed.has(page)) continue;
      if ((e.owners.has("verve") || e.owners.has("skarn")) && !e.owners.has("sylo") && a.builds.sylo.pages.has(page)) bad.push(page);
    }
    const owned = (id) => [...a.rawOwners].filter(([, e]) => !e.shared && e.owners.has(id) && !e.owners.has("sylo")).length;
    return bad.length ? `sylo bundle has ${bad.length} verve/skarn page(s): ${bad.slice(0, 4).join(", ")}` : owned("verve") + owned("skarn") === 0 ? "verve/skarn own no pages: the proof would be vacuous" : null;
  }],
  ["a page stubbed in some build is imported only by route-config (named imports would break that build)", (a) => {
    const bad = new Set();
    for (const m of registry.MODULE_IDS) for (const [t, imps] of a.builds[m].importersOfStubs) {
      for (const i of imps) if (!i.endsWith(join("lib", "route-config.tsx"))) bad.add(`${relative(a.src, t)} <- ${relative(a.src, i)} (${m} build)`);
    }
    return bad.size ? [...bad].slice(0, 4).join("; ") : null;
  }],
  ["the full build is untouched: no source reads VITE_SPLIT_REDIRECTS, and VITE_MODULE is read only through build-module.ts", (a) => {
    const hits = [];
    const dirWalk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) dirWalk(p); else if (/\.(tsx?|mjs)$/.test(e.name)) { const t = readFileSync(p, "utf8"); const rel = relative(a.src, p); if (/VITE_SPLIT_REDIRECT/.test(t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""))) hits.push(`${rel}: VITE_SPLIT_REDIRECTS`); if (/VITE_MODULE\b/.test(t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")) && !rel.endsWith("build-module.ts") && !rel.includes("test")) hits.push(`${rel}: reads VITE_MODULE directly`); } } };
    dirWalk(a.src);
    return hits.length ? hits.slice(0, 4).join("; ") : null;
  }],
  ["App.tsx only mounts routes that belong in this build", (a) => {
    const t = read(a.root, `${AYZEN}/src/App.tsx`);
    return t.includes("ADMIN_ROUTES.filter((r) => isRouteInBuild(r.path))") && t.includes("USER_ROUTES.filter((r) => isRouteInBuild(r.path))") ? null : "route filters missing";
  }],
  ["build-module.ts: null build = no restriction; module build keeps own + unowned paths only; unknown id ignored", (a) => {
    const t = read(a.root, `${AYZEN}/src/lib/build-module.ts`);
    return ["if (!build) return true;", "owner === null || owner === build", "getModule(id) ? (id as ModuleId) : null"].every((n) => t.includes(n)) ? null : "build-module.ts changed";
  }],
  ["subdomain-app: a module build is that module on any hostname", (a) => (read(a.root, `${AYZEN}/src/lib/subdomain-app.ts`).includes("const built = buildModuleId();") ? null : "buildModuleId not used")],
  ["vite.module.config.ts: validates VITE_MODULE, defines it, per-module outDir, stubs via resolveId, fails the build on a leak, writes the report", (a) => {
    const t = read(a.root, `${AYZEN}/vite.module.config.ts`);
    const need = ["if (!(MODULE_IDS as readonly string[]).includes(moduleId)) {", "define: { 'import.meta.env.VITE_MODULE': JSON.stringify(moduleId) }", "outDir: path.join(root, 'dist/modules', moduleId)",
      "enforce: 'pre'", "return rel ? STUB_PREFIX + rel : null;", "this.error(`${moduleId} bundle contains other modules' pages", "dist/module-reports", "propagateOwnership("];
    return need.find((n) => !t.includes(n)) ? `missing: ${need.find((n) => !t.includes(n))}` : null;
  }],
  ["package scripts: build:module(s) exist; CI runs this check, the deploy check and builds a module bundle", (a) => {
    const p = read(a.root, `${AYZEN}/package.json`), c = read(a.root, ".github/workflows/ci.yml");
    if (!p.includes('"build:module": "vite build --config vite.module.config.ts') || !p.includes('"build:modules"')) return "package.json scripts missing";
    return (c.match(/check-module-bundles\.mjs/g) ?? []).length >= 2 && c.includes("check-module-bundles.mjs --self-test") && c.includes("gen-module-deploy.mjs --check") && c.includes("build:module") ? null : "ci.yml wiring missing";
  }],
  ["deploy targets: one generated Vercel config per module (own VITE_MODULE, own outputDirectory), up to date", (a) => {
    const files = renderAll(registry.MODULES);
    for (const [f, content] of files) {
      if (!existsSync(join(a.root, f)) || read(a.root, f) !== content) return `${f} is missing or stale (node scripts/gen-module-deploy.mjs)`;
    }
    for (const m of registry.MODULES) {
      const cfg = JSON.parse(read(a.root, `deploy/modules/${m.id}/vercel.json`));
      if (cfg.build.env.VITE_MODULE !== m.id || !cfg.outputDirectory.endsWith(`/${m.id}`)) return `${m.id} deploy config points at another module`;
    }
    return null;
  }],
];

function run(a) {
  return RULES.flatMap(([id, fn]) => { let p; try { p = fn(a); } catch (e) { p = `threw: ${e.message}`; } return p ? [`${id}: ${p}`] : []; });
}

function report(a) {
  const total = a.raw.pages.size;
  return Object.fromEntries(registry.MODULE_IDS.map((m) => [m, { pagesInBundle: a.builds[m].pages.size, stubbed: a.builds[m].stubbed.size, sourceFiles: a.builds[m].reachable.size }]).concat([["_routedPages", { total }]]));
}

if (process.argv.includes("--self-test")) {
  const clean = run(analyze(ROOT));
  if (clean.length) { console.error("self-test needs a clean tree first:\n - " + clean.join("\n - ")); process.exit(1); }
  const A = `${AYZEN}/src`;
  /** Each mutant edits a COPY of the files it needs (the whole src tree is copied once per mutant). */
  const mutants = [
    ["a shared page statically imports a verve page", `${A}/pages/user/home.tsx`, (t) => `import "@/pages/user/marketplace";\n${t}`],
    ["a shared component imports a skarn page", `${A}/components/layout/app-layout.tsx`, (t) => `import "@/pages/user/projects";\n${t}`],
    ["route-config drops the lazy import of a page", `${A}/lib/route-config.tsx`, (t) => t.replace(/const UserProjects\s*= lazy\(\(\) => import\("@\/pages\/user\/projects"\)\);/, "")],
    ["a sylo route is renamed out of its prefix (page becomes shared)", `${A}/lib/route-config.tsx`, (t) => t.replace('{ path: "/vault/settings",', '{ path: "/vaultx/settings",')],
    ["a verve page becomes shared through a shared importer", `${A}/pages/user/home.tsx`, (t) => `import "@/pages/user/marketplace-hub";\n${t}`],
    ["App.tsx stops filtering admin routes", `${A}/App.tsx`, (t) => t.replace("ADMIN_ROUTES.filter((r) => isRouteInBuild(r.path)).map(", "ADMIN_ROUTES.map(")],
    ["App.tsx stops filtering user routes", `${A}/App.tsx`, (t) => t.replace("USER_ROUTES.filter((r) => isRouteInBuild(r.path)).map(", "USER_ROUTES.map(")],
    ["the split-redirect flag comes back", `${A}/App.tsx`, (t) => t + '\nconst legacyFlag = import.meta.env.VITE_SPLIT_REDIRECTS;\n'],
    ["a component reads VITE_MODULE directly", `${A}/components/layout/app-layout.tsx`, (t) => t + '\nconst m = import.meta.env.VITE_MODULE;\n'],
    ["build-module treats no build as restricted", `${A}/lib/build-module.ts`, (t) => t.replace("if (!build) return true;", "if (!build) return false;")],
    ["build-module drops the unowned-path rule", `${A}/lib/build-module.ts`, (t) => t.replace("owner === null || owner === build", "owner === build")],
    ["subdomain-app ignores the build module", `${A}/lib/subdomain-app.ts`, (t) => t.replace("const built = buildModuleId();", "const built = null as string | null;")],
    ["vite config stops failing on a leak", `${AYZEN}/vite.module.config.ts`, (t) => t.replace("this.error(`${moduleId} bundle contains other modules' pages", "console.log(`${moduleId} bundle contains other modules' pages")],
    ["vite config stops validating the module", `${AYZEN}/vite.module.config.ts`, (t) => t.replace("MODULE_IDS as readonly string[]).includes(moduleId)", "MODULE_IDS as readonly string[]).includes(moduleId) || true")],
    ["vite config writes every module to the same dir", `${AYZEN}/vite.module.config.ts`, (t) => t.replace("outDir: path.join(root, 'dist/modules', moduleId)", "outDir: path.join(root, 'dist/modules')")],
    ["vite config skips ownership propagation", `${AYZEN}/vite.module.config.ts`, (t) => t.replace("propagateOwnership(\n    analyzeRouteConfig", "((x: any) => x)(\n    analyzeRouteConfig")],
    ["build:module script removed", `${AYZEN}/package.json`, (t) => t.replace('"build:module": "vite build --config vite.module.config.ts', '"build:module": "vite build --config vite.config.ts')],
    ["CI forgets the bundle check", ".github/workflows/ci.yml", (t) => t.replace("check-module-bundles.mjs --self-test", "check-module-bundles-x.mjs --self-test")],
    ["a deploy config points at another module", "deploy/modules/ryft/vercel.json", (t) => t.replace('"VITE_MODULE": "ryft"', '"VITE_MODULE": "sylo"')],
    ["allow-list gains a stale entry", `${AYZEN}/build/shared-page-allowlist.json`, (t) => t.replace('"pages": [', '"pages": [{"page":"pages/user/vault-hub","ownedBy":"sylo","why":"x"},')],
    ["allow-list loses the audited entry", `${AYZEN}/build/shared-page-allowlist.json`, (t) => t.replace('"page": "pages/user/project-entities"', '"page": "pages/user/nope"')],
  ];
  let survived = 0;
  for (const [name, file, edit] of mutants) {
    const dir = mkdtempSync(join(tmpdir(), "bundles-"));
    try {
      cpSync(join(ROOT, AYZEN, "src"), join(dir, AYZEN, "src"), { recursive: true });
      for (const f of [`${AYZEN}/vite.module.config.ts`, `${AYZEN}/package.json`, `${AYZEN}/build/shared-page-allowlist.json`, ".github/workflows/ci.yml"]) {
        const dest = join(dir, f); cpSync(join(ROOT, f), dest, { recursive: true });
      }
      cpSync(join(ROOT, "deploy"), join(dir, "deploy"), { recursive: true });
      const target = join(dir, file);
      const before = existsSync(target) ? readFileSync(target, "utf8") : null;
      if (before === null) { console.error(`MUTANT NOT APPLICABLE (file missing): ${name}`); survived++; continue; }
      const after = edit(before);
      if (after === before) { console.error(`MUTANT NOT APPLICABLE (no change): ${name}`); survived++; continue; }
      writeFileSync(target, after);
      if (run(analyze(dir)).length === 0) { console.error(`SURVIVED: ${name}`); survived++; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(survived ? `SELF-TEST FAILED: ${survived} mutant(s) not caught` : `SELF-TEST OK: ${mutants.length}/${mutants.length} mutants caught`);
  process.exit(survived ? 1 : 0);
}

const a = analyze(ROOT);
const problems = run(a);
if (problems.length) { console.error("MODULE_BUNDLES: FAIL\n - " + problems.join("\n - ")); process.exit(1); }
console.log("MODULE_BUNDLES: PASS");
console.log(JSON.stringify({ rules: RULES.length, ...report(a) }));
