# Phase 2 — `api.ayzen.tech` API host

## Findings that shaped the design
- ~91 frontend files build their API base from `import.meta.env.BASE_URL` (always empty), NOT `getApiBase()`. Setting `VITE_API_URL` alone would only move ~30 files. -> runtime shim.
- `customFetch` (api-client-react) and most `fetch` calls do not set `credentials: "include"`, so a cross-origin call would lose the shared `.ayzen.tech` session cookie. -> shim adds it for API-origin requests only.
- CORS regex matched `https://<sub>.ayzen.tech` but NOT the apex `https://ayzen.tech`. -> shared `isFirstPartyOrigin()`.
- The SPA fallback (`index.html`) and the central->module 308 redirects would also run on `api.ayzen.tech`. -> API-host guard.
- `infrastructure/platform/*-registry.json` still pointed at `ayzen.app`.

## Changes
Backend
- `lib/api-hosts.ts` (+test): `API_HOSTS` (default `api.ayzen.tech`), `isApiHost()`, `isFirstPartyOrigin()`.
- `middlewares/security.ts`: CORS uses `isFirstPartyOrigin()` (apex now allowed; lookalikes like `ayzen.tech.evil.com` / `evilayzen.tech` rejected).
- `app.ts`: on an API host, `/` returns `{service:"ayzen-api",...}`, any other non-handled path returns JSON 404; never the SPA, never module redirects.
Frontend
- `lib/api-routing-core.ts` (+test), `lib/api-routing.ts`, `lib/api-routing-boot.ts`: opt-in fetch/EventSource shim, active only when `VITE_API_URL` is an absolute URL. `main.tsx` imports the boot file first.
- `lib/api-base.ts`: docs only.
Registries
- `infrastructure/platform/domain-registry.json`, `component-registry.json`: `ayzen.app` -> `ayzen.tech`.
- `.env.example`: documents `API_HOSTS`, `AYZEN_COOKIE_DOMAIN`, `ALLOWED_ORIGINS`, `VITE_API_URL`.

## Rollout order (important)
1. Replit: add custom domain `api.ayzen.tech` to the SAME deployment; add the DNS record Replit shows; wait for TLS.
2. Secrets: `AYZEN_COOKIE_DOMAIN=.ayzen.tech`, `APP_URL=https://ayzen.tech` (Phase 1), optional `ALLOWED_ORIGINS`.
3. Check: `curl https://api.ayzen.tech/` -> JSON; `curl https://api.ayzen.tech/api/health` (or any public /api route).
4. Only then set `VITE_API_URL=https://api.ayzen.tech` and rebuild the frontend.
5. Log in on `sylo.ayzen.tech`, open DevTools -> Network: calls should go to `api.ayzen.tech` with the cookie.
Rollback: unset `VITE_API_URL`, rebuild. Module hosts keep serving `/api` themselves, so nothing else changes.

## Not in this phase
- Telegram webhook URL (Phase 3), MCP URL (Phase 8), role hosts admin/mod (Phase 7).
- Run `pnpm validate:component-registry` to regenerate/verify the registry (needs workspace install).
