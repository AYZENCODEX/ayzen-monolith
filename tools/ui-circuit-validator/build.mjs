#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractLazyImports, extractEagerImports, extractRouteArrayEntries, extractJsxRoutes,
  extractApiCalls, extractLocalHookImports, resolveApiCall, readIfExists,
} from "./lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../");
const frontendRoot = path.join(root, "artifacts/ayzen/src");
const routeConfigPath = path.join(frontendRoot, "lib/route-config.tsx");
const appTsxPath = path.join(frontendRoot, "App.tsx");
const pagesDir = path.join(frontendRoot, "pages");
const hooksDir = path.join(frontendRoot, "hooks");

/**
 * Phase 05 — UI-to-Backend Circuit.
 *
 * The actual frontend app lives at artifacts/ayzen/src (not apps/<name>/ as
 * the roadmap's illustrative path suggests -- apps/* in this repo is
 * api-gateway/worker/telegram-gateway, all backend). The generated registry
 * is written to artifacts/ayzen/frontend-registry.json, colocated with the
 * app it describes, which is the same convention every other phase in this
 * roadmap uses (component-registry.json next to component-registry code,
 * etc). See this phase's CHANGES doc for the reasoning.
 *
 * Builds a route -> page -> API-call circuit by:
 *  1. Parsing route-config.tsx's ADMIN_ROUTES/USER_ROUTES arrays and
 *     App.tsx's literal <Route path=.. component={..}> JSX declarations
 *     (the public routes) -- both resolved to a page file via each file's
 *     own `const X = lazy(() => import("@/pages/..."))` declarations.
 *  2. Diffing every *.tsx under pages/ against the set of files actually
 *     reached by a route -> DEAD_PAGE findings.
 *  3. For each routed page, statically scanning the page file plus one
 *     level of its @/hooks/* imports for fetch(...) calls hitting /api/*,
 *     normalizing dynamic ${...} segments to :param, and resolving each
 *     call against Phase 04's reports/lineage/lineage.json (itself sourced
 *     from ENDPOINT_REGISTRY) -> ORPHAN_API_CALL findings for calls that
 *     resolve to no known backend endpoint.
 *  4. A routed page with zero resolved or unresolved API calls at all is
 *     flagged MOCK_OR_STATIC_PAGE -- heuristic, not a certainty: it could
 *     genuinely be static content, or it could be calling the backend
 *     through a pattern this scanner doesn't recognize (e.g. a generated
 *     api-client-react hook two import-hops away). See the CHANGES doc.
 */
function loadLineageEntries() {
  const lineage = JSON.parse(fs.readFileSync(path.join(root, "reports/lineage/lineage.json"), "utf8"));
  return lineage.entries.map((e) => ({ method: e.method, path: e.path }));
}

function collectRoutes() {
  const routeConfigSource = fs.readFileSync(routeConfigPath, "utf8");
  const appSource = fs.readFileSync(appTsxPath, "utf8");

  // Merge lazy() page imports (route-config.tsx and App.tsx) with App.tsx's
  // eager `import Login from "@/pages/login"` auth-page imports -- same
  // component -> pages/*.tsx map shape, so a plain merge resolves both
  // without any caller-side special-casing. See lib.mjs's extractEagerImports.
  const lazyImports = new Map([
    ...extractLazyImports(routeConfigSource),
    ...extractLazyImports(appSource),
    ...extractEagerImports(appSource),
  ]);

  const adminSection = routeConfigSource.slice(
    routeConfigSource.indexOf("export const ADMIN_ROUTES"),
    routeConfigSource.indexOf("export const USER_ROUTES"),
  );
  const userSection = routeConfigSource.slice(
    routeConfigSource.indexOf("export const USER_ROUTES"),
    routeConfigSource.indexOf("export const PAGE_LIST") > -1 ? routeConfigSource.indexOf("export const PAGE_LIST") : undefined,
  );

  const routes = [
    ...extractRouteArrayEntries(adminSection).map((r) => ({ ...r, source: "ADMIN_ROUTES" })),
    ...extractRouteArrayEntries(userSection).map((r) => ({ ...r, source: "USER_ROUTES" })),
    ...extractJsxRoutes(appSource).map((r) => ({ ...r, source: "App.tsx (public)" })),
  ];

  return routes.map((route) => ({ ...route, pageFile: lazyImports.get(route.component) ?? null }));
}

