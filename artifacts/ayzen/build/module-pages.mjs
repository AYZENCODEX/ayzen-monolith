/**
 * build/module-pages.mjs — W2-P2: which page files belong to which module. Pure and install-free (the registry is passed in),
 * shared by vite.module.config.ts (what to leave out of a module build) and scripts/check-module-bundles.mjs (CI proof).
 *
 * Ownership comes from the one place routes are declared (src/lib/route-config.tsx):
 *   page file -> the route paths that render it -> the module that owns each path (registry routePrefixes).
 *   - a page whose routes are ALL owned by modules -> belongs to exactly that set of modules, and is left out of every other
 *     module's build (a shared page such as ModuleSettings simply belongs to every module that owns one of its routes);
 *   - a page that serves any route no module owns (core, admin, platform) -> shared: in every build.
 */
export const PAGE_IMPORT = /const\s+([A-Za-z0-9_]+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']@\/(pages\/[^"']+)["']\s*\)\s*\)/g;
export const ROUTE_ENTRY = /\{\s*path:\s*["']([^"']+)["']\s*,\s*component:\s*([A-Za-z0-9_]+)/g;

/** @returns {{ pages: Map<string,{ owners:Set<string>, shared:boolean, routes:string[] }>, unresolved:string[] }} keyed by "pages/x/y" (no extension) */
export function analyzeRouteConfig(routeConfigSource, registry) {
  const componentFile = new Map();
  for (const m of routeConfigSource.matchAll(PAGE_IMPORT)) componentFile.set(m[1], m[2]);
  const pages = new Map();
  const unresolved = [];
  for (const m of routeConfigSource.matchAll(ROUTE_ENTRY)) {
    const [, path, comp] = m;
    const file = componentFile.get(comp);
    if (!file) { unresolved.push(`${path} -> ${comp}`); continue; }
    const entry = pages.get(file) ?? { owners: new Set(), shared: false, routes: [] };
    const owner = registry.getModuleIdForPath(path);
    if (owner) entry.owners.add(owner); else entry.shared = true;
    entry.routes.push(path);
    pages.set(file, entry);
  }
  // Pages imported but never routed (dead pages) are not owned by anyone: shared (kept; dead-page cleanup is not this phase).
  for (const file of componentFile.values()) if (!pages.has(file)) pages.set(file, { owners: new Set(), shared: true, routes: [] });
  return { pages, unresolved };
}

/** Page files (no extension) that must NOT be part of `module`'s build. */
export function excludedPagesFor(analysis, module) {
  return [...analysis.pages].filter(([, e]) => !e.shared && !e.owners.has(module)).map(([f]) => f).sort();
}
export function includedPagesFor(analysis, module) {
  return [...analysis.pages].filter(([, e]) => e.shared || e.owners.has(module)).map(([f]) => f).sort();
}

/**
 * Ownership must survive page-to-page imports: a page that a shared page (or another module's page) imports cannot be
 * dropped from the importer's builds, or that import would break. So owners flow along static AND dynamic imports from
 * importer to imported until nothing changes: imported pages get the union of their importers' owners, and become shared
 * as soon as one importer is shared. `importsOf(absFile)` and `toAbs(relNoExt)` are passed in (see build/import-graph.mjs).
 */
export function propagateOwnership(analysis, importsOf, toAbs) {
  const absToRel = new Map();
  for (const rel of analysis.pages.keys()) { const a = toAbs(rel); if (a) absToRel.set(a, rel); }
  let changed = true, rounds = 0;
  while (changed && rounds++ < 50) {
    changed = false;
    for (const [rel, e] of analysis.pages) {
      const abs = toAbs(rel);
      if (!abs) continue;
      for (const target of importsOf(abs)) {
        const trel = absToRel.get(target);
        if (!trel || trel === rel) continue;
        const t = analysis.pages.get(trel);
        if (e.shared && !t.shared) { t.shared = true; changed = true; }
        for (const o of e.owners) if (!t.owners.has(o)) { t.owners.add(o); changed = true; }
      }
    }
  }
  return analysis;
}
