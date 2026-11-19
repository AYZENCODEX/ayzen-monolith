# Module auth v2 — designed login steps on real backend routes

The module login designs (OTP, step-up, captcha, referral, username, profile) are kept exactly as drawn. This adds the
backend they need under `/api/auth/module/v2/*` (host-scoped like `/api/auth/module/*`, 404 while `MODULE_SESSIONS_MODE=off`).

| Route | Purpose |
| --- | --- |
| `GET /captcha` | `{ id, question }` — stateless HMAC blob, 5 min, bound to the module |
| `POST /username/check`, `/mail/check`, `/referral/check` | availability / validity only (a referral answer never reveals whose code it is); `mail` is the claimable `name@ayzen.tech` local part (wisp, verve) |
| `POST /signup/verify` | looks at the emailed code without consuming it, so a design can have a separate "verify email" step before the account is created |
| `POST /signup/start` → `/signup/complete` | emailed 6-digit code proves the mailbox; account + credential (verified) + profile in one transaction |
| `POST /login` → `/login/verify` (`/login/email-code`) | password, then a TOTP or emailed code when required; body `requireCode: true` forces the email code |
| `POST /reset/request` → `/reset/confirm` | code-based reset; revokes sessions |
| `GET/PUT /profile` | the signed-in module account's profile |

## Behaviour and knobs
- Codes: HMAC-hashed at rest (`MODULE_AUTH_HMAC_SECRET`, falls back to the JWT secret), 10 min, single use, 5 wrong tries, 5 codes per address per hour.
- `MODULE_LOGIN_STEP_UP=email` challenges every login with an emailed code; unset, only accounts with an enrolled authenticator are challenged (the Fyra page sends `requireCode`, so it always asks).
- `MODULE_SIGNUP_CAPTCHA_MODULES` (default `wisp,verve`): modules whose sign-up page has the captcha step. Others rely on the per-address/IP limits.
- Usernames: 3-30 of `a-z 0-9 . _`; mail local parts: `a-z 0-9 . _ -`; both unique per module.
- A successful emailed code at login marks the mailbox verified.
- Passwords keep the module policy (min 10). The designs' hint says 6 — the server answer is shown on the form.
- No account enumeration: `signup/start`, `reset/request` answer the same for known and unknown addresses.

## Wiring a design (no design edits)
`packages/module-registry/src/login-adapters.mjs` holds one small `fetch` wrapper per design that translates the central
`/api/auth/*` calls the page was drawn against into the v2 calls. `designedLoginHtml()` injects it. Calls it does not know pass through.
Status:
- **fyra** — adapter (the design already called the central API), design file untouched.
- **wisp** (`landings/wisp/login.html`) and **verve** (`landings/verve/login.html` + `assets/js/pages/login.js` + `assets/css/auth.css`) were demo-only; their scripts now call the v2 routes directly. Markup, CSS, copy and step order are as designed. Changes: demo accounts/codes removed, fonts/links made absolute, password minimum 10, passkey and "connect Google/GitHub" answer "not available yet" instead of faking success, verve's OIDC hands over to the app's `/oidc/callback`.
- Wisp adds a small forgot-password view (the design had a dead link), built from the page's own components.
- Not available for module accounts yet: passkeys, authenticator enrolment (a TOTP secret set on the credential is honoured at login), social connections. Their checkboxes/buttons say so.

## Tests
- `src/lib/module-auth-v2-service.db.test.ts` (18, real Postgres) and the existing 38 service tests.
- `tests/e2e/module-login/login-v2.spec.mts` — chromium + real Postgres for fyra, wisp and verve (sign-up steps, sign-in with code, forgot-password, social buttons never fake a login; asserts no call bypasses the module API). The HTTP layer is a thin stand-in for the Express router (same service calls). Run manually:
  `MODULE_AUTH_TEST_DATABASE_URL=… node --import tsx tests/e2e/module-login/login-v2.spec.mts`
- `node scripts/validate-w3-auth-v2.mjs [--self-test]`.
