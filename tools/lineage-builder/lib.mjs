import fs from "node:fs";
import path from "node:path";

const ROUTE_CALL = /router\.(get|post|put|patch|delete)\(\s*(["'`])((?:(?!\2).)*)\2/g;
const IMPORT_LOCAL = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\w+))\s+from\s+["'](\.[^"']+)["']/g;

/**
 * Extracts every `router.<method>("path", ...)` call site from one route
 * file's source, in declaration order, with its start offset (used to
 * bound the handler body span for the module/function scan below).
 */
export function extractRouteCalls(source) {
  const calls = [];
  let match;
  ROUTE_CALL.lastIndex = 0;
  while ((match = ROUTE_CALL.exec(source)) !== null) {
    calls.push({
      method: match[1].toUpperCase(),
      routePath: match[3],
      start: match.index,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return calls;
}

/**
 * Extracts every locally-imported name (from a relative import specifier --
 * i.e. this file's own lib/service dependencies, not express/drizzle/etc.)
 * mapped to the module it came from.
 */
export function extractLocalImports(source) {
  const imports = new Map(); // name -> specifier
  let match;
  IMPORT_LOCAL.lastIndex = 0;
  while ((match = IMPORT_LOCAL.exec(source)) !== null) {
    const [, named, defaultName, specifier] = match;
    if (defaultName) imports.set(defaultName, specifier);
    if (named) {
      for (const rawName of named.split(",")) {
        const cleaned = rawName.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim();
        if (cleaned) imports.set(cleaned, specifier);
      }
    }
  }
  return imports;
}

/**
 * For one route call, returns the imported local functions referenced
 * (as bare `name(` calls) between this call's start and the next call's
 * start (or end of file for the last one) -- an approximation of "what
 * this handler calls into", not a real call graph: it will also catch
 * names referenced in a sibling helper defined between two routes, and
 * will miss a function reached only indirectly (passed as a callback,
 * re-exported, etc).
 */
function functionsInSpan(source, start, end, localImports) {
  const span = source.slice(start, end);
  const found = new Set();
  for (const name of localImports.keys()) {
    const callPattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
    if (callPattern.test(span)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Builds a lookup: "METHOD path" -> { file, line, module, functions }
 * across every route file under routesDir, given each file's mount prefix
 * ("/api" for files combined through routes/index.ts, "" for the handful
 * mounted standalone in app.ts -- see build.mjs for how prefixes are
 * determined).
 */
export function buildRouteIndex({ routesDir, prefixByFile }) {
  const index = new Map();
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".ts"));
  for (const file of files) {
    const fullFilePath = path.join(routesDir, file);
    const source = fs.readFileSync(fullFilePath, "utf8");
    const calls = extractRouteCalls(source);
    if (calls.length === 0) continue;
    const localImports = extractLocalImports(source);
    const prefix = prefixByFile[file] ?? "/api";
    calls.forEach((call, i) => {
      const end = i + 1 < calls.length ? calls[i + 1].start : source.length;
      const functions = functionsInSpan(source, call.start, end, localImports);
      const fullPath = `${prefix}${call.routePath}`.replace(/\/{2,}/g, "/") || "/";
      const key = `${call.method} ${fullPath}`;
      // First declaration wins (Express matches routers in mount order; a
      // later duplicate registration in the same file would never actually
      // receive the request).
      if (!index.has(key)) {
        index.set(key, { file: `routes/${file}`, line: call.line, module: `routes/${file}`, functions });
      }
    });
  }
  return index;
}

export function resolveEndpoint(endpoint, routeIndex) {
  const key = `${endpoint.method} ${endpoint.path}`;
  const hit = routeIndex.get(key);
  const critical = endpoint.auth !== "public";
  if (hit) {
    return {
      method: endpoint.method, path: endpoint.path, owner: endpoint.owner, auth: endpoint.auth, critical,
      resolution: { status: "resolved", ...hit },
    };
  }
  return {
    method: endpoint.method, path: endpoint.path, owner: endpoint.owner, auth: endpoint.auth, critical,
    resolution: {
      status: "unresolved",
      reason: "No static router.<method>(path) declaration matched this method+path across artifacts/api-server/src/routes/*.ts (likely a SEED_ENTRIES entry -- a structurally-undetectable route per generate-endpoint-registry.mjs's own header -- or genuine drift).",
    },
  };
}
