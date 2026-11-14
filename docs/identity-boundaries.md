# Identity boundaries: Clerk, AYZEN OIDC and module accounts (W1-P5)

AYZEN runs **two identity providers on purpose**. This page is the rule book for which one answers which question.
Mixing them up is the main risk of req 8, so every change that touches sign-in should be checked against it.

## The three kinds of identity

| Identity | Lives in | Proves | Used for |
|---|---|---|---|
| **AYZEN identity** | First-party OIDC provider (`/oidc/*`, issuer `https://id.ayzen.tech` once activated) and `users` | "this is AYZEN user N" | "Continue with AYZEN" on any module (W1-P4); AYZEN console |
| **Module Clerk identity** | One Clerk application **per module** (8 pools) | "this is Clerk user `user_…` of *Sylo's* pool (Google/Facebook/GitHub)" | Social sign-in to that one module (W1-P5) |
| **Module account** | `module_accounts` (+ `module_credentials`, `module_account_links`, `module_external_identities`) | "this is account `SYL-000123` in Sylo" | Everything inside the module; the only thing a module session is issued for |

A Clerk user and an AYZEN user are never the same row and are never merged automatically.

## Hard rules

1. **Pools are separate.** A Clerk application belongs to exactly one module. There is no Clerk SSO across modules and no shared Clerk
   application. The same Clerk id string in two modules is two unrelated accounts (the identity key is `(module, 'clerk', external_id)`).
2. **Verification is per module.** `/auth/module/clerk` verifies the token only against the request module's own issuer, JWKS and authorized
   parties (`CLERK_<MODULE>_*`). The module is taken from the request host, never from the body. A token from another module's pool fails
   (`bad_issuer`/`bad_signature`). Webhooks are verified with that module's own Svix secret on `/api/webhooks/clerk/<module>`.
3. **The module session is the only session.** After the exchange the browser signs out of Clerk. Authorization everywhere uses the module
   token (`mod`/`mac` claims, `__Host-<module>_sid`), never a Clerk token.
4. **Only AYZEN OIDC is shared.** It is the single cross-module identity. AYZEN accounts are **not** stored in Clerk (the audit text mentions a 9th
   "AYZEN" Clerk app; we do not create one, because the first-party provider already is that system and a second copy would be a third source of truth).
5. **No automatic linking by email.** A first social sign-in whose *verified* email equals an existing password account of the same module is refused
   (`EMAIL_ACCOUNT_EXISTS`, 409) instead of being attached. Silent merging is an account-takeover path if either side's email is not what it seems.
   Explicit linking (sign in with the password, then attach) is a follow-up, not part of this change.
6. **Deletion in Clerk closes, it does not erase.** `user.deleted` removes the identity row, sets the module account to `closed` and revokes its sessions.
   Module data stays; a deleted Clerk id that signs up again becomes a new account.
7. **Social-only accounts have no password.** They have a backing user and a `'backing'` link like any module account but no `module_credentials` row.

## Why `module_external_identities` and not `module_credentials.external_id`

`module_credentials.password_hash` is `NOT NULL` with an argon2id check, because a credential row means "has a password". A social-only account has none, so the
roadmap's `external_id` column would either force fake password hashes or weaken that constraint. A separate table keeps the password invariant intact, allows
several providers later, and has a composite FK `(module_account_id, module)` so an identity can never point at another module's account.

## Failure modes this design accepts

* Two IdPs means two outages: if Clerk is down, social sign-in answers 503 and password/AYZEN sign-in still work. The JWKS cache keeps serving stale keys for a failed refresh.
* Vendor lock-in and 8 Clerk subscriptions (ADR A3). Moving off Clerk later only needs the `module_external_identities` rows.
* Clerk session tokens are short-lived; we use one only once, so a stolen old token is useless after its `exp`.

## Operations checklist (per module)

1. Create the Clerk application; enable Google, Facebook and GitHub; set allowed origins to the module host.
2. Add a webhook endpoint `https://api.ayzen.tech/api/webhooks/clerk/<module>` for `user.created` and `user.deleted`; copy its signing secret.
3. Set `CLERK_<M>_ISSUER`, `CLERK_<M>_JWKS_URL`, `CLERK_<M>_WEBHOOK_SECRET` on the API and `VITE_CLERK_<M>_PUBLISHABLE_KEY` in the module build.
4. Set `MODULE_CLERK_ENABLED=1`. Check boot logs for `clerk.topology.invalid` (must be absent) and that `GET /api/auth/module/options` on the module host reports `social: true`.

## Server-side module guard (W2-P1)

Keeping modules apart is also enforced on the server, not just by the SPA. One switch, `MODULE_HOST_GUARD_MODE`:

| Mode | Effect |
|---|---|
| `off` (default) | nothing changes |
| `report` | logs `module_host_guard.would_deny`, refuses nothing: run this first and read the logs |
| `owned` | a request acting for module M gets a plain 404 on any path owned by another module (registry `routePrefixes`); unowned shared APIs stay reachable. Recommended steady state |
| `strict` | as `owned`, and unowned paths are 404 unless allow-listed (`/auth /oidc /.well-known /health /connector`) or in `MODULE_HOST_GUARD_SHARED_PREFIXES`. Do not use until the registry's route ownership is complete (about half of the API surface is unowned today) |

`owned` and `strict` also switch on a per-module CORS allow-list (a production first-party origin must be a registered host: module, role, central, API, MCP, OIDC issuer, or `MODULE_CORS_EXTRA_HOSTS`; `ALLOWED_ORIGINS` still wins) and, on module hosts, `Content-Security-Policy: frame-ancestors 'self'` (+ `MODULE_FRAME_ANCESTORS_EXTRA`) and `Referrer-Policy: no-referrer`.

"Acting for module M" is the first-party Origin when the browser sent one, else the Host. Requests with no module context (central app, curl, workers) are not touched, so this is defence in depth for browser traffic; authentication and authorization stay with the existing middleware. Kill switch: set the mode back to `off`. CI check: `scripts/check-module-isolation.mjs`.
