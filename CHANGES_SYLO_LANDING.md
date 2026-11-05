# Sylo landing page

Static page at `/landing/sylo/` (`artifacts/ayzen/public/landing/sylo/index.html`), self-contained: inline CSS/JS, fonts self-hosted in `./fonts/` (Big Shoulders Display, Newsreader, IBM Plex Mono; OFL licenses included). No build step, no external requests.

Design: graphite + brass + bone. One memorable element: the vault dial (spins and seals on load, then turns with scroll). Drawer wall, a five-step workflow animation (add, seal, group, unlock, hand over; autoplays when visible, pausable, steps are clickable tabs, readout panel scrambles from one state to the next), animated entity graph (canvas), three unlock doors, interactive emergency-access slip. Respects `prefers-reduced-motion`; responsive down to 390px.

Copy is limited to what Vault does today: passkey, then Vault PIN + Vault 2FA, then email code + Vault PIN; separate Entity-view PIN; AES-256-GCM at rest; emergency-access contacts with cancelable pending requests; activity log, 30-day trash, encrypted snapshot, import/export, compliance report. Records in the page are labelled samples.

Not wired to `sylo.ayzen.tech`: in production the server redirects `/` on a module host straight to the module's `homePath` before the SPA loads (`artifacts/api-server/src/app.ts`), so showing this page to logged-out visitors there needs a server-side decision (auth-aware redirect). Until then it is reachable at `/landing/sylo/`.
