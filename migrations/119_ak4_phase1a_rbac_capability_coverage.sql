-- 119_ak4_phase1a_rbac_capability_coverage.sql
-- AK4 Roadmap — Phase 1a: close the RBAC seed-data coverage gap.
-- Run this once in Supabase SQL Editor. Run AFTER 118.
--
-- Migration 096 (Phase 02) seeded `user`/`dev` with only three permission
-- keys (sylo.vault.read, sylo.vault.update, ryft.payment.create), covering
-- 4 of the 41 scoped/sensitive capabilities in `CAPABILITY_REGISTRY`
-- (@ayzen/capabilities). Per `scripts/validate-capability-scope-coverage.mjs`,
-- that leaves `CAPABILITY_AUTHZ_GATE` unsafe to flip to "enforce" — every
-- other registered route would deny a real, legitimately-privileged user.
--
-- SCOPING DECISION (confirmed, not invented here): `user` gets every
-- capability that belongs to a non-admin product bot (ayzenx, warde, verve,
-- ryft, sylo, skarn, zynth, wisp — see @ayzen/capabilities'
-- COMMAND_TREE_DEFINITIONS, which already enumerates exactly this set as
-- ordinary end-user command surface). All 11 `admin.*` capabilities stay
-- admin-only, matching the legacy `requireAdmin`-only behavior migration
-- 096 deliberately did not narrow. `dev` keeps its one existing
-- non-inherited extra (`ryft.payment.approve`) and otherwise inherits
-- `user` via `parent_role_key`, unchanged from 096 — no new dev-only grant
-- is invented here, per that migration's own precedent.
--
-- NEW PERMISSION KEYS: one per capability *scope* still uncovered (not one
-- per capability — several capabilities share a scope, e.g.
-- workspace.get-workspace/list-members/switch-context/activity all need
-- only "workspace:read"). Key names mirror the scope string
-- (":" -> ".") for a direct, auditable 1:1 mapping. This mirrors migration
-- 096's own `sylo.vault.read` -> `vault:read` pattern.
--
-- IMPORTANT — keep in sync with the mirrored scope-expansion table in BOTH
-- `artifacts/api-server/src/lib/policy/rbac/session-scopes.ts`'s
-- `PERMISSION_KEY_TO_SCOPES` (source of truth, consumed at token-mint time)
-- and `scripts/validate-capability-scope-coverage.mjs`'s own mirror (the
-- self-check there fails loudly if the two drift) — this migration is only
-- half the change; both TS mirrors must add the same 17 entries below
-- before this migration's grants actually resolve to real scopes.
--
-- IDEMPOTENT — every statement is safe to re-run, matching every other
-- file in this directory.

-- ── New permission catalog entries (one per newly-covered scope) ──────────
INSERT INTO permissions (key, description)
VALUES
  ('identity.authenticate', 'Log in / authenticate as an AYZEN user.'),
  ('identity.session.write', 'Issue or revoke one''s own AYZEN session.'),
  ('workspace.read', 'Read workspace metadata, members, activity, and switch context.'),
  ('workspace.membership.write', 'Add or remove workspace members.'),
  ('finance.read', 'List Ryft accounts and read balances.'),
  ('mail.read', 'List/read Wisp messages, threads, and search mail.'),
  ('mail.send', 'Send a Wisp message.'),
  ('notification.write', 'Create a notification.'),
  ('notification.read', 'List notifications.'),
  ('workflow.write', 'Start or cancel a Skarn workflow execution.'),
  ('workflow.read', 'Read a Skarn workflow execution.'),
  ('ai.execute', 'Run a Zynth AI agent.'),
  ('search.read', 'Execute a platform search.'),
  ('verve.read', 'List Verve marketplace listings.'),
  ('verve.write', 'Create a Verve marketplace listing.'),
  ('warde.read', 'Read a Warde organization report.'),
  ('warde.write', 'Manage Warde organization members.')
ON CONFLICT (key) DO NOTHING;

-- ── Grant every new permission key to 'user' ───────────────────────────────
-- 'dev' and 'admin' already inherit these via parent_role_key (096); no
-- additional 'dev'-only grant is added here (see header).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES ('identity.authenticate'), ('identity.session.write'), ('workspace.read'), ('workspace.membership.write'), ('finance.read'), ('mail.read'), ('mail.send'), ('notification.write'), ('notification.read'), ('workflow.write'), ('workflow.read'), ('ai.execute'), ('search.read'), ('verve.read'), ('verve.write'), ('warde.read'), ('warde.write')) AS p(permission_key)
WHERE r.key = 'user'
ON CONFLICT (role_id, permission_key) DO NOTHING;
