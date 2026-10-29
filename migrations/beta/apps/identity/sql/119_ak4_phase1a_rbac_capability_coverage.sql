-- AYZEN migration beta transfer: 119_ak4_phase1a_rbac_capability_coverage
-- Source: migrations/119_ak4_phase1a_rbac_capability_coverage.sql
-- Owner: identity
-- Target database: identity (isolated-capable)
-- This file is static reviewed SQL. Do not interpolate request data here.
-- Apply after the identity database has the RBAC tables from migration 096.

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

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES
  ('identity.authenticate'),
  ('identity.session.write'),
  ('workspace.read'),
  ('workspace.membership.write'),
  ('finance.read'),
  ('mail.read'),
  ('mail.send'),
  ('notification.write'),
  ('notification.read'),
  ('workflow.write'),
  ('workflow.read'),
  ('ai.execute'),
  ('search.read'),
  ('verve.read'),
  ('verve.write'),
  ('warde.read'),
  ('warde.write')
) AS p(permission_key)
WHERE r.key = 'user'
ON CONFLICT (role_id, permission_key) DO NOTHING;