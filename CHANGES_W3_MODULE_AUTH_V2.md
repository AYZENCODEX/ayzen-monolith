# W3 — Module auth v2

- Migration 129: `module_otps`, `module_profiles` (+ boot mirror in `schema-migrations.ts`), audit events `step_up`, `profile_updated`.
- `module-auth-service.ts`: `loginWithPassword` split into `verifyLoginCredentials` + `finishPasswordLogin`; `signupWithPassword` accepts `verified` and `afterCreate`. Behaviour unchanged (38/38 tests).
- `module-auth-v2-service.ts`, `routes/module-auth-v2.ts` (mounted in `routes/index.ts`); `module-auth.ts` exports its guards.
- Fyra's own login page now talks to the module backend through `login-adapters.mjs` (design file untouched).
- Validator `scripts/validate-w3-auth-v2.mjs` (+ self-test), CI wiring, `docs/module-auth-v2.md`.
- Not done: Wisp/Verve login pages (not in `landings/`), ryft/skarn/zynth embedded sign-in still redirects to `/login`.
