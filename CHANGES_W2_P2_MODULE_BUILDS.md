# CHANGES — W2-P2: per-module build + deploy (req 4)

Goal (roadmap): Vite per-module entry (`VITE_MODULE`), only that module's pages in the bundle, separate deploy target per module, retire `VITE_SPLIT_REDIRECTS`. Done = bundle report: the Sylo bundle has 0 Verve/Skarn pages.

## What was added
| Piece | Where |
|---|---|
| Ownership (route -> module, propagated along page imports) | `artifacts/ayzen/build/module-pages.mjs`, `build/shared-page-allowlist.json` |
| Install-free import-graph walker | `artifacts/ayzen/build/import-graph.mjs` |
| Module build config (stubs other modules' pages, fails the build on a leak, writes the bundle report) | `artifacts/ayzen/vite.module.config.ts`, `build/build-all-modules.mjs`, scripts `build:module`, `build:modules` |
| Runtime agreement | `src/lib/build-module.ts`, `src/lib/subdomain-app.ts` (module build = that module), `src/App.tsx` (only mounts routes that belong in the build) |
| Deploy targets (generated) | `scripts/gen-module-deploy.mjs` -> `deploy/modules/<id>/vercel.json`, `manifest.json` |
| Proof | `scripts/check-module-bundles.mjs` (+`--self-test`, 21 mutants), `scripts/src/test-module-build.ts` (4), CI job `module-bundles` |
| Docs | `docs/module-builds.md` |

## Result (static proof, per module)
| module | pages in bundle | pages stubbed |
|---|---|---|
| sylo | 126 | 63 |
| ryft | 84 | 99 |
| fyra | 109 | 74 |
| verve | 94 | 89 |
| skarn | 91 | 92 |
| warde | 84 | 99 |
| wisp | 85 | 98 |
| zynth | 83 | 100 |
Of 164 routed pages, 61 are shared (core/admin/platform + one propagated), the rest are owned. The Sylo bundle has 0 Verve and 0 Skarn pages; no module bundle reaches another module's page except the single audited allow-list entry.

## Decisions and limits (read these)
1. **Only pages are separated.** Shared code (layout, hooks, components) is in every bundle, and 61 pages are shared (all admin pages, `/users`, `/notifications`, ...) because the registry owns only about half of the routes. "0 Verve/Skarn pages" is true; "the Sylo bundle contains only Sylo code" is not. More separation needs more route ownership in the registry (same prerequisite as the W2-P1 `strict` mode).
2. **Stubs, not deletion.** Other modules' pages stay in `route-config.tsx` (the central build needs them) and are swapped for an empty component at resolve time; the router also does not mount their routes, so the URL is the normal not-found page.
3. **`VITE_SPLIT_REDIRECTS` retired in the SPA.** The server-side 308 (`SPLIT_REDIRECTS`) stays and is the only central -> module redirect. Consequence: a client-side (`pushState`) navigation on the central host to a module path is no longer forwarded; in-app cross-module links already full-navigate.
4. **Static module hosts use token-body sign-in.** A static host has no API of its own to set the host-only `__Host-<module>_sid` cookie; the API on `api.ayzen.tech` answers with the token (existing cross-origin path). Cookie-mode on a module host needs a same-origin `/api` proxy, which is not part of this change.
5. **Deploy target = Vercel, one project per module, generated configs.** No existing deploy config for the SPA was in the repo (Docker + Express serve the full build), so nothing is replaced; the Express app keeps serving everything until a host is moved.
6. Fixed on the way: the check found `project-entities` (a Sylo page) imported by shared pages; ownership now propagates along imports instead of breaking the other modules' builds.

## Verified / not verified
Verified: the install-free import-graph proof (every module, every pair) + 21/21 mutants caught; deploy configs generated and checked; 4 unit tests; earlier suites (OIDC login 12, conformance 28, clerk client 7, validators) still green.
**Not verified:** a real `vite build` (vite and the SPA dependencies cannot be installed here), the real chunk-level report, the React app in a browser, a real Vercel deploy, CI. The CI job runs the real build for Sylo as an advisory step; make it blocking after its first green run.
