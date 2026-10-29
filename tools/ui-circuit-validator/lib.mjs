import fs from "node:fs";
import path from "node:path";

const LAZY_IMPORT = /const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']@\/pages\/([^"']+)["']\s*\)\s*\)/g;
// App.tsx's auth pages are imported eagerly (users hit these before bundle
// splits matter), not via lazy() -- `import Login from "@/pages/login";`.
// Same target shape as LAZY_IMPORT's map (component name -> pages/*.tsx), so
// the two can be merged with no caller-side special-casing.
const EAGER_IMPORT = /^import\s+(\w+)\s+from\s+["']@\/pages\/([^"']+)["']/gm;
const ROUTE_ARRAY_ENTRY = /\{\s*path:\s*["']([^"']+)["']\s*,\s*component:\s*(\w+)\s*(?:,\s*adminOnly:\s*(true|false))?\s*(?:,\s*allowedRoles:\s*\[([^\]]*)\])?\s*,?\s*\}/g;
const JSX_ROUTE = /<Route\s+path=["']([^"']+)["']\s+component=\{(\w+)\}/g;
const FETCH_CALL = /fetch\(\s*`([^`]*)`|fetch\(\s*(["'])((?:(?!\2).)*)\2/g;
const METHOD_IN_OPTIONS = /method:\s*["'](\w+)["']/;
const LOCAL_IMPORT = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+["'](@\/hooks\/[\w-]+|\.\.?\/[\w./-]+)["']/g;

/** const X = lazy(() => import("@/pages/...")) -> { X: "pages/....tsx" } */
export function extractLazyImports(source) {
  const map = new Map();
  let match;
  LAZY_IMPORT.lastIndex = 0;
  while ((match = LAZY_IMPORT.exec(source)) !== null) {
    map.set(match[1], `pages/${match[2]}.tsx`);
  }
  return map;
}

/** import X from "@/pages/..." -> { X: "pages/....tsx" } (App.tsx's eager auth-page imports). */
export function extractEagerImports(source) {
  const map = new Map();
  let match;
  EAGER_IMPORT.lastIndex = 0;
  while ((match = EAGER_IMPORT.exec(source)) !== null) {
    map.set(match[1], `pages/${match[2]}.tsx`);
  }
  return map;
}

/** { path: "...", component: X, adminOnly: true|false, allowedRoles: [...] } object-literal entries inside a `export const NAME: RouteConfig[] = [ ... ]` array. */
export function extractRouteArrayEntries(source) {
  const entries = [];
  let match;
  ROUTE_ARRAY_ENTRY.lastIndex = 0;
  while ((match = ROUTE_ARRAY_ENTRY.exec(source)) !== null) {
    const [, routePath, component, adminOnly, allowedRolesRaw] = match;
    entries.push({
      path: routePath,
      component,
      adminOnly: adminOnly === "true",
      allowedRoles: allowedRolesRaw ? allowedRolesRaw.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean) : [],
    });
  }
  return entries;
}

/** <Route path="..." component={X} /> literal JSX route declarations (App.tsx's public routes). */
export function extractJsxRoutes(source) {
  const entries = [];
  let match;
  JSX_ROUTE.lastIndex = 0;
  while ((match = JSX_ROUTE.exec(source)) !== null) {
    entries.push({ path: match[1], component: match[2], adminOnly: false, allowedRoles: [] });
  }
  return entries;
}

/**
 * Finds the matching closing ")" for the "fetch(" call starting at
 * openParenIndex (source[openParenIndex] === "("), tracking string/template
 * literals so a stray paren inside a string doesn't throw off the depth
 * count. Returns the index just past the matching ")", or source.length if
 * unterminated.
 */
function matchCallEnd(source, openParenIndex) {
  let depth = 0;
  let inString = null; // one of ' " ` or null
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** Every fetch(...) call referencing /api/..., with its inferred HTTP method and normalized path (${dynamic} segments -> :param). Method is read only from within that specific call's own argument list, not a fixed-length lookahead, so it can't bleed into the next fetch() call in the file. */
export function extractApiCalls(source) {
  const calls = [];
  let match;
  FETCH_CALL.lastIndex = 0;
  while ((match = FETCH_CALL.exec(source)) !== null) {
    const raw = match[1] ?? match[3];
    if (!raw || !raw.includes("/api/")) continue;
    const apiIndex = raw.indexOf("/api/");
    const rawPath = raw.slice(apiIndex).split("?")[0];
    // A ${...} appended directly after other path text (not its own /segment)
    // is almost always a query-string suffix built without a literal "?"
    // character (e.g. `/orders${q}` where `q` is `"?status=open"`) --
    // truncate there rather than treating it as a path segment, which would
    // corrupt path matching against the registry (see lib.test.mjs).
    const midSegmentTemplate = rawPath.match(/[^/]\$\{[^}]*\}/);
    const truncatedPath = midSegmentTemplate ? rawPath.slice(0, midSegmentTemplate.index + 1) : rawPath;
    const normalizedPath = truncatedPath.replace(/\$\{[^}]+\}/g, ":param").replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/api";
    const openParenIndex = source.indexOf("(", match.index);
    const callEnd = matchCallEnd(source, openParenIndex);
    const callText = source.slice(openParenIndex, callEnd);
    const methodMatch = METHOD_IN_OPTIONS.exec(callText);
    calls.push({ method: (methodMatch?.[1] ?? "GET").toUpperCase(), path: normalizedPath, raw: rawPath });
  }
  return calls;
}

/** Locally-imported names from @/hooks/* or relative specifiers, mapped to their resolved file (best-effort; @/hooks/* resolved against hooksDir). */
export function extractLocalHookImports(source) {
  const specifiers = new Set();
  let match;
  LOCAL_IMPORT.lastIndex = 0;
  while ((match = LOCAL_IMPORT.exec(source)) !== null) {
    if (match[3].startsWith("@/hooks/")) specifiers.add(match[3].replace("@/hooks/", ""));
  }
  return [...specifiers];
}

/** Does a normalized frontend call path match a registry path? Both may use :param-style segments; segment counts must match, and a :param segment matches anything. */
export function pathsMatch(frontendPath, registryPath) {
  const a = frontendPath.replace(/^\/api/, "").split("/").filter(Boolean);
  const b = registryPath.replace(/^\/api/, "").split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || seg === ":param" || b[i].startsWith(":"));
}

export function resolveApiCall(call, registryEntries) {
  return registryEntries.find((entry) => entry.method === call.method && pathsMatch(call.path, entry.path)) ?? null;
}

export function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
