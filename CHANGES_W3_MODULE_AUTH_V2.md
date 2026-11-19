# W3 — Module auth v2

- Migration 129: `module_otps`, `module_profiles` (+ boot mirror in `schema-migrations.ts`), audit events `step_up`, `profile_updated`.
- `module-auth-service.ts`: `loginWithPassword` split into `verifyLoginCredentials` + `finishPasswordLogin`; `signupWithPassword` accepts `verified` and `afterCreate`. Behaviour unchanged (38/38 tests).
- `module-auth-v2-service.ts`, `routes/module-auth-v2.ts` (mounted in `routes/index.ts`); `module-auth.ts` exports its guards.
- Fyra's own login page now talks to the module backend through `login-adapters.mjs` (design file untouched).
- Validator `scripts/validate-w3-auth-v2.mjs` (+ self-test), CI wiring, `docs/module-auth-v2.md`.
- Wisp and Verve login pages added to `landings/` and wired to the v2 routes (design kept; demo logic replaced). Extra routes: `mail/check`, `signup/verify`; profile `extra` (x, telegram, discord, headline) and claimable mail local part; usernames may contain dots.
- `designedLoginHtml` adds the `<base>` for multi-page designs (verve); `validate-w2-p4` accepts the v2 API and checks verve's `login.js`.
- Not done: ryft/skarn/zynth embedded sign-in still redirects to `/login` (no own login design); passkeys, authenticator enrolment and social connections for module accounts.
