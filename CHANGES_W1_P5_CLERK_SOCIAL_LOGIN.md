# CHANGES — W1-P5: Clerk social login (req 8)

One Clerk application (user pool) **per module**; Google / Facebook / GitHub sign-in ends in an ordinary module session. Off by default
(`MODULE_CLERK_ENABLED` + that module's `CLERK_<M>_*` env). Read `docs/identity-boundaries.md` first: it says which identity provider answers what.

## What was added
| Area | Files |
|---|---|
| DB | `migrations/128_module_external_identities.sql` (+ boot mirror in `lib/schema-migrations.ts`): `module_external_identities`, audit events `clerk_login`/`clerk_user_created`/`clerk_user_deleted` |
| Verify | `lib/clerk-config.ts` (per-module env, topology check), `lib/clerk-verify.ts` (RS256 session token vs the module's own JWKS), `lib/svix-verify.ts` |
| Service | `lib/module-clerk-service.ts`: `clerkSignIn`, `clerkUserCreated`, `clerkUserDeleted` |
| API | `POST /api/auth/module/clerk`, `GET /api/auth/module/options` now also returns `social`, `POST /api/webhooks/clerk/:module` (raw body carve-out in `app.ts`) |
| Registry | `clerkApp` set for all 8 modules; endpoint-registry rows |
| SPA | `lib/module-clerk.ts`, `pages/clerk-callback.tsx` (`/clerk/callback`), social buttons in `module-auth-screen.tsx`, `exchangeModuleClerkSession` |
| Checks | `scripts/validate-w1-p5.mjs` (+`--self-test`, 31 mutants), `lib/clerk.test.ts`, `lib/module-clerk-service.db.test.ts`, `scripts/src/test-clerk-module-client.ts`, CI wiring |

## Decisions and deviations from the roadmap text
1. **8 pools, not 9.** The roadmap says "8 apps (+1 AYZEN)" but also "only AYZEN OIDC is shared". AYZEN accounts stay in the first-party OIDC provider; no Clerk app for AYZEN. ADR A3 remains "pending (Q2)".
2. **`module_external_identities` instead of `module_credentials.external_id`.** `module_credentials.password_hash` is NOT NULL with an argon2id CHECK; social-only accounts have no password.
3. **No linking by email.** A verified email equal to an existing password account of the same module is refused with `EMAIL_ACCOUNT_EXISTS` (409). Explicit "link my password account to this social login" is a follow-up.
4. **No `@clerk/*` npm dependency.** The browser loads Clerk JS from the Frontend API host decoded from the module's publishable key (no network/lockfile in this environment). Swapping to `@clerk/clerk-react` later only touches `lib/module-clerk.ts`.
5. After the exchange the browser signs out of Clerk; the module session is the only one kept.

## Also fixed (found on the way)
* The SPA's module password login/signup posted `identifier` while the server reads `email`, so module password login from the UI would have returned INVALID_IDENTIFIER. The client now sends `email`.
* `linkAyzenToModuleAccount` returned `{ ok: true, ..., ...login }` (TS2783, harmless at runtime); reordered.
* `validate-w1-p2.mjs` (10 routes, events from migration 128) and `validate-w1-p4.mjs` (options shape incl. `social`) updated.

## Rollout (per module)
Create the Clerk app + enable providers + webhook `https://api.ayzen.tech/api/webhooks/clerk/<module>` (user.created, user.deleted); set `CLERK_<M>_ISSUER|JWKS_URL|WEBHOOK_SECRET` on the API, `VITE_CLERK_<M>_PUBLISHABLE_KEY` in the module build; set `MODULE_CLERK_ENABLED=1`; confirm `social: true` in `/auth/module/options` and no `clerk.topology.invalid` in the boot log. Kill switch: unset `MODULE_CLERK_ENABLED` (route answers 404, buttons disappear; existing module sessions keep working).

## Verified here / not verified
Verified: 13 unit tests (token + Svix + config), 13 DB tests on real Postgres 16 (migration idempotent, isolation, race, delete), 7 client tests, validators with mutation self-tests, types of the new server files.
**Not verified:** a real Clerk instance (no keys/network: token claim names, `authenticateWithRedirect` options, script URL), the Express layer end to end (express not installable here), the React UI, CI.
