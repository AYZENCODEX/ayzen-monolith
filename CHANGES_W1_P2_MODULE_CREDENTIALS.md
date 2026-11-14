# W1-P2: per-module credentials + per-module sessions (req 7)

Roadmap: `AYZEN Monolith: Audit + Full Roadmap` (2026-11-04), Wave 1, Identity track. **Migration number: 126.** Builds on W1-P1 (migration 125, `module_accounts`).

A visitor can now sign up and log in **inside one module** (Sylo, Ryft, Fyra, Verve, Skarn, Warde, Wisp, Zynth) with credentials that exist only in that module, and gets a session that works **only on that module's host**. An existing AYZEN user keeps working through "Continue with AYZEN". The whole feature is behind `MODULE_SESSIONS_MODE` and is **off by default**: until it is turned on, nothing about existing logins, cookies or tokens changes. Rollout and rollback: `docs/operations/module-sessions-rollout.md`.

## Model (ADR A2 + A4)
- A module account (`module_accounts`, W1-P1) is always owned by a `users` row, because every data table keys on `users.id`.
- **Direct module signup** creates a *backing* `users` row (non-deliverable `…@module-accounts.invalid` email, **empty** central password hash, so it can never sign in to the central app) + module account + credential + a `backing` link.
- **Continue with AYZEN**: an existing user with a valid shared session gets a module account provisioned (`source='lazy'`, link `legacy_continue`) and a module session. Their session is for their real `users` row, so their existing data is visible.

## What changed
- **`migrations/126_module_credentials_sessions.sql`** (mirrored statement-for-statement into `schema-migrations.ts`; idempotent, additive only; mirror-vs-file schema parity was checked with `pg_dump`):
  - `module_credentials` (argon2id hash enforced by CHECK, email normalised to `lower(trim())`, unique per module, failed-attempt/lock columns, MFA columns), `module_account_links` (`backing | legacy_continue | oidc | explicit`), `module_password_resets` (hash only, single use), `module_auth_events` (append-only audit).
  - `user_sessions` gains `module` + `module_account_id`; **NULL = a central session, exactly as before**.
  - Composite foreign keys `(module_account_id, module) → module_accounts(id, module)` on all four child tables, so the database itself rejects a credential/link/session whose module disagrees with its account.
