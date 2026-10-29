import { createDomainContract } from "@ayzen/contracts";

const definitions = [
  createDomainContract({
    name: "identity",
    owner: "Identity",
    publicOperations: ["authenticate", "issue-session", "refresh", "revoke-session", "jwks"],
    ownedResources: ["users", "credentials", "sessions", "mfa", "oidc_clients"],
    emittedEvents: ["user.created", "user.updated", "session.created", "session.revoked", "authentication.failed"],
  }),
  createDomainContract({
    name: "authorization",
    owner: "Authorization",
    publicOperations: ["authorize", "explain-policy"],
    ownedResources: ["policies", "roles", "permissions", "policy_audit"],
    emittedEvents: ["policy.decision.allowed", "policy.decision.denied"],
  }),
  createDomainContract({
    name: "workspace",
    owner: "Workspace",
    publicOperations: ["get-workspace", "list-members", "add-member", "remove-member"],
    ownedResources: ["workspaces", "workspace_memberships"],
    emittedEvents: ["workspace.created", "workspace.member.added"],
  }),
  createDomainContract({
    name: "finance",
    owner: "RYFT",
    publicOperations: ["list-accounts", "create-account", "post-transaction", "get-balance"],
    ownedResources: ["finance_accounts", "finance_transactions", "finance_ledger", "finance_audit"],
    // AK4 Phase 2, finding 2c — "finance.transaction.updated" removed;
    // see services/finance/src/index.mjs's matching comment. This is a
    // target-state correction, not just a today's-code correction: the
    // ledger is designed to be append-only (transactions are never
    // reversed in place), so there is no planned future world where this
    // service emits an "updated" event for a transaction.
    emittedEvents: ["finance.transaction.created"],
  }),
  createDomainContract({
    name: "vault",
    owner: "SYLO",
    publicOperations: ["list-secrets", "create-secret", "read-secret"],
    ownedResources: ["vault_records", "vault_versions", "vault_access_audit"],
    emittedEvents: ["vault.secret.accessed", "vault.secret.updated"],
  }),
  createDomainContract({
    name: "mail",
    owner: "WISP",
    publicOperations: ["list-messages", "send-message", "read-thread", "search"],
    ownedResources: ["mailboxes", "mail_messages", "mail_threads", "mail_attachments"],
    emittedEvents: ["wisp.message.received", "wisp.message.sent", "mail.delivery.requested", "mail.delivery.updated"],
  }),
  createDomainContract({
    name: "notification",
    owner: "Notification",
    publicOperations: ["create-notification", "list-notifications", "manage-preferences"],
    ownedResources: ["notification_templates", "notification_preferences", "notification_deliveries"],
    consumedEvents: ["finance.transaction.created", "wisp.message.received", "workflow.completed"],
    emittedEvents: ["notification.requested", "notification.sent", "notification.failed"],
  }),
  createDomainContract({
    name: "workflow",
    owner: "SKARN",
    publicOperations: ["create-workflow", "start-execution", "cancel-execution", "get-execution"],
    ownedResources: ["workflows", "workflow_versions", "workflow_executions", "workflow_steps", "workflow_schedules", "workflow_approvals"],
    consumedEvents: ["finance.transaction.created", "wisp.message.received", "workflow.completed", "workflow.failed"],
    emittedEvents: ["workflow.started", "workflow.completed", "workflow.failed", "workflow.cancelled"],
  }),
  createDomainContract({
    name: "ai",
    owner: "ZYNTH",
    publicOperations: ["run-agent", "list-models"],
    ownedResources: ["ai_runs", "ai_usage", "ai_audit"],
    consumedEvents: ["workflow.completed"],
    emittedEvents: ["ai.task.completed"],
  }),
  createDomainContract({
    name: "search",
    owner: "Search",
    publicOperations: ["search", "index-document"],
    ownedResources: ["search_documents", "search_indexes"],
    consumedEvents: ["wisp.message.sent", "finance.transaction.created"],
    emittedEvents: ["search.document.indexed"],
  }),
  createDomainContract({
    name: "marketplace",
    owner: "VERVE",
    publicOperations: ["list-listings", "create-listing", "place-order"],
    ownedResources: ["marketplace_listings", "marketplace_orders", "marketplace_reviews"],
    emittedEvents: ["marketplace.listing.created", "marketplace.order.created"],
  }),
  createDomainContract({
    name: "intelligence",
    owner: "Intelligence",
    publicOperations: ["list-signals", "read-observation"],
    ownedResources: ["intelligence_observations", "intelligence_signals", "technical_gaps"],
    consumedEvents: ["audit.created", "user.error", "service.health.changed"],
    emittedEvents: ["intelligence.observation.created", "intelligence.signal.created", "technical_gap.detected"],
  }),
  createDomainContract({
    name: "admin",
    owner: "Admin",
    publicOperations: ["read-control-plane", "query-data", "mutate-data", "issue-break-glass"],
    ownedResources: ["admin_configuration", "admin_alerts", "admin_gaps", "admin_deployments", "admin_data_access"],
    consumedEvents: ["alert.created", "incident.created", "technical_gap.detected", "deployment.succeeded"],
    // AK4 Phase 2, findings 2d/2e — "alert.created"/"incident.created"
    // removed from emittedEvents (consumedEvents above is correct and
    // unchanged: admin genuinely ingests both via POST /api/admin/events).
    // Having both types in both lists here was a copy-paste artifact, not
    // a deliberate "admin also produces these" design — see
    // services/admin/src/index.mjs's matching comment and
    // docs/changes/CHANGES_AK4_PHASE2_EVENT_WIRING_DECISIONS.md.
    emittedEvents: ["audit.created"],
  }),
  createDomainContract({
    name: "telegram",
    owner: "Telegram Platform",
    publicOperations: ["receive-update", "resolve-command", "render-menu"],
    ownedResources: ["telegram_bots", "telegram_update_receipts", "telegram_sessions", "telegram_identity_links"],
    consumedEvents: ["identity.telegram.linked"],
    emittedEvents: ["telegram.update.received", "telegram.update.failed", "telegram.auth.linked", "telegram.auth.unlinked"],
  }),
  createDomainContract({
    name: "platform",
    owner: "Platform",
    // This is a deliberate catch-all contract, not a curated product domain:
    // tools/domain-routing/generate-endpoint-registry.mjs's own GROUP_TO_OWNER
    // comment calls "platform" "a deliberate catch-all for product surface
    // that doesn't map to a declared domain contract yet" -- several hundred
    // legacy monolith routes (ad-tasks, broadcast, checkin, content,
    // earn-links, entities, game-entries, health-rules, layout, leaderboard,
    // local-accounts, messages, networks, polymarket, profile, referrals,
    // reward-links, settings, support, telemetry, tools, ui-theme, uptime,
    // watchlist, webhooks, and more) that predate the per-domain contract
    // model. publicOperations below is a representative slice of that
    // surface -- enough for every route under this owner to trace back to
    // *a* declared public operation via the coverage validator's fuzzy
    // match, not an exhaustive one-operation-per-route enumeration (that
    // granularity belongs in ENDPOINT_REGISTRY itself, not this contract).
    // Splitting this catch-all into real per-feature domain contracts is
    // tracked as future work, not something this phase forces -- see
    // docs/changes/CHANGES_CONTRACT_ZERO_GAP_PHASE6.md.
    publicOperations: [
      "manage-ad-tasks", "manage-broadcast", "manage-checkin", "generate-content",
      "export-csv", "manage-earn-links", "manage-entities", "read-events",
      "read-functions", "manage-game-entries", "manage-health-rules", "read-layout",
      "read-leaderboard", "manage-local-accounts", "manage-messages", "manage-networks",
      "read-platform-root", "manage-polymarket", "manage-profile", "resolve-referral-link",
      "manage-referrals", "manage-reward-links", "manage-settings", "read-shared-apps",
      "manage-support-tickets", "read-telemetry", "manage-tools", "manage-ui-theme",
      "read-uptime-status", "manage-watchlist", "receive-webhooks",
    ],
    ownedResources: [
      "ad_tasks", "broadcasts", "checkins", "generated_content", "earn_links",
      "platform_entities", "game_entries", "health_rules", "page_layouts",
      "local_accounts", "user_messages", "networks", "referrals", "reward_links",
      "platform_settings", "support_tickets", "watchlist_items",
    ],
    emittedEvents: ["platform.internal.health"],
  }),
];

