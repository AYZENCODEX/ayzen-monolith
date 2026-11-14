# W1-P1: per-module accounts + module user IDs (req 1)

Roadmap: `AYZEN Monolith: Audit + Full Roadmap` (2026-11-04), Wave 1, Identity track. **Migration number: 125.**

Every user can now hold one account per module (Sylo, Ryft, Fyra, Verve, Skarn, Warde, Wisp, Zynth), each with its own
display ID: `SYL-000001`, `RFT-000001`, ... (ADR A1 / Q1 default: `<PREFIX>-<6 digit>`; the number grows past 999999 instead
of truncating). Internal foreign keys stay integers. Nothing about login/sessions changes here (that is W1-P2/W1-P4).

## What changed
- **`migrations/125_module_accounts.sql`** (mirrored statement-for-statement into `artifacts/api-server/src/lib/schema-migrations.ts`, which is what runs at boot; idempotent, additive only):
  - `module_accounts(user_id, module, module_uid, seq, status, source, ...)`; unique on `(user_id, module)`, `module_uid` and `(module, seq)`; CHECKs on module list, status, source and uid shape; `ON DELETE CASCADE` from `users`.
  - One sequence per module (`module_uid_seq_<module>`), so each module counts from 000001 independently.
  - `ayzen_format_module_uid(prefix, seq)` and `ayzen_provision_module_account(user_id, module, source)`: idempotent and race-safe (a lost race returns the winner's row). Sequence gaps are expected and harmless.
  - Table registered in `service_table_ownership` under `identity`.
- **`lib/db/src/schema/module-accounts.ts`** drizzle table; **`artifacts/api-server/src/lib/module-accounts.ts`** typed helpers (`listModuleAccounts`, `provisionModuleAccount`, `findByModuleUid`, `moduleUidForOidcClient`).
- **`packages/identity-context`**: `formatModuleUid / parseModuleUid / isValidModuleUid` (canonical spelling only), type declarations; **`schemas/platform/identifiers.json`**: `moduleUid` definition and identifier type (durable account id, not part of the causation chain). `api-server` now depends on `@ayzen/identity-context` (lockfile updated).
- **API**: `GET /me/modules` (caller's id per module, `null` = no account yet; read-only, never provisions) and `GET /admin/module-accounts/lookup?uid=SYL-000001|userId=42` (admin role). Both added to `packages/endpoint-registry` (hand-inserted: the generated file already had unrelated drift, see below).
- **OIDC**: UserInfo adds a `module_uid` claim (with `profile` scope) when the calling client is a module's own client (registry `oidcClientId`) and the user has an account there. Additive; lookup failure degrades to "claim absent".
- **UI**: `ModuleUidBadge` (click-to-copy) under the module sidebar header, `ModuleIdsPanel` on the profile page. Both render nothing when the user has no ID.
- **Backfill**: `scripts/src/backfill-module-accounts.mjs` (logic in `scripts/src/lib/module-accounts-backfill.mjs`).

## Backfill (run after deploy)
```
DATABASE_URL=... pnpm backfill:module-accounts               # DRY RUN: per-module report, writes nothing
DATABASE_URL=... pnpm backfill:module-accounts --apply       # create missing accounts
... --module sylo --module fyra                              # limit to some modules
```
Attribution (module <- tables where the user owns a row; orphan rows are ignored and reported):
sylo <- vault_entries, local_accounts, kyc_entries, game_entries · ryft <- wallets · fyra <- finance_ledger_entries ·
verve <- marketplace_listings.seller_id, marketplace_orders.buyer_id/seller_id · skarn <- user_projects, project_enrollments, task_submissions ·
warde <- team_members · wisp <- email_accounts, ayzen_mail.from_user_id, users with `ayzen_email` · zynth <- nothing (see below).
Deterministic (user id ascending) and idempotent. **Review the dry-run report before `--apply`**: the attribution map is a judgment call (roadmap risk "wrong module attribution"); edit `SOURCES` first if a rule is wrong. Re-attribution after the fact means closing/reassigning rows by hand, since IDs are never reused.

## Known gaps / decisions for the owner
- **Q1 (ID format) is still PENDING.** This implements the recommended `SYL-000001`. A short `SYL-01` style would need a different migration; do not apply this to production if you want that.
- **Zynth has no per-user table** in the monolith (`ai_agent_messages` is the admin agent, no `user_id`), so nothing backfills it. Zynth accounts must be provisioned lazily (`source='lazy'`) on first use; W1-P2/W1-P4 should call `provisionModuleAccount`.
- Nothing provisions accounts for **new signups** yet; that belongs to W1-P4 (Login with AYZEN auto-provision). Until then new users appear only after a backfill re-run (cheap and idempotent).
- Claims in session JWTs (`signAuthToken`) are intentionally not touched: a session is not module-scoped until W1-P2. The claim exists on OIDC UserInfo for module clients only.
- `packages/endpoint-registry` regenerates with unrelated drift on this commit (finance/vault/mcp rows). I inserted only the two new rows; whoever owns that file should run the generator separately.
- No Policy Engine rule/audit event: both endpoints are read-only and grant no new access (admin lookup uses the existing admin role gate).

## Verification
- `node scripts/validate-w1-p1.mjs`: registry <-> SQL <-> boot mirror <-> drizzle <-> backfill map <-> identifiers.json agree.
- `node --test packages/identity-context/test/index.test.mjs`: 16 pass.
- `MODULE_ACCOUNTS_TEST_DATABASE_URL=... node --test scripts/src/test-module-accounts-db.mjs`: 9 pass on real Postgres 16 (migration idempotent; SQL/JS formatter parity incl. >999999; every registry prefix; idempotent provisioning; 30 users x 4 concurrent callers = unique ids and one row each; cascade; backfill dry-run/determinism/idempotency/orphans/missing table; mid-module failure rolls back). Wired into CI as the `module-accounts` job.
- Not run here: the full api-server/frontend test suites and `pnpm build` (dependencies for those packages were not installed in this environment); `tsc --noEmit` on api-server showed no errors in the touched files.

## Rollback
- Kill switch for the claim: `AYZEN_MODULE_UID_CLAIM=off`.
- The UI/API additions are inert without rows; revert the change set to remove them. The schema is additive: `DROP TABLE module_accounts` (plus the two functions and eight `module_uid_seq_*` sequences) undoes the migration; nothing else references it.
