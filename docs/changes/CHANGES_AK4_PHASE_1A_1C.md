# AK4 Roadmap — Phase 1a (RBAC coverage gap) + Phase 1c (Telegram command-token scopes)

**Roadmap:** `AK4_ROADMAP.md`, Phase 1 ("Capability policy enforcement").
Closes 1a and 1c. **Does not** touch 1b (`CAPABILITY_AUTHZ_GATE` flip) —
that phase needed 1a done first and still needs a real `report`-mode
production observation window before anyone flips the env var; neither of
those is something a sandboxed pass over the repo can do. See "What's
still open" below.

## Scoping decision (confirmed with the product owner, not invented)

`user` gets every capability belonging to a non-admin product bot
(ayzenx/warde/verve/ryft/sylo/skarn/zynth/wisp — the exact set
`@ayzen/capabilities`' `COMMAND_TREE_DEFINITIONS` already enumerates as
ordinary end-user command surface). All 11 `admin.*` capabilities stay
reachable only via `admin`'s existing `*` wildcard, matching the legacy
`requireAdmin`-only behavior migration 096 deliberately didn't narrow.
`dev` is unchanged beyond what it already inherits from `user` plus its
one existing extra (`ryft.payment.approve`) — no new dev-only grant is
invented, per migration 096's own precedent.

## What shipped

### 1. `migrations/119_ak4_phase1a_rbac_capability_coverage.sql` (new)

Adds 17 new `permissions` catalog rows — one per capability *scope* that
was previously reachable only through `admin`'s wildcard (not one per
capability; several capabilities share a scope, e.g. all four
`workspace:read` capabilities). Grants all 17 to `user` via
`role_permissions`; `dev`/`admin` inherit them through the existing
`parent_role_key` chain from migration 096. Same idempotent
`CROSS JOIN (VALUES ...) ... ON CONFLICT DO NOTHING` shape 096 uses.

### 2. `lib/policy/rbac/session-scopes.ts` — `PERMISSION_KEY_TO_SCOPES`

Added the same 17 keys, each mapping 1:1 to the scope its name mirrors
(`"workspace.read": ["workspace:read"]`, etc.). This is the file that
actually mints scopes onto session tokens — the migration alone does
nothing until this mirror matches it. Rewrote the file header's "Coverage,
honestly stated" section, which was describing the gap this change
closes; it now describes the closed state and points at the validator as
the standing proof instead.

### 3. `scripts/validate-capability-scope-coverage.mjs`

- Mirrored the same 17 `PERMISSION_KEY_TO_SCOPES` entries (the file's own
  self-check fails loudly if this drifts from `session-scopes.ts`).
- Now parses **both** `migrations/096_ayzen_rbac_core.sql` and the new 119
  (`RBAC_MIGRATION_FILES`, plural) instead of hardcoding 096 alone, so
  future grant-expanding migrations can just be appended to that list.
- Made the pass/fail conclusion **domain-aware**: `admin.*` capabilities
  not being covered by `user`/`dev` is the intended shape (Phase 1a's own
  scoping decision), not a gap — the report now separates "NOT covered, BY
  DESIGN (admin-domain, admin-only)" from "NOT covered, UNINTENDED" and
  only the latter fails the overall conclusion. Before this change the
  script would have reported a false "gap" forever, since nothing was ever
  going to grant `user`/`dev` the admin domain.

**Verified:** re-ran the script after each change. `user` and `dev` now
cover 30/41 (all non-admin capabilities); the 11 uncovered are all
admin-domain and reported as by-design. `admin` unchanged at 41/41.
Conclusion line reads *"every seeded role covers every scoped/sensitive
capability it is intended to reach."*

### 4. Phase 1c — Telegram command-token scopes

Decision taken: make `issueToken` async and wire it to
`resolveSessionScopes()`, matching every other token-issuing path since
H14 (`routes/auth.ts`'s `mintSessionToken()`, `routes/passkey.ts`).

- `lib/telegram-command-adapter.ts`: `DomainCommandAdapterOptions.issueToken`
  is now `(identity) => Promise<string>`; its one call site awaits it.
- `lib/telegram-adapters/index.ts`: the real `issueToken` now calls
  `resolveSessionScopes(identity.userId, identity.role)` and mints
  `scopes`/`roles`/`stepUpAt` onto the 60s command token, same shape as
  every other issuer. `stepUpAt` is set to "now" for observability
  consistency with that precedent — it is **not** claiming a Telegram
  command re-verifies a credential the way a password/OTP/passkey login
  does (the account was verified once, at `/link` time). Given the 60s
  token lifetime the practical step-up window this opens is minor, per
  the roadmap's own note.
- `lib/telegram-command-adapter.test.ts`: updated the one test mock to the
  new async signature.

Telegram commands are still separately gated by
`assertTelegramCommandAuthorized()`/`TELEGRAM_COMMAND_POLICIES` — this
change makes the token those commands carry consistent with every other
session, it doesn't change how Telegram authorizes a command.

## What's still open

- **1b** (flip `CAPABILITY_AUTHZ_GATE` to `enforce`): unblocked by 1a
  landing, but still needs a real `report`-mode observation window against
  live production traffic before flipping — that can't be done from a
  static repo pass. The flip mechanism itself needs no new code:
  `CAPABILITY_AUTHZ_GATE` already reads from an env var and already fails
  toward `report` on anything unset/invalid, which already is the
  "explicit env/flag flip, not a code change with no rollback path" the
  roadmap phase asked for.
- **Typecheck/lockfile** (roadmap's own Phase 4): this change edits three
  more TypeScript files (`telegram-command-adapter.ts`,
  `telegram-adapters/index.ts`, `telegram-command-adapter.test.ts|`) on
  top of H14's, reviewed manually against existing signatures the same
  way H14's were, but — same as H14 — never run through `tsc` (no
  `node_modules`/network in this environment). Roll this into the same
  Phase 4 typecheck pass rather than treating it as a second, separate
  debt item.
