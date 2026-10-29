import { DOMAIN_SERVICES, type DomainService } from "./architecture/domains";

/**
 * Phase 10 — database boundary registry.
 *
 * Code in a domain module should only query tables listed for that domain.
 * This is intentionally explicit and small: it makes ownership reviewable
 * today and gives a future extracted service a safe migration inventory.
 */
const OWNED_TABLES: Readonly<Record<DomainService, readonly string[]>> = {
  "api-gateway": ["service_registry", "service_table_ownership"],
  "telegram-gateway": ["telegram_bots", "telegram_update_receipts"],
  identity: ["users", "user_sessions", "passkeys", "otp_codes", "jwt_signing_keys", "oidc_clients"],
  authorization: ["roles", "permissions", "role_permissions", "user_roles", "authorization_audit_log"],
  workspace: ["workspaces", "workspace_members", "organizations", "organization_members"],
  finance: ["finance_ledger_entries", "finance_accounts", "finance_invoices"],
  vault: ["vault_entries", "vault_security", "vault_attachments", "vault_snapshots"],
  workflow: ["workflow_run", "scheduled_job", "scheduled_job_attempt"],
  mail: ["mail_messages", "email_accounts", "ayzen_mailbox"],
  notification: ["notifications", "notification_preferences"],
  "ai-agent": ["ai_actions", "mcp_agents"],
  marketplace: ["marketplace_listings", "marketplace_orders"],
  "search-knowledge": ["search_index"],
  analytics: ["request_metrics", "user_activity"],
  "event-bus": ["event_outbox", "event_processed", "event_processing", "event_dead_letter"],
};

export function getOwnedTables(service: DomainService): readonly string[] {
  return OWNED_TABLES[service];
}

export function getTableOwner(tableName: string): DomainService | undefined {
  return DOMAIN_SERVICES.find((service) => OWNED_TABLES[service].includes(tableName));
}

export function assertTableOwnedBy(service: DomainService, tableName: string): void {
  const owner = getTableOwner(tableName);
  if (owner && owner !== service) {
    throw new Error(`Database boundary violation: ${service} cannot access ${tableName}; owner is ${owner}`);
  }
}