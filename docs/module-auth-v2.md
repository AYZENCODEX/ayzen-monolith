# Module auth v2 — designed login steps on real backend routes

The module login designs (OTP, step-up, captcha, referral, username, profile) are kept exactly as drawn. This adds the
backend they need under `/api/auth/module/v2/*` (host-scoped like `/api/auth/module/*`, 404 while `MODULE_SESSIONS_MODE=off`).

| Route | Purpose |
| --- | --- |
| `GET /captcha` | `{ id, question }` — stateless HMAC blob, 5 min, bound to the module |
| `POST /username/check`, `/referral/check` | availability / validity only (a referral answer never reveals whose code it is) |
| `POST /signup/start` → `/signup/complete` | emailed 6-digit code proves the mailbox; account + credential (verified) + profile in one transaction |
| `POST /login` → `/login/verify` (`/login/email-code`) | password, then a TOTP or emailed code when required; body `requireCode: true` forces the email code |
| `POST /reset/request` → `/reset/confirm` | code-based reset; revokes sessions |
| `GET/PUT /profile` | the signed-in module account's profile |

## Behaviour and knobs
- Codes: HMAC-hashed at rest (`MODULE_AUTH_HMAC_SECRET`, falls back to the JWT secret), 10 min, single use, 5 wrong tries, 5 codes per address per hour.
- `MODULE_LOGIN_STEP_UP=email` challenges every login with an emailed code; unset, only accounts with an enrolled authenticator are challenged (the Fyra page sends `requireCode`, so it always asks).
- `MODULE_SIGNUP_CAPTCHA_MODULES` (default `wisp`): modules whose sign-up page has the captcha step. Others rely on the per-address/IP limits.
- A successful emailed code at login marks the mailbox verified.
- Passwords keep the module policy (min 10). The designs' hint says 6 — the server answer is shown on the form.
- No account enumeration: `signup/start`, `reset/request` answer the same for known and unknown addresses.

## Wiring a design (no design edits)
`packages/module-registry/src/login-adapters.mjs` holds one small `fetch` wrapper per design that translates the central
`/api/auth/*` calls the page was drawn against into the v2 calls. `designedLoginHtml()` injects it. Calls it does not know pass through.
Status: **fyra** wired and browser-tested. wisp and verve login designs are not in the repo's `landings/` yet; add `login.html` and an adapter.

## Tests
- `src/lib/module-auth-v2-service.db.test.ts` (16, real Postgres) and the existing 38 service tests.
- `tests/e2e/module-login/fyra-v2.spec.mts` — chromium + real Postgres (sign-up, sign-in with code, forgot-password; asserts no call bypasses the module API). Run manually:
  `MODULE_AUTH_TEST_DATABASE_URL=… node --import tsx tests/e2e/module-login/fyra-v2.spec.mts`
- `node scripts/validate-w3-auth-v2.mjs [--self-test]`.
