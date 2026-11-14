# Per-module builds and deploys (W2-P2, req 4)

Each module can ship as its own bundle on its own host. The bundle for module M contains M's pages and the shared (unowned) pages; every other module's pages are replaced by an empty stub, so their code never reaches the browser.

## How ownership is decided
`artifacts/ayzen/build/module-pages.mjs` reads the one place routes are declared (`src/lib/route-config.tsx`): page file -> the route paths that render it -> the module that owns each path (`@ayzen/module-registry` `routePrefixes`, the same table the server guard uses). A page whose routes are all owned belongs to those modules only; a page that serves any unowned route (core, admin, platform) is shared. Ownership then flows along page-to-page imports: a page imported by a shared page is shared, or the importer's build would break. The one such case today is listed in `artifacts/ayzen/build/shared-page-allowlist.json` (`pages/user/project-entities`, a Sylo route imported by two shared pages); the check fails when that list goes stale or a new coupling appears.

## Build
```
VITE_MODULE=sylo pnpm --filter @workspace/ayzen run build:module     # -> artifacts/ayzen/dist/modules/sylo
pnpm --filter @workspace/ayzen run build:modules                      # all eight, one after another
```
`vite.module.config.ts` validates `VITE_MODULE`, stubs the other modules' pages, then inspects the finished chunks, **fails the build** if any excluded page is still inside one, and writes `dist/module-reports/<id>.json` (pages in bundle, pages stubbed, chunk sizes). The central/full build (`vite.config.ts`, `build`) is unchanged and still contains everything.

In a module build, `lib/build-module.ts` makes the router agree with the bundle (another module's URL is the ordinary not-found page) and `getCurrentSubdomainApp()` returns that module on any hostname.

## Deploy (one target per module)
`node scripts/gen-module-deploy.mjs` writes `deploy/modules/<id>/vercel.json` and `deploy/modules/manifest.json` from the registry (CI fails if they are stale). Layout: one repo, one Vercel project per module (`ayzen-<id>`, domain = the module's host), deployed with
```
vercel deploy --prod --local-config deploy/modules/<id>/vercel.json
```
Each project builds only its own bundle and serves a static SPA (SPA rewrite, `frame-ancestors 'self'`, `Referrer-Policy: no-referrer`, immutable asset cache). The API stays on `https://api.ayzen.tech` (`VITE_API_URL`), so sign-in on a static module host uses the token returned in the response body (the module host has no API of its own to set its host-only cookie); the API's module guard (W2-P1) still applies to those calls.

## Central -> module redirects
The client-side flags `VITE_SPLIT_REDIRECTS` / `VITE_SPLIT_REDIRECT_MODULES` are retired. The central host forwards module URLs with the server-side 308 (`SPLIT_REDIRECTS`, `SPLIT_REDIRECT_MODULES`); in-app cross-module links already full-navigate through `moduleUrl()`. A central-SPA user who types a module URL into a client-side `pushState` navigation (not a full load) is no longer forwarded; links inside the app do not do that.

## Cutover and rollback
Nothing changes until a module host is pointed at its own project: the Express app keeps serving the full build on every host. To cut one module over, deploy its project, move that host's DNS to it, watch the API logs (`module_host_guard.would_deny`). To roll back, point the host back at the Express app. Check locally: `pnpm check:module-bundles`.
