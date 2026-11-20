# W3 — Module auth v2

- Migration 129: `module_otps`, `module_profiles` (+ boot mirror in `schema-migrations.ts`), audit events `step_up`, `profile_updated`.
- `module-auth-service.ts`: `loginWithPassword` split into `verifyLoginCredentials` + `finishPasswordLogin`; `signupWithPassword` accepts `verified` and `afterCreate`. Behaviour unchanged (38/38 tests).
- `module-auth-v2-service.ts`, `routes/module-auth-v2.ts` (mounted in `routes/index.ts`); `module-auth.ts` exports its guards.
- Fyra's own login page now talks to the module backend through `login-adapters.mjs` (design file untouched).
- Validator `scripts/validate-w3-auth-v2.mjs` (+ self-test), CI wiring, `docs/module-auth-v2.md`.
- Wisp and Verve login pages added to `landings/` and wired to the v2 routes (design kept; demo logic replaced). Extra routes: `mail/check`, `signup/verify`; profile `extra` (x, telegram, discord, headline) and claimable mail local part; usernames may contain dots.
- `designedLoginHtml` adds the `<base>` for multi-page designs (verve); `validate-w2-p4` accepts the v2 API and checks verve's `login.js`.
- Not done: ryft/skarn/zynth embedded sign-in still redirects to `/login` (no own login design); passkeys, authenticator enrolment and social connections for module accounts.

## Portal designs: ryft, zynth, skarn
- Landings' embedded sign-up (5 steps) / sign-in (3 steps) now use `/api/auth/module/v2/*`; demo accounts, codes, inbox and fake social/OIDC removed.
- `/login` + `/register` redirect into the portal (`landing-designs.mjs` `isPortal`, `portalRedirectHtml`, `designedRegisterHtml`; Express `/register`; Vercel rewrites).
- New profile extras `country`, `workspace`, `workspaceSlug`, `teamSize`; captcha default list adds ryft, zynth.
- Fixed a design bug in skarn's reset screen (OTP binding also swallowed the password field).
- Tests: login-v2 e2e (ryft, zynth, skarn), designed.spec portal checks, W2-P4 portal rule (+11 mutants), DB test.

## Follow-up: authenticator enrolment + skarn workspace uniqueness
- `POST /auth/module/v2/totp/enrol` + `/totp/confirm` (two-step, session required); ryft/zynth/verve toggle opens a setup dialog.
- `POST /auth/module/v2/workspace/check`; slug uniqueness re-checked under an advisory lock in `completeSignup` (no schema change).
- Tests: +2 DB tests (23 v2), e2e covers authenticator enrolment + totp sign-in (ryft); W3 validator +1 rule / +4 mutants.
