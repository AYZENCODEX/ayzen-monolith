import { DOMAIN_SERVICES, SERVICE_DESCRIPTORS, type DomainService } from "./architecture/domains";
import { getOwnedTables } from "./service-boundaries";
import { registerAyzenDomainEvents } from "./mega-engine/domain-events";

/**
 * These descriptors are the contract between the gateway and independently
 * runnable service packages. A service process owns transport and future
 * domain handlers; the migration registry controls when public traffic leaves
 * the monolith.
 */
export interface DomainServiceContract {
  service: DomainService;
  processPackage: string;
  routeEnv?: string;
  tables: readonly string[];
  capabilities: readonly string[];
  events: readonly string[];
  qualityGates: readonly [
    "authentication",
    "authorization",
    "rate-limiting",
    "audit-logging",
    "structured-logs",
    "metrics",
    "tracing",
    "health-readiness",
    "contract-tests",
  ];
}

const REQUIRED_SERVICE_QUALITY_GATES: DomainServiceContract["qualityGates"] = [
  "authentication",
  "authorization",
  "rate-limiting",
  "audit-logging",
  "structured-logs",
  "metrics",
  "tracing",
  "health-readiness",
  "contract-tests",
];

const CAPABILITIES: Readonly<Record<DomainService, readonly string[]>> = {
  "api-gateway": ["request-context", "rate-limits", "route-dispatch"],
  "telegram-gateway": ["bot-registry", "webhook-verification", "update-idempotency"],
  identity: ["session-authentication", "token-verification", "session-revocation"],
  authorization: ["policy-evaluation", "rbac", "audit"],
  workspace: ["personal-workspaces", "organization-workspaces", "membership-access"],
  finance: ["ledger", "invoices", "repayments", "net-worth"],
  vault: ["encrypted-entries", "sharing", "backup-and-recovery"],
  workflow: ["definitions", "durable-runs", "retries", "compensation"],
  mail: ["mailbox", "inbound-webhooks", "durable-send-queue", "delivery-tracking"],
  notification: ["preferences", "in-app", "telegram", "email", "sse"],
  "ai-agent": ["chat", "credits", "agent-actions"],
  marketplace: ["catalog", "orders", "offers"],
  "search-knowledge": ["search", "indexing"],
  analytics: ["request-metrics", "activity"],
  "event-bus": ["transactional-outbox", "dispatch", "retry", "dead-letter", "consumer-idempotency"],
};

const SERVICE_EVENTS: Readonly<Record<DomainService, readonly string[]>> = {
  "api-gateway": [],
  "telegram-gateway": ["telegram.notification.requested"],
  identity: ["oidc.login", "oidc.session.created", "oidc.session.revoked", "oidc.logout"],
  authorization: [],
  workspace: ["organization.member.invited", "organization.member.joined", "organization.member.role_changed", "organization.member.removed"],
  finance: ["credits.consumed", "credits.consumption_failed"],
  vault: ["vault.share.created", "vault.share.revoked"],
  workflow: ["workflow.started", "workflow.completed", "workflow.failed", "workflow.cancelled", "workflow.timed_out"],
  mail: ["notification.requested", "notification.delivered", "notification.failed"],
  notification: ["notification.requested", "notification.delivered", "notification.failed"],
  "ai-agent": ["ai.action.requested", "ai.action.completed", "ai.action.failed"],
  marketplace: ["project.lifecycle.changed"],
  "search-knowledge": [],
  analytics: [],
  "event-bus": [],
};

registerAyzenDomainEvents();

export const DOMAIN_SERVICE_CONTRACTS: readonly DomainServiceContract[] = DOMAIN_SERVICES.map((service) => ({
  service,
  processPackage: SERVICE_DESCRIPTORS.find((descriptor) => descriptor.key === service)?.processPackage ?? "@workspace/api-server",
  routeEnv: SERVICE_DESCRIPTORS.find((descriptor) => descriptor.key === service)?.routeEnv,
  tables: getOwnedTables(service),
  capabilities: CAPABILITIES[service],
  events: SERVICE_EVENTS[service],
  qualityGates: REQUIRED_SERVICE_QUALITY_GATES,
}));
