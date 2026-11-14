#!/usr/bin/env node
/**
 * scripts/validate-w2-p3.mjs — W2-P3 static validator (remove the mobile bottom dock, req 5). Install-free.
 *   node scripts/validate-w2-p3.mjs            # validate the tree
 *   node scripts/validate-w2-p3.mjs --self-test  # prove each rule fails on a deliberate breakage
 * The viewport behavior is tested by tests/e2e/mobile-nav/mobile-no-dock.spec.mjs (needs a browser).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "artifacts/ayzen/src";
const FILES = [`${SRC}/components/layout/app-layout.tsx`, `${SRC}/components/layout/app-sidebar.tsx`, "tests/e2e/mobile-nav/mobile-no-dock.spec.mjs",
  ".github/workflows/ci.yml", "docs/module-shell-qa.md", "docs/architecture/ADR-W0-FREEZE.md"];

function load(extra = {}) {
  const files = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  const tree = {};
  const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(e.name)) tree[p] = readFileSync(join(ROOT, p), "utf8"); } };
  walk(SRC);
  return { files: { ...files, ...extra.files }, tree: { ...tree, ...extra.tree }, dockFileExists: extra.dockFileExists ?? existsSync(join(ROOT, `${SRC}/components/layout/mobile-dock.tsx`)) };
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const RULES = [
  ["mobile-dock.tsx is deleted and nothing in the SPA refers to it", (t) => {
    if (t.dockFileExists) return "components/layout/mobile-dock.tsx still exists";
    const refs = Object.entries(t.tree).filter(([, s]) => /MobileDock|mobile-dock/.test(strip(s))).map(([f]) => relative(SRC, f));
    return refs.length ? `still referenced from: ${refs.join(", ")}` : null;
  }],
  ["no other full-width fixed bottom bar exists in the SPA (a dock under another name)", (t) => {
    // components/ui/* are modal primitives (drawer, sheet, toast): overlays that appear on demand, not a persistent bar.
    const bad = Object.entries(t.tree).filter(([f]) => !f.startsWith(`${SRC}/components/ui/`)).filter(([, s]) => /fixed[^"'`]*\bbottom-0\b[^"'`]*\bleft-0\b[^"'`]*\bright-0\b|fixed[^"'`]*\binset-x-0\b[^"'`]*\bbottom-0\b/.test(strip(s))).map(([f]) => relative(SRC, f));
    return bad.length ? `fixed bottom bar in: ${bad.join(", ")}` : null;
  }],
  ["AppLayout: no bottom padding reserved for a dock (pb-24 md:pb-8 is gone)", (t) => {
    const a = strip(t.files[`${SRC}/components/layout/app-layout.tsx`]);
    return /pb-24/.test(a) ? "pb-24 is still reserved" : /flex-1 pb-8">/.test(a) ? null : "content padding changed";
  }],
  ["mobile navigation is the drawer: Sheet with AppSidebar, closes on navigate, opened by an accessible hamburger", (t) => {
    const a = t.files[`${SRC}/components/layout/app-layout.tsx`];
    const need = ["isMobile ? (", "<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>", 'data-testid="mobile-nav-drawer"', '<SheetTitle className="sr-only">', "<AppSidebar onNavigate={() => setMobileOpen(false)} />",
      'aria-label="Open navigation menu"', 'data-testid="mobile-nav-toggle"', "onClick={() => setMobileOpen(true)}"];
    return need.find((n) => !a.includes(n)) ? `missing: ${need.find((n) => !a.includes(n))}` : null;
  }],
  ["the drawer shows the module's own navigation on a module host (ModuleSidebar via AppSidebar)", (t) => (/if \(scopedApp\) \{?\s*return <ModuleSidebar app=\{scopedApp\} onNavigate=\{onNavigate\} \/>/.test(t.files[`${SRC}/components/layout/app-sidebar.tsx`].replace(/\n/g, " ")) || t.files[`${SRC}/components/layout/app-sidebar.tsx`].includes("return <ModuleSidebar app={scopedApp} onNavigate={onNavigate} />") ? null : "AppSidebar no longer renders ModuleSidebar with onNavigate")],
  ["viewport e2e exists (3 phone widths, screenshots, dock detector, self-test) and CI runs its self-test", (t) => {
    const e = t.files["tests/e2e/mobile-nav/mobile-no-dock.spec.mjs"], c = t.files[".github/workflows/ci.yml"];
    const need = ["375", "412", "767", "page.screenshot", "full-width fixed bottom bar", "--self-test", "mobile-nav-drawer"];
    if (need.find((n) => !e.includes(n))) return `spec missing: ${need.find((n) => !e.includes(n))}`;
    return c.includes("mobile-no-dock.spec.mjs --self-test") && c.includes("validate-w2-p3.mjs") ? null : "ci.yml does not run the spec self-test and this validator";
  }],
  ["docs: QA matrix no longer lists dock tabs; ADR Q4 records the default taken", (t) => {
    const q = t.files["docs/module-shell-qa.md"], a = t.files["docs/architecture/ADR-W0-FREEZE.md"];
    return !/\bdock tabs\b/.test(q.replace("the mobile dock was removed in W2-P3", "")) && a.includes("W2-P3 implemented with this default") ? null : "docs not updated";
  }],
];

function run(t) { return RULES.flatMap(([id, fn]) => { let p; try { p = fn(t); } catch (e) { p = `threw: ${e.message}`; } return p ? [`${id}: ${p}`] : []; }); }

if (process.argv.includes("--self-test")) {
  const base = load();
  const clean = run(base);
  if (clean.length) { console.error("self-test needs a clean tree first:\n - " + clean.join("\n - ")); process.exit(1); }
  const L = `${SRC}/components/layout/app-layout.tsx`, S = `${SRC}/components/layout/app-sidebar.tsx`;
  const edit = (path, from, to) => (t) => { if (!t.files[path]?.includes(from)) return null; return { ...t, files: { ...t.files, [path]: t.files[path].replace(from, to) } }; };
  const mutants = [
    ["dock file comes back", (t) => ({ ...t, dockFileExists: true })],
    ["a component imports the dock", (t) => ({ ...t, tree: { ...t.tree, [`${SRC}/components/x.tsx`]: 'import { MobileDock } from "./layout/mobile-dock";' } })],
    ["a dock under another name", (t) => ({ ...t, tree: { ...t.tree, [`${SRC}/components/tabbar.tsx`]: 'export const T = () => <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden" />;' } })],
    ["a dock via inset-x-0", (t) => ({ ...t, tree: { ...t.tree, [`${SRC}/components/tabbar2.tsx`]: 'export const T = () => <nav className="fixed inset-x-0 bottom-0" />;' } })],
    ["bottom padding returns", edit(L, "flex-1 pb-8\">", "flex-1 pb-24 md:pb-8\">")],
    ["drawer removed", edit(L, "<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>", "<div>")],
    ["drawer does not close on navigate", edit(L, "<AppSidebar onNavigate={() => setMobileOpen(false)} />", "<AppSidebar />")],
    ["hamburger loses its label", edit(L, 'aria-label="Open navigation menu"', "")],
    ["drawer loses its accessible title", edit(L, '<SheetTitle className="sr-only">', "<span>")],
    ["drawer no longer shows module nav", edit(S, "return <ModuleSidebar app={scopedApp} onNavigate={onNavigate} />", "return <CentralSidebar onNavigate={onNavigate} />")],
    ["e2e spec loses the dock detector", edit("tests/e2e/mobile-nav/mobile-no-dock.spec.mjs", "full-width fixed bottom bar", "bar")],
    ["CI forgets the spec self-test", edit(".github/workflows/ci.yml", "mobile-no-dock.spec.mjs --self-test", "mobile-no-dock-x.spec.mjs --self-test")],
    ["QA doc lists dock tabs again", edit("docs/module-shell-qa.md", "(wisp mail shortcuts, search results; the mobile dock was removed in W2-P3)", "(wisp mail shortcuts, dock tabs, search results)")],
    ["ADR Q4 forgotten", edit("docs/architecture/ADR-W0-FREEZE.md", "W2-P3 implemented with this default", "pending")],
  ];
  let survived = 0;
  for (const [name, mutate] of mutants) {
    const m = mutate(base);
    if (!m) { console.error(`MUTANT NOT APPLICABLE (fix the self-test): ${name}`); survived++; continue; }
    if (run(m).length === 0) { console.error(`SURVIVED: ${name}`); survived++; }
  }
  console.log(survived ? `SELF-TEST FAILED: ${survived} mutant(s) not caught` : `SELF-TEST OK: ${mutants.length}/${mutants.length} mutants caught`);
  process.exit(survived ? 1 : 0);
}

const problems = run(load());
if (problems.length) { console.error("W2_P3_VALIDATION: FAIL\n - " + problems.join("\n - ")); process.exit(1); }
console.log("W2_P3_VALIDATION: PASS");
console.log(JSON.stringify({ rules: RULES.length }));
