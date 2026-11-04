# Home landing (AYZEN, Morpho-derived)

Adds a static public landing page at `/landing/` (`artifacts/ayzen/public/landing/`).
Vite copies `public/` into `dist/public`, and `app.ts` serves it with `express.static` before the SPA fallback, so no route or build change is needed.

- Layout, animation and WebGL shader pipeline come from the Morpho template. Copy is AYZEN's (8 modules, per-module login and ID, Connector, Developer API, MCP).
- The butterfly videos are replaced by generated media: `media/ayzen-core.*` (crystal core with 8 orbiting module nodes) and `media/ayzen-constellation.*` (8-module constellation with data pulses).
- Pricing plans and prices (Starter 0, Pro 12, Team 39) are placeholders. Replace them in `assets/landing.js` before launch.
- Stats such as "100+ MCP tools" follow the roadmap, not the current code (16 tools today).
- Not wired into the SPA: `/` still renders `pages/landing.tsx`. To switch, redirect unauthenticated `/` to `/landing/` or port the page into a route.
- Not verified: live render of the mp4 media in Safari and Firefox. Check with `pnpm --filter @workspace/ayzen build` and open `/landing/`.
