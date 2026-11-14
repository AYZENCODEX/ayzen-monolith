# W2-P4 — Public landing per module

- New registry-driven landing (`landing.mjs`): 8 distinct content sets and brand palettes; pure templates reused by build prerender, Express and SPA.
- `pages/modules/landing.tsx` + `main.tsx` gate: signed-out `/` shows the landing with no App import → no auth call before login.
- Module build injects SEO head/body, per-module robots.txt + sitemap.xml; `MODULE_LANDING_ENABLED=1` does the same on the server (default off, kill switch).
- 8 OG PNGs (1200x630) + generator; validator (22 mutants), chromium spec, gate unit test, CI job `module-landings`, docs/module-landings.md.
- Roadmap deviation: one data-driven component instead of 8 `pages/modules/<module>/landing.tsx` files (as the roadmap says "data-driven").
- Unverified: real Lighthouse, real `vite build`, Express end-to-end, CI run. Shards pricing is placeholder.

## Supplied designs (follow-up)
- 7 designs (fyra, ryft, skarn, zynth, warde, verve, wisp) added under `packages/module-registry/landings/`; sylo keeps the generic landing.
- Demo sign-in inside the designs is neutralised (all entries -> `/login`, `/register`); module build now writes landing as `index.html` and SPA as `app.html`; Express serves `/` + allow-listed `/landing-assets/*`.
- Validator now 23 rules / 35 mutants; new chromium spec `designed.spec.mjs` (8 modules x 2 viewports + redirects).
- Not wired: fyra login and wisp login designs. verve sample-data catalogue pages ship under `/landing-assets/verve/`.
