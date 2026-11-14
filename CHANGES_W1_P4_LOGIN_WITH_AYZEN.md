# W1-P4: "Login with AYZEN" on all modules (roadmap req 7)

Roadmap: generalize `startSyloOidcLogin` to `startModuleOidcLogin(moduleId)` with a per-module rollout flag; three flows
(existing AYZEN user, AYZEN signup, explicit link of an existing module account); auto-provision module_account + module_uid
(W1-P1); login UI = module credential form + "Continue with AYZEN" (+ social buttons, W1-P5).

## What was already true

The browser OIDC client was already host-driven (client id from the module host) and the rollout flag already per `app_id`. The
real gap: after the OIDC round trip the callback exchanged a **shared AYZEN cookie** for a session, which W1-P2's
`MODULE_SESSIONS_MODE=strict` refuses on module hosts. So "Login with AYZEN" would have broken exactly when module isolation is on.

## Design

The OIDC **access token is the proof of the AYZEN identity**; no shared cookie is involved.

`POST /api/auth/module/oidc` (host-scoped, behind `moduleGate`), body `{ access_token }` or `{ access_token, link: { identifier, password } }`. Refused unless, in order:
the module's rollout flag is on (`OIDC_NOT_ENABLED`) -> token verifies, RS256 + issuer (`INVALID_TOKEN`) -> **issued to this module's own client** (`CLIENT_MISMATCH`: a sylo token can never open a ryft session) -> has `openid` -> is under 5 minutes old (`TOKEN_TOO_OLD`).
`GET /api/auth/module/options` tells the sign-in screen which buttons to draw.

| Flow | How |
|---|---|
| 1 existing AYZEN user | `oidcSignIn`: linked account -> else the identity's own account (W1-P1 backfill) -> else provision (`source 'lazy'`, new `module_uid`) + link `oidc`. Idempotent, race-safe. |
| 2 AYZEN signup | `startModuleOidcLogin(m, {flow:'signup'})` adds `screen_hint=signup`; `/oidc/authorize` sends the visitor to `/register`, which now returns through `/login` into the pending authorize; then flow 1. |
| 3 explicit link | After the round trip the callback asks for the module account's email+password, checked by `loginWithPassword` (same lockout/timing/ban rules), then `module_account_links` method `explicit`. Refused, never merged: `ALREADY_HAS_MODULE_ACCOUNT` (the identity already owns an account here), `ACCOUNT_ALREADY_LINKED` (that account belongs to another identity). Later sign-ins land in the linked account **as its owning user**; no second account/uid is created. |

Per-module rollout flag: `lib/oidc-rollout-scope.ts` — the eight module client ids may be toggled without the override (admin route and CLI). The legacy credential **cutover gate stays Sylo-only** on purpose.
Also: authorize redirects use `APP_URL` when the issuer is a dedicated host (see the issuer ADR).

## Files

Server: `migrations/127_module_oidc_audit_events.sql` (+ boot mirror; events `oidc_login`, `link`), `lib/module-auth-service.ts` (`oidcSignIn`, `linkAyzenToModuleAccount`), `routes/module-auth.ts`, `lib/oidc-rollout-scope.ts`, `lib/oidc-central-origin.ts`, `routes/oidc-authorize.ts`, `routes/admin-oidc-rollout.ts`, `scripts/src/set-oidc-rollout-flag.ts`, 2 endpoint-registry rows.
Browser: `lib/module-oidc-login.ts` (`startModuleOidcLogin`), `lib/module-auth-api.ts`, `components/module-auth-screen.tsx`, `pages/login.tsx`, `pages/oidc-callback.tsx` (link form; token held in memory only), `pages/register.tsx`, `lib/sylo-oidc-callback.ts` (exchange receives tokens; identity check honors the reported AYZEN id).

## Verification

- DB suite against a real Postgres 16: **38/38** (14 new: provisioning, idempotence, backfilled account reuse, concurrent first sign-in, suspended/banned, link success + later sign-in lands in the linked account, link idempotent, wrong password + lockout, other module's credentials, identity already owns an account, account already linked, 3-way link race, audit has no secrets). **It found a real bug:** link held `FOR UPDATE` on the account while a second connection inserted an audit row referencing it, a self-deadlock; fixed (refusals are acted on after the transaction; lock is `FOR NO KEY UPDATE`).
- `test-oidc-module-login` 12, `test-oidc-central-origin` 6, `validate-w1-p4.mjs` 15 rules + `--self-test` 20/20 mutants caught; W1-P1/P2 validators, W1-P3 conformance (28) and discovery/seed tests still pass.

## Not verified / caveats

- **Not run:** the Express route itself (no installed deps here: guard order and "no cookie fallback" are pinned statically, the service is tested for real), the React components (no build; type/syntax only by review), a browser round trip, CI. The DB suite used a hand-written `pg` shim against real Postgres here; CI uses real `pg`.
- No social buttons (W1-P5); the slot is marked in `module-auth-screen.tsx`.
- Flow 3 cannot merge two accounts: an identity that already has a module account (including a W1-P1 backfilled one) cannot link a second. Needs a product decision (data merge) if wanted.
- Access tokens are not checked against a revocation list (they are short-lived JWTs); freshness window is 5 minutes.
- Rollout order: enable `MODULE_SESSIONS_MODE`, seed clients, then flip one module's flag: `pnpm --filter @workspace/scripts oidc:rollout-flag --app=ryft --enable`; `GET /api/auth/module/options` shows `oidc: true`.
