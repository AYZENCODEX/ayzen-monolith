# Sign-in portal redesign

Visual-only rewrite of `/login`. All auth logic in `artifacts/ayzen/src/pages/login.tsx` is unchanged (handlers, OIDC cutover, passkeys, step-up, magic code, account chooser).

- `components/auth/auth-backdrop.tsx`: canvas constellation of the modules with travelling packets and pointer parallax. Pauses when hidden or off-screen, one still frame under `prefers-reduced-motion`, DPR capped at 2, no new dependency.
- `components/auth/portal.tsx` + `portal.css`: small presentational kit (Field, CodeField, Btn, Notice, Divider, Heading), all CSS scoped under `.zp`.
- Fonts (Instrument Serif, Inter, JetBrains Mono) self-hosted under `src/assets/fonts/portal/` with OFL licenses; no Google Fonts request.
- A11y: real labels, `aria-invalid`/`role=alert` errors, `one-time-code` autofill, tab roles, visible focus, 16px inputs on mobile.
- The demo role buttons ("Developer access") are now collapsed in a disclosure. They still call the same handlers; see note below.

Note: those demo handlers should not be reachable in production. Gate them on the server or behind `import.meta.env.DEV` before release.

## Sign-up and sign-in flows (login-flows branch)

**Sign up** (5 screens, one decision each): email + password → referral code + captcha (then we email a code) → 6-digit code → username, full name, AYZEN mail address (defaults to the username, `@ayzen.tech`) → optional profile with a Skip button. The account is created at the identity step; the session is only handed to the app after the profile step.

**Sign in**: email + password → verify screen. Email code is always required; authenticator (2FA) and passkey appear when the account has them. Session only exists after every check passes.

Server (additive):
- `POST /auth/signup/verify-email` confirms the code and returns a single-use `emailProof` (hashed, 10 min). `/auth/register` accepts `emailProof` (or the old `emailOtp`).
- `GET /auth/username-available/:username`; register now validates the username (3-30 `[a-z0-9_]`, reserved names blocked) and returns 409 when taken.
- `users.display_name` (migration 125 + boot migration), accepted by register and `PUT /profile`.
- `LOGIN_STEP_UP_POLICY` (default `always`): every password login opens the step-up chain. Set `anomalous` to restore the old "new IP only" behaviour. Seeded demo accounts are exempt.
- Tests: `pnpm --filter @workspace/api-server run test:auth-signup`.

Removed: the "Email code" (magic link) tab and the old client-side-only sign-in OTP screen.

### Security findings
1. The old sign-in OTP screen was cosmetic: `/auth/login` already returned the token and set the session cookie before the code was entered. The step-up chain fixes that.
2. Seeded demo accounts (`demoadmin@ayzen.io`, password `Demo@1234`, etc.) are created on every boot, including production. Anyone can sign in as them. Disable seeding in production.
3. The signup form used to collect a referral code but never sent it to `/auth/register`; it is now sent.
