/**
 * getApiBase() — returns the base URL for all API calls.
 *
 * Production (Phase 2): set VITE_API_URL=https://api.ayzen.tech at build time.
 * lib/api-routing.ts then moves EVERY `/api/...` fetch/EventSource (including
 * the ~90 files that build their base from BASE_URL instead of calling this
 * function) onto that origin and sends the shared `.ayzen.tech` cookie.
 *
 * Development / Replit:   VITE_API_URL empty -> relative "/api" (same origin).
 * Rollback:               unset VITE_API_URL and rebuild.
 *
 * Frontend code uses:  `${getApiBase()}/auth/login`  (no "/api" prefix needed when using this helper)
 * Or keep existing:    `${getApiBase()}/api/auth/login` — both work because VITE_API_URL never has a trailing slash.
 *
 * When VITE_API_URL is set the frontend calls the API cross-origin, so the API
 * server must allow the page origin in CORS (first-party *.ayzen.tech origins
 * are allowed automatically — see lib/api-hosts.ts) and cookies must be scoped
 * with AYZEN_COOKIE_DOMAIN=.ayzen.tech.
 */
export function getApiBase(): string {
  const viteUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (viteUrl && viteUrl.trim() !== "") {
    return viteUrl.replace(/\/$/, "");
  }
  // Fall back to relative path (same origin, Vite proxies /api → localhost:apiPort)
  const basePath = (import.meta.env.BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return basePath;
}
