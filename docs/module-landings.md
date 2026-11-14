# Module public landings (W2-P4, req 11)

Each of the 8 modules has its own public landing at `/` on its host (hero, features, **Shards** pricing CTA, FAQ, SEO meta, OG image, own brand tokens). `/login` stays the W1 login.

## Where things live
- Content + brand tokens + pure templates: `packages/module-registry/src/landing.mjs` (`@ayzen/module-registry/landing`). Add/edit copy in `LANDINGS`.
- SPA: `artifacts/ayzen/src/pages/modules/landing.tsx` (one data-driven component instead of 8 near-identical files).
- Gate: `src/lib/module-landing-gate.ts` + `src/main.tsx`. Signed-out visit to `/` on a module (build or host) renders the landing **without importing App**, so no provider/auth probe/analytics runs and no request is made before login. Kill switch: `VITE_MODULE_LANDING=0`.
- Module build: `vite.module.config.ts` prerenders head+body into `index.html` and writes `robots.txt`/`sitemap.xml`.
- Server: `MODULE_LANDING_ENABLED=1` makes a module host serve the injected HTML (+ robots/sitemap) at `/` instead of the 302 to homePath. Off by default.
- OG images: `node scripts/gen-module-og.mjs` (needs playwright; PNGs in `artifacts/ayzen/public/og/` are committed).

## Designed landings (supplied designs)
`packages/module-registry/landings/<id>/` holds the supplied designs for fyra, ryft, skarn, zynth, warde, verve and wisp (sylo has none and uses the generic registry landing). `landing-designs.mjs` (node-only) turns a design into the production document: registry SEO head (title kept if <=70 chars, description, canonical, robots, OG/Twitter, JSON-LD), a signed-in guard (`ayzen_token` -> module homePath), assets under `/landing-assets/<id>/`.
- **Demo sign-in is never served as a login.** ryft, skarn, zynth and warde embed an in-memory demo auth (mock accounts, on-screen demo codes). Every entry is rewritten to the real SPA routes (`/login`, `/register`), `data-login`/`data-go` clicks and `#login`/`#signup`/`#/in/...` deep links are redirected there. The demo code stays in the file as dead code; remove it from the source designs when convenient.
- Build: `closeBundle` writes the landing as `index.html` and moves the SPA shell to `app.html` (deploy rewrite -> `/app.html`). Server (`MODULE_LANDING_ENABLED=1`): `/` is answered before `express.static`; only allow-listed design files are served under `/landing-assets/`. The bundled server finds the folder through `MODULE_LANDINGS_DIR` (set in `app.ts`).
- Third parties: Google Fonts and three.js (cdnjs r128) are loaded by the designs (wisp self-hosts its fonts). No auth/API request is made on load (tested).
- Not applied: `fyra-login.html` and `wisp/login` are sign-in page designs; `/login` is the W1 SPA login, so they were not wired (restyle `/login` per module separately).
- verve ships its sample-data catalogue pages under `/landing-assets/verve/` (the landing's cards link to them). They contain SAMPLE data; hide them or swap `data.js` for the real API before launch.

## Checks
`node scripts/validate-w2-p4.mjs [--self-test]` (SEO rules mirroring Lighthouse, zero-network, distinct brands, wiring), `tests/e2e/module-landing/landing.spec.mjs` (generic landing) and `designed.spec.mjs` (all 8 production landings: no auth/API request on load, no 404 assets, sign-in entries -> /login or /register, token/hash redirects), `scripts/src/test-module-landing-gate.ts`.

## Not measured
- Real Lighthouse score (>= 90 SEO target) was not run; the validator checks the same audits statically. Run Lighthouse on a deployed module host to confirm.
- "Shards" has no pricing definition in the repo; the section is a placeholder CTA ("start free, heavier usage paid in Shards") — owner must supply real tiers.
- Set `<ID>_HOSTS` consistently: canonical/OG URLs use the registry `defaultHost` in builds and the request host on the server.
