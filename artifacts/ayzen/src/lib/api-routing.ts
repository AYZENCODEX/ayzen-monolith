/**
 * lib/api-routing.ts
 *
 * Phase 2 — move every browser API call onto the API host.
 *
 * Why a runtime shim instead of editing call sites: ~90 files build their API
 * base from `import.meta.env.BASE_URL` (always "") instead of getApiBase(), so
 * setting VITE_API_URL alone would only redirect the ~30 files that use
 * getApiBase(). This shim covers all of them at once:
 *
 *  - fetch("/api/...")            -> fetch("https://api.ayzen.tech/api/...")
 *  - new EventSource("/api/...")  -> same, with withCredentials
 *  - every request to the API origin gets credentials: "include" so the shared
 *    `.ayzen.tech` session cookie (lib/session-cookie.ts) travels cross-origin.
 *
 * Opt-in: does nothing unless VITE_API_URL is an absolute URL (see getApiBase).
 * Unset VITE_API_URL and rebuild = instant rollback to same-origin /api.
 * Module hosts still serve /api themselves, so any call this shim cannot reach
 * (img src, window.open, <a href>) keeps working same-origin.
 */
import { getApiBase } from "./api-base";
import { isApiOriginUrl, rewriteApiUrl } from "./api-routing-core";

let installed = false;

export function installApiRouting(): void {
  if (installed || typeof window === "undefined") return;
  const apiBase = getApiBase();
  if (!/^https?:\/\//i.test(apiBase)) return; // same-origin mode
  installed = true;

  const apiOrigin = new URL(apiBase).origin;
  const basePath = (import.meta.env.BASE_URL as string | undefined) ?? "";
  const pageOrigin = window.location.origin;
  const rewrite = (u: string) => rewriteApiUrl(u, apiOrigin, basePath, pageOrigin);
  const withCreds = (init?: RequestInit): RequestInit => ({ ...init, credentials: init?.credentials === "omit" ? "omit" : "include" });

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string") {
      const url = rewrite(input);
      return nativeFetch(url, isApiOriginUrl(url, apiOrigin) ? withCreds(init) : init);
    }
    if (input instanceof URL) {
      const url = rewrite(input.href);
      return nativeFetch(url, isApiOriginUrl(url, apiOrigin) ? withCreds(init) : init);
    }
    const url = rewrite(input.url);
    if (isApiOriginUrl(url, apiOrigin)) {
      const req = url === input.url ? input : new Request(url, input);
      return nativeFetch(req, withCreds(init));
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    class ApiEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        const target = rewrite(String(url));
        super(target, isApiOriginUrl(target, apiOrigin) ? { ...init, withCredentials: true } : init);
      }
    }
    window.EventSource = ApiEventSource as typeof window.EventSource;
  }
}
