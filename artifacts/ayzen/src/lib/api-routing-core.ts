/**
 * lib/api-routing-core.ts
 *
 * Pure helpers (no import.meta, no window) behind lib/api-routing.ts so they
 * can be unit-tested with plain node.
 */

/**
 * Returns the URL to actually request. Relative `/api/...` paths (optionally
 * prefixed by the Vite base path) and absolute same-origin `/api/...` URLs are
 * moved onto `apiOrigin`; everything else is returned untouched.
 */
export function rewriteApiUrl(url: string, apiOrigin: string, basePath: string, pageOrigin: string): string {
  const base = basePath.replace(/\/+$/, "");
  const isApiPath = (p: string) => p === "/api" || p.startsWith("/api/") || p.startsWith("/api?");
  if (url.startsWith("/") && !url.startsWith("//")) {
    if (isApiPath(url)) return apiOrigin + url;
    if (base && url.startsWith(base) && isApiPath(url.slice(base.length))) return apiOrigin + url.slice(base.length);
    return url;
  }
  if (pageOrigin && url.startsWith(pageOrigin + "/")) {
    const rest = url.slice(pageOrigin.length);
    if (isApiPath(rest)) return apiOrigin + rest;
    if (base && rest.startsWith(base) && isApiPath(rest.slice(base.length))) return apiOrigin + rest.slice(base.length);
  }
  return url;
}

/** True when `url` (already rewritten) points at the API origin. */
export function isApiOriginUrl(url: string, apiOrigin: string): boolean {
  return url === apiOrigin || url.startsWith(apiOrigin + "/") || url.startsWith(apiOrigin + "?");
}
