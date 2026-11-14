-- 127_module_oidc_audit_events.sql — W1-P4: 'Login with AYZEN' on every module.
-- Two new audit events for module_auth_events: 'oidc_login' (an AYZEN identity proved by an OIDC access token opened a
-- module session, possibly provisioning the module account) and 'link' (an existing module account was explicitly linked
-- to an AYZEN identity). Idempotent: the constraint is dropped and re-added with the wider list.
ALTER TABLE module_auth_events DROP CONSTRAINT IF EXISTS module_auth_events_event_chk;
ALTER TABLE module_auth_events ADD CONSTRAINT module_auth_events_event_chk
  CHECK (event IN ('signup','login','logout','continue','password_reset_requested','password_reset_completed','oidc_login','link'));
