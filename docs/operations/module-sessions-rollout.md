# Module sessions: rollout, monitoring, rollback (W1-P2)

Feature: per-module credentials and sessions (`CHANGES_W1_P2_MODULE_CREDENTIALS.md`). One switch controls it.

## The switch: `MODULE_SESSIONS_MODE`

| Mode | Module routes (`/auth/module/*`) | Module tokens | Shared (`ayzen_session`) sessions on a module host |
|------|----------------------------------|---------------|----------------------------------------------------|
| `off` (default, **kill switch**) | 404 | rejected everywhere | accepted, exactly as before |
| `dual` | live | valid only on their own module host | accepted until `MODULE_SESSIONS_LEGACY_UNTIL` (no date = no deadline) |
| `strict` | live | valid only on their own module host | refused on module hosts |

An unrecognised value is treated as `off`. An unparseable `MODULE_SESSIONS_LEGACY_UNTIL` is treated as "grace already over" (never "forever"). The central app and API hosts never refuse a shared session in any mode.

## Rollout
1. **Deploy with `off`.** Migration 126 applies at boot (idempotent). Verify: `SELECT to_regclass('module_credentials')`. Run the CI `module-auth` job first.
2. **Staging: `dual`.** Run the smoke test in the CHANGES doc.
3. **Production: `dual` + `MODULE_SESSIONS_LEGACY_UNTIL=<date ~14 days out>`.** Existing users keep working; each first visit can "Continue with AYZEN".
4. **After the deadline: `strict`.** Check the numbers below first.

## What to watch
```sql
-- adoption: module sessions vs shared sessions in the last day
SELECT module, count(*) FROM user_sessions WHERE created_at > NOW() - INTERVAL '1 day' GROUP BY module;
-- login failures by reason (bad_password / locked / unknown / status / user_status)
SELECT module, detail->>'reason' AS reason, count(*) FROM module_auth_events
 WHERE event='login' AND outcome='failure' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY 1,2 ORDER BY 3 DESC;
-- accounts currently locked out
SELECT module, count(*) FROM module_credentials WHERE locked_until > NOW() GROUP BY module;
```
A sudden rise in `unknown` from one IP is credential stuffing; the per-IP limiter (`RATE_LIMIT_AUTH_MAX`) and the per-account lockout are the controls. Logs: `[module-sessions] token refused` (debug) names the denial code.

## Rollback
- **Fast**: set `MODULE_SESSIONS_MODE=off` and redeploy/restart. Module sessions die immediately; nothing central changes.
- **Schema** (rarely needed; additive): see the CHANGES doc. Delete `user_sessions` rows with a non-null `module` first.

## Support
- *User locked out*: they wait `MODULE_LOGIN_LOCK_MINUTES` or reset their password (reset clears the lock and revokes all their sessions in that module).
- *Suspend a module account*: `UPDATE module_accounts SET status='suspended' WHERE module_uid='SYL-000123'` — takes effect on the next request (every request re-checks the account), and new logins fail.
- *Backing users*: usernames `m_<module>_…`, emails `…@module-accounts.invalid`; they are not deliverable and cannot sign in centrally.

## Tunables
`MODULE_LOGIN_MAX_FAILURES` (5), `MODULE_LOGIN_LOCK_MINUTES` (15), `MODULE_ARGON2_MEMORY_KIB` (19456), `MODULE_ARGON2_PASSES` (2). Older hashes still verify and are upgraded on the next successful login.
