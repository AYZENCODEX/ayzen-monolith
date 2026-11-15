# Module public landings (W2-P4, req 11)

Each of the 8 modules has its own public landing at `/` on its host (hero, features, **Shards** pricing CTA, FAQ, SEO meta, OG image, own brand tokens). `/login` stays the W1 login.

## Where things live
- Content + brand tokens + pure templates: `packages/module-registry/src/landing.mjs` (`@ayzen/module-registry/landing`). Add/edit copy in `LANDINGS`.
- SPA: `artifacts/ayzen/src/pages/modules/landing.tsx` (one data-driven component instead of 8 near-identical files).
- Gate: `src/lib/module-landing-gate.ts` + `src/main.tsx`. Signed-out visit to `/` on a module (build or host) renders the landing **without importing App**, so no provider/auth probe/analytics runs and no request is made before login. Kill switch: `VITE_MODULE_LANDING=0`.
- Module build: `vite.module.config.ts` prerenders head+body into `index.html` and writes `robots.txt`/`sitemap.xml`.
- Server: `MODULE_LANDING_ENABLED` (default on; `0` turns it off) makes a module host serve the injected HTML (+ robots/sitemap) at `/` instead of the 302 to homePath. Off by default.
- OG images: `node scripts/gen-module-og.mjs` (needs playwright; PNGs in `artifacts/ayzen/public/og/` are committed).

## Designed landings (supplied designs)
`packages/module-registry/landings/<id>/` holds the supplied designs for fyra, ryft, skarn, zynth, warde, verve and wisp (sylo's design is the one from `public/landing/sylo`; the generic registry landing is only the fallback). `landing-designs.mjs` (node-only) turns a design into the production document: registry SEO head (title kept if <=70 chars, description, canonical, robots, OG/Twitter, JSON-LD), a signed-in guard (`ayzen_token` -> module homePath), assets under `/landing-assets/<id>/`.
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

## Where it shows
Only on a module host (`<id>.ayzen.tech` or `<ID>_HOSTS`). The central `ayzen.tech` keeps the AYZEN landing (`/landing/`).

## SEO / sharing / AI files (per module host)
`<title>`, description, canonical, robots meta, Open Graph + Twitter card (1200x630 image `/og/<id>.png`), JSON-LD; `robots.txt` (landing + assets + llms.txt allowed, app paths disallowed, sitemap link), `sitemap.xml`, and `llms.txt` (llmstxt.org format, generated from the registry). Served by Express (when landings are on) and written into the module build.

## Central host (ayzen.tech)
`node scripts/gen-central-seo.mjs` writes `public/robots.txt` (allow all, disallow /api/, /oidc/, /auth/, /admin, sitemap link), `public/sitemap.xml` (central URLs only), `public/llms.txt` (AYZEN overview + a link to every module host, generated from the registry) and the SEO head of `/landing/` (canonical, robots, Open Graph, Twitter card, Organization/WebSite JSON-LD). `--check` runs in CI. Re-run it when a module is added to the registry.

## Extended SEO and AI-search content (per module)
One source of copy: `packages/module-registry/src/landing-content.mjs` (category, summary = meta description, features, areas, how it works, use cases, limits, pricing note, 8+ FAQ, related modules, brand). It is grounded in the supplied designs and the app's routes; the validator checks the design and the copy still share the module's anchor terms (e.g. sylo "AES-256-GCM", wisp "Cloudflare Email Routing"), so they cannot drift silently. No prices are stated anywhere (none are defined in the repo); wisp's design says sending uses AYZEN credits and that is the only credit claim.

Per module host: `/` (design + SEO head + SoftwareApplication JSON-LD with featureList), **`/about`** (long-form server-rendered page: what it is, features, in detail, how it works, use cases, limits, pricing note, visible FAQ + FAQPage/BreadcrumbList/WebPage JSON-LD, related modules), `/llms.txt` (short, link-first), **`/llms-full.txt`** (everything as one markdown file), `/robots.txt` (public pages open; AI search/answer crawlers named: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Applebot-Extended, ...; edit `AI_CRAWLERS` in `landing.mjs` to change the policy), `/sitemap.xml` (`/` and `/about`). Central: `gen-central-seo.mjs` also writes `llms-full.txt` with every module in full.

## Module-own login pages and where each host is served (follow-up)

* `landings/<id>/login.html` is a module's OWN sign-in page, shipped exactly as designed (only a runtime prelude is added: OIDC client id, and the API origin when the API is on another host). Today only **fyra** has one that talks to the real `/api/auth` routes. The wisp and verve login designs are mock-ups (fake accounts, "any 6-digit code works") and are NOT shipped as a login; those modules use the SPA `/login`. A login design is rejected by `validate-w2-p4.mjs` unless it calls `/api/auth/login` and is not a demo.
* It is served at `/login` by (1) the Express app, (2) a per-module build (`login/index.html` + a `/login` rewrite in `deploy/modules/<id>/vercel.json`) and (3) the central build (`dist/public/m/<id>/login/`).
* **One Vercel project with many module domains (the central bundle):** `vite.config.ts` also emits every module's landing, login, about and SEO files under `/m/<id>/`, and `main.tsx` (`designHandoff`) sends a signed-out visit to `/` or `/login` on a module host there, instead of the generic React landing. For full SEO (robots/sitemap/llms at the host root, landing at `/` without a redirect) give each module its own Vercel project from `deploy/modules/<id>/vercel.json` (see docs/module-builds.md).