- **`lib/module-session-policy.ts`**: pure rules: modes, cookie naming, cookie selection, and `decideTokenModuleAccess` (the isolation rule). **`lib/module-request-context.ts`**: AsyncLocalStorage carrying "which module is this request acting for" (first-party Origin, else Host). **`lib/module-password.ts`**: argon2id via Node's built-in `crypto.argon2` (no native dependency). **`lib/module-auth-service.ts`**: signup / login / continue / logout / reset / session validation over an injected DB.
- **JWT**: optional `mod` + `mac` (module, module-account id) claims; malformed or lone claims invalidate the token.
- **`getUserFromToken`** (the existing auth choke point) enforces: token module == request module, and a live `user_sessions` row bound to that module/account/user. A denial returns `null` and never falls through to the OIDC/Supabase/legacy paths. `getUserIdSync` refuses module tokens.
- **Routes** (`routes/module-auth.ts`, host-scoped, 404 unless the feature is on): `POST /auth/module/signup | login | logout | continue | password-reset/request | password-reset/confirm`, `GET /auth/module/me`. The module comes from the host, **never** from the request body.
- **Cookie**: `__Host-<module>_sid` (host-only, Secure, Path=/, no Domain); `<module>_sid` outside production.
- **Closing escalation paths** found while auditing every token consumer (each has a validator check): `/auth/refresh` keeps a module session a module session (it would otherwise have minted a *shared* session); `/auth/sessions*`, `/auth/session-exchange` and `requireSessionAuth` (API keys, workspaces) refuse module sessions; `/oidc/authorize` no longer treats a module session as a central login (it would have let module A mint a code for module B's client); `/auth/logout` of a module session ends only that session.

## Decisions for the owner
- **A2 and A4 are still PENDING sign-off** (`docs/architecture/ADR-W0-FREEZE.md`). This implements the recommended defaults. Nothing is on until you set `MODULE_SESSIONS_MODE`.
- **Backing users are real `users` rows** (the price of "every table keys on `users.id`"). They will appear in admin user lists and counts. They are recognisable by username `m_<module>_…` and the `…@module-accounts.invalid` email. Filtering them from admin views is not done here.
- **No email verification at signup.** `identifier_verified_at` is set only when a password reset is completed (proof of mailbox). Consequence: someone can register with another person's email in a module; the real owner recovers it with a reset, which also revokes the squatter's sessions.
- **Grace period is a date, not "14 days".** Set `MODULE_SESSIONS_LEGACY_UNTIL` (ISO date) when you enter `dual`; an unparseable value means "already over", never "forever".
- **In `strict` mode, Continue with AYZEN stops working** on module hosts (shared sessions are refused there by design). Users sign in through the AYZEN OIDC flow (W1-P4).

## Known gaps (explicitly not in this phase)
- **No UI.** There is no module login/signup form, no `/reset-password` page (the reset email links to `https://<module-host>/reset-password?token=…`) and no "Continue with AYZEN" button. Those are W1-P4 / W1-P5. The API is complete and tested.
- **A module session is still a full session for its user on the module host.** The path guard that limits a module host to its own routes is **W2-P1**. Until then a Continue session can call any `/api` route its user could (as the shared cookie already can on that host). The identity-sensitive routes listed above are already closed.
- **The shared cookie is not retired.** Central login still sets `ayzen_session` on `.ayzen.tech`; `dual`/`strict` only control whether module hosts accept it. Retiring it is W2-P1 (ADR A4).
- **MFA**: the columns exist (roadmap asked for "mfa fields") but there is no enrolment or challenge flow.
- **Cross-host API calls**: the host-only cookie cannot reach `api.ayzen.tech`, so a module SPA calling the API host uses the token from the response body as a Bearer; it is bound to its module by the request's first-party `Origin`. A non-browser caller with no `Origin` on an API host gets 401 for module tokens (by design: module tokens are not API keys).
- Reset-request timing differs slightly between known and unknown emails (a few queries; the mail send is not awaited). The response body is identical.
- Rate limiting reuses the existing per-IP `authLimiter`/`otpLimiter`; per-account lockout is 5 failures / 15 min (`MODULE_LOGIN_MAX_FAILURES`, `MODULE_LOGIN_LOCK_MINUTES`).

## Verification
- `node scripts/validate-w1-p2.mjs`: registry ↔ migration ↔ boot mirror ↔ drizzle ↔ service agree, **and** the isolation wiring is still in place (decision before fall-through, refresh/sessions/session-exchange/oidc-authorize/requireSessionAuth guards, middleware order in `app.ts`, host-only cookie, endpoint registry rows). Mutation-checked: breaking each guard makes it fail.
- `pnpm --filter @workspace/api-server test:module-auth`: 24 pure tests (policy incl. the **8×8 token-vs-host matrix** in `dual` and `strict`, request context, argon2id, claims parsing).
- `MODULE_AUTH_TEST_DATABASE_URL=… pnpm --filter @workspace/api-server test:module-auth-db`: 23 tests on real Postgres 16 (**8×8 login matrix** and **8×8 session matrix**, atomic lockout under 20 concurrent guesses, 8 racing signups → one wins and no orphan users, single-use reset under 6 concurrent submissions, cascade deletes, audit contains no secrets). Wired into CI as the `module-auth` job.
- **Not run in this environment** (dependencies could not be installed): the Express/HTTP layer (`routes/module-auth.ts`, the edited `routes/auth.ts`), `getUserFromToken` itself, the full `api-server` typecheck/build and the frontend. Typechecking the new modules in isolation showed no errors; the rest was checked statically by the validator and by reading. The DB tests here ran against Postgres 16 through a minimal local stand-in for `pg`; CI uses the real driver. **Run the CI job and a manual smoke test (below) before enabling.**

## Manual smoke test (staging, `MODULE_SESSIONS_MODE=dual`)
1. `POST https://sylo.ayzen.tech/api/auth/module/signup` `{email,password}` → 201, `Set-Cookie: __Host-sylo_sid`.
2. Same token against `https://ryft.ayzen.tech/api/auth/me` → 401. Against `sylo.ayzen.tech` → 200.
3. `POST …/auth/module/logout`, then reuse the old token → 401.
4. Logged in centrally, `POST …/auth/module/continue` on a module host → 200 `created:true`, then again → `created:false`, same `moduleUid`.
5. `MODULE_SESSIONS_MODE=off`, redeploy → every module token is 401 and `/auth/module/*` is 404.

## Rollback
- **Kill switch**: `MODULE_SESSIONS_MODE=off`. Every module session stops working at once and the routes 404; shared sessions are untouched.
- The schema is additive. To remove: `DROP TABLE module_auth_events, module_password_resets, module_account_links, module_credentials;` then `ALTER TABLE user_sessions DROP CONSTRAINT user_sessions_module_account_fk, DROP CONSTRAINT user_sessions_module_chk, DROP COLUMN module_account_id, DROP COLUMN module;` (sessions with a module should be deleted first). Backing `users` rows stay; remove them by username pattern if wanted.
