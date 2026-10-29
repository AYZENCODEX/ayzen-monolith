# AYZEN Enforcement Roadmap — Track H, Phase H14 (mint real scopes/roles/stepUpAt)

**Roadmap:** `AYZEN_H4_Event_Workflow_Enforcement_Roadmap_Season2.md`,
H14-candidate per the event/workflow/notification/scheduler/policy wiring
audit's §5 ("Policy engine — fine-grained capability authorization is
non-enforcing everywhere, by design, today"). Closes the exact gap that
audit — and H9.2's own code comment before it — named as the reason
`CAPABILITY_AUTHZ_GATE` defaults to `report`: *nothing in this repo minted
real `scopes`/`roles`/`stepUpAt` claims onto a session token.*

## What shipped

### 1. `lib/policy/rbac/session-scopes.ts` (new)

`resolveSessionScopes(userId, role)` — resolves a user's legacy-implicit +
explicit RBAC roles (mirrors `rbac-rule.ts`'s own pattern), walks them
through `resolveEffectivePermissions()`, and expands the resulting grant
patterns into `packages/capabilities`' `CAPABILITY_REGISTRY` scope
vocabulary via a small, hand-reviewed `PERMISSION_KEY_TO_SCOPES` table (an
editorial call, not a mechanical transform — the two vocabularies were
never declared to line up 1:1; see the file's own header). Exports
`expandGrantsToScopes()` and `ALL_CAPABILITY_SCOPES` so
`scripts/validate-capability-scope-coverage.mjs` can run the identical
expansion offline instead of re-implementing it. Never throws — a DB error
resolving roles/permissions degrades to `{ scopes: [], roles: [] }` rather
than failing the login itself (logged via the existing `logger`).

### 2. `lib/jwt.ts` — `scopes`, `roles`, `stepUpAt` claims

`AuthTokenPayload` gains three optional fields. `signAuthToken()` accepts
them and includes each only when non-empty. `verifyAuthToken()`'s
`extractPayload()` reads them back defensively (`stringArrayClaim()`
drops anything malformed rather than trusting it — same posture as every
other claim this function reads). Absent on tokens minted before this
existed, or when resolution itself failed — both read as "no scopes,"
never "all scopes."

### 3. `lib/identity-service.ts` — pass-through updated

`issueSessionToken()`'s options type widened to match `signAuthToken()`'s
new signature. Not yet called anywhere in this repo (its own header
already says this file is a seam for a future extracted identity
service) — updated for signature parity, no behavior change.

### 4. Every real login path now mints real claims

- `routes/auth.ts`'s `mintSessionToken()` — the one choke point `/auth/
  register`, `/auth/login` (via `finalizeLogin`), `/auth/magic-link/
  verify`, `/auth/reset-password`, `/auth/supabase-sync`, and `/auth/init`
  all already funneled through — now calls `resolveSessionScopes()` and
  sets `stepUpAt` to "now" on every call, since every caller has a
  password/OTP/OAuth-sync verification immediately above it.
- `routes/passkey.ts`'s three `signAuthToken()` sites (direct passkey
  login, step-up-chain-cleared login, and the final factor of an open
  login challenge) — same treatment: each follows a just-completed fresh
  credential verification.
- `routes/auth.ts`'s `/auth/refresh` — deliberately does **not** call
  `resolveSessionScopes()` or set a fresh `stepUpAt`. A refresh doesn't
  re-verify a credential, so it now carries the *previous* token's
  `scopes`/`roles`/`stepUpAt` forward unchanged (read via `verifyAuthToken`
  on the incoming refresh token) — exactly what `lib/jwt.ts`'s `stepUpAt`
  doc comment already specified, now actually true for `scopes`/`roles`
  too, not just `stepUpAt`.
- `routes/auth.ts`'s `/auth/session-exchange` — same non-re-verifying
  reasoning as refresh: it exchanges an already-open cookie session for a
  standalone token, so it carries the cookie session's own claims forward
  (`verifyAuthToken(cookieToken)`) rather than re-resolving or resetting
  them.

### 5. `scripts/validate-capability-scope-coverage.mjs` (new, not a CI gate)

Re-runs `session-scopes.ts`'s exact expansion (mirrored, not imported —
this script is plain `.mjs`, that file is TypeScript; a self-check fails
loudly if the mirror drifts from the real table) over every role
`migrations/096_ayzen_rbac_core.sql` actually seeds, and reports, for
every scoped/sensitive `CAPABILITY_REGISTRY` entry, whether that role's
resolved scopes would satisfy it. Answers the question this phase's own
scope-minting does **not** by itself answer: *given what RBAC currently
grants, would flipping `CAPABILITY_AUTHZ_GATE` to `enforce` deny requests
a real, legitimately-privileged user should be able to make?*

Run today, against migration 096's seed data, it says: **yes, it would.**
`user` and `dev` each cover only 4 of 41 scoped/sensitive capabilities
(the `sylo.vault.*` / `ryft.payment.*` permissions migration 096 actually
seeds for them); only `admin`'s global `*` wildcard reaches everything.
Full output is reproducible by running the script — not reproduced in
full here since it will drift as `role_permissions` seed data grows.

Deliberately **not** wired into `scripts/full-system-audit.mjs`'s
pass/fail expectations the way `validate-event-wiring.mjs` was in the
prior audit pass — it auto-discovers via the same `validate-*.mjs` glob
(informational), but a coverage gap here is a genuine "RBAC hasn't
granted this yet" product fact, not a bug to fix by editing code. The
script only sets a failing exit code on its own self-check drifting or
failing to parse the migration file.

## What this phase does — and does NOT — close

This mints the claims `CAPABILITY_AUTHZ_GATE`'s `report`-default comment
named as missing. It does **not**, by itself, make flipping that gate to
`enforce` safe — see item 5 above: today's RBAC seed data would produce
real `MISSING_SCOPE` denials for `user`/`dev` on almost every scoped
route. Flipping the default is still its own, separately-scoped decision
(expand `role_permissions` seed data or build a real grant UI, observe a
`report`-mode window against real traffic, then flip) — this phase only
makes that decision possible to evaluate with data instead of a code
comment's assertion.

## Not done in this pass

- `lib/telegram-adapters/index.ts`'s per-command `issueToken` (60s-lived,
  Telegram-command-scoped tokens) was **not** wired to
  `resolveSessionScopes()` — its `issueToken` callback is synchronous by
  the `DomainCommandAdapterOptions` contract it implements, and Telegram
  commands already go through their own separate
  `assertTelegramCommandAuthorized()` / `TELEGRAM_COMMAND_POLICIES` gate,
  not `CAPABILITY_AUTHZ_GATE`. Making that callback async to resolve real
  RBAC scopes is a real follow-up, not a drive-by change inside this pass.
- No `role_permissions` seed data was added or changed. Closing the
  coverage gap §5's script now proves is a product/roadmap decision
  (which capabilities each of `user`/`dev` should actually reach), not
  something this phase should decide unilaterally by inventing grants.
- `CAPABILITY_AUTHZ_GATE` itself was **not** flipped to `enforce`, and
  should not be until the coverage gap above is addressed and a
  `report`-mode observation window confirms nothing legitimate would be
  denied — same rollout shape `lib/oidc-client-rollout.ts` already
  establishes for its own gated flips.
