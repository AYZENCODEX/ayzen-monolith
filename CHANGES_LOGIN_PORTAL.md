# Sign-in portal redesign

Visual-only rewrite of `/login`. All auth logic in `artifacts/ayzen/src/pages/login.tsx` is unchanged (handlers, OIDC cutover, passkeys, step-up, magic code, account chooser).

- `components/auth/auth-backdrop.tsx`: canvas constellation of the modules with travelling packets and pointer parallax. Pauses when hidden or off-screen, one still frame under `prefers-reduced-motion`, DPR capped at 2, no new dependency.
- `components/auth/portal.tsx` + `portal.css`: small presentational kit (Field, CodeField, Btn, Notice, Divider, Heading), all CSS scoped under `.zp`.
- Fonts (Instrument Serif, Inter, JetBrains Mono) self-hosted under `src/assets/fonts/portal/` with OFL licenses; no Google Fonts request.
- A11y: real labels, `aria-invalid`/`role=alert` errors, `one-time-code` autofill, tab roles, visible focus, 16px inputs on mobile.
- The demo role buttons ("Developer access") are now collapsed in a disclosure. They still call the same handlers; see note below.

Note: those demo handlers should not be reachable in production. Gate them on the server or behind `import.meta.env.DEV` before release.