export const DOMAIN_CONTRACTS = Object.freeze(definitions);
export const DOMAIN_CONTRACT_MAP = Object.freeze(Object.fromEntries(definitions.map((definition) => [definition.name, definition])));

export const DATABASE_OWNERSHIP = Object.freeze({
  identity: ["users", "user_sessions", "passkeys", "otp_codes", "jwt_signing_keys", "oidc_clients"],
  authorization: ["roles", "permissions", "role_permissions", "user_roles", "authorization_audit_log"],
  workspace: ["workspaces", "workspace_members", "organizations", "organization_members"],
  finance: ["finance_ledger_entries", "finance_accounts", "finance_invoices"],
  vault: ["vault_entries", "vault_security", "vault_attachments", "vault_snapshots"],
  mail: ["mail_messages", "email_accounts", "ayzen_mailbox"],
  notification: ["notifications", "notification_preferences"],
  workflow: ["workflow_run", "scheduled_job", "scheduled_job_attempt"],
  ai: ["ai_actions", "mcp_agents"],
  search: ["search_index"],
  intelligence: ["intelligence_observations", "intelligence_signals"],
  telemetry: ["request_metrics", "user_activity"],
  "event-bus": ["event_outbox", "event_processed", "event_processing", "event_dead_letter"],
  marketplace: ["marketplace_listings", "marketplace_orders", "marketplace_reviews"],
  admin: ["admin_configuration", "admin_alerts", "admin_gaps", "admin_deployments", "admin_data_access"],
  telegram: ["telegram_bots", "telegram_update_receipts", "telegram_sessions", "telegram_identity_links"],
});

export function getDomainContract(name) {
  return DOMAIN_CONTRACT_MAP[name];
}

export function assertPublicOperation(domain, operation) {
  const definition = getDomainContract(domain);
  if (!definition) throw new Error(`Unknown domain: ${domain}`);
  if (!definition.publicOperations.includes(operation)) throw new Error(`Operation "${operation}" is private to ${domain}`);
  return operation;
}

export function assertResourceOwner(domain, resource) {
  const definition = getDomainContract(domain);
  if (!definition) throw new Error(`Unknown domain: ${domain}`);
  if (!definition.ownedResources.includes(resource)) throw new Error(`${domain} cannot own resource "${resource}"`);
  return resource;
}

export function getTableOwner(tableName) {
  return Object.entries(DATABASE_OWNERSHIP).find(([, tables]) => tables.includes(tableName))?.[0];
}

export function assertTableOwnedBy(domain, tableName) {
  const owner = getTableOwner(tableName);
  if (owner && owner !== domain) throw new Error(`Database boundary violation: ${domain} cannot access ${tableName}; owner is ${owner}`);
  return tableName;
}