function scanApiCallsForPage(pageFile) {
  const pageSource = readIfExists(path.join(frontendRoot, pageFile));
  if (!pageSource) return { calls: [], readable: false };
  const calls = [...extractApiCalls(pageSource)];
  for (const hookSpecifier of extractLocalHookImports(pageSource)) {
    const hookSource = readIfExists(path.join(hooksDir, `${hookSpecifier}.ts`)) ?? readIfExists(path.join(hooksDir, `${hookSpecifier}.tsx`));
    if (hookSource) calls.push(...extractApiCalls(hookSource));
  }
  return { calls, readable: true };
}

function allPageFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) files.push(`pages/${path.relative(pagesDir, full)}`);
    }
  };
  walk(pagesDir);
  return files;
}

function build() {
  const registryEntries = loadLineageEntries();
  const routes = collectRoutes();
  const reachedPageFiles = new Set(routes.map((r) => r.pageFile).filter(Boolean));

  const entries = routes.map((route) => {
    if (!route.pageFile) {
      return { ...route, resolution: { status: "unresolved-page", reason: `No lazy import found for component "${route.component}"` } };
    }
    const { calls, readable } = scanApiCallsForPage(route.pageFile);
    if (!readable) {
      return { ...route, resolution: { status: "unresolved-page", reason: `Page file not found on disk: ${route.pageFile}` } };
    }
    const resolvedCalls = calls.map((call) => ({ ...call, backend: resolveApiCall(call, registryEntries) }));
    const classification = resolvedCalls.length === 0 ? "MOCK_OR_STATIC_PAGE"
      : resolvedCalls.some((c) => !c.backend) ? "HAS_ORPHAN_CALLS"
        : "OK";
    return { ...route, resolution: { status: "resolved", apiCalls: resolvedCalls, classification } };
  });

  const allPages = allPageFiles();
  const deadPages = allPages.filter((file) => !reachedPageFiles.has(file));

  const findings = [];
  for (const entry of entries) {
    if (entry.resolution.status === "unresolved-page") {
      findings.push({ severity: "critical", code: "ROUTE_PAGE_UNRESOLVED", path: entry.path, component: entry.component, reason: entry.resolution.reason });
      continue;
    }
    if (entry.resolution.classification === "MOCK_OR_STATIC_PAGE") {
      findings.push({ severity: "warning", code: "MOCK_OR_STATIC_PAGE", path: entry.path, pageFile: entry.pageFile });
    }
    for (const call of entry.resolution.apiCalls ?? []) {
      if (!call.backend) findings.push({ severity: "critical", code: "ORPHAN_API_CALL", path: entry.path, pageFile: entry.pageFile, apiCall: `${call.method} ${call.raw}` });
    }
  }
  for (const deadPage of deadPages) {
    findings.push({ severity: "warning", code: "DEAD_PAGE", pageFile: deadPage });
  }

  const output = {
    schemaVersion: 1,
    registryId: "frontend-registry",
    generatedAt: new Date().toISOString().slice(0, 10),
    generatedBy: "tools/ui-circuit-validator/build.mjs",
    schema: "schemas/ui-circuit/frontend-route-entry.v1.json",
    sourceRegistries: [
      "artifacts/ayzen/src/lib/route-config.tsx (ADMIN_ROUTES, USER_ROUTES)",
      "artifacts/ayzen/src/App.tsx (public <Route> declarations)",
      "artifacts/ayzen/src/pages/**/*.tsx (static regex scan, not full AST)",
      "artifacts/ayzen/src/hooks/*.ts (one import-hop only)",
      "reports/lineage/lineage.json (Phase 04 -- backend endpoint resolution)",
    ],
    completeness: {
      totalRoutes: entries.length,
      resolvedToPage: entries.filter((e) => e.resolution.status === "resolved").length,
      totalPageFiles: allPages.length,
      deadPages: deadPages.length,
      routesWithNoApiCalls: entries.filter((e) => e.resolution.classification === "MOCK_OR_STATIC_PAGE").length,
      routesWithOrphanCalls: entries.filter((e) => e.resolution.classification === "HAS_ORPHAN_CALLS").length,
      routesOk: entries.filter((e) => e.resolution.classification === "OK").length,
    },
    findings,
    routes: entries,
    deadPages,
  };

  const outputPath = path.join(root, "artifacts/ayzen/frontend-registry.json");
  if (process.argv.includes("--check")) {
    const committed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (JSON.stringify(committed.routes) !== JSON.stringify(output.routes) || JSON.stringify(committed.deadPages) !== JSON.stringify(output.deadPages)) {
      console.error("Frontend registry is stale. Run: node tools/ui-circuit-validator/build.mjs");
      process.exit(1);
    }
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    output: "artifacts/ayzen/frontend-registry.json",
    completeness: output.completeness,
    findingCount: findings.length,
    status: findings.some((f) => f.severity === "critical") ? "BLOCKED" : "READY",
  }, null, 2));

  return output;
}

build();
