/**
 * Phase 1 — architectural foundation.
 *
 * These are meaningful business boundaries, not proposed process boundaries.
 * The application remains a modular monolith until an extraction has a real
 * scaling, isolation, compliance, or reliability reason.
 */
export const DOMAIN_SERVICES = [
  "api-gateway",
  "telegram-gateway",
  "identity",
  "authorization",
  "workspace",
  "finance",
  "vault",
  "workflow",
  "mail",
  "notification",
  "ai-agent",
  "marketplace",
  "search-knowledge",
  "analytics",
  "event-bus",
] as const;

export type DomainService = (typeof DOMAIN_SERVICES)[number];

export interface ServiceDescriptor {
  key: DomainService;
  displayName: string;
  basePath: string;
  ownerSchema: string;
  extractionStatus: "modular_monolith" | "extraction_ready" | "independent_process";
  processPackage: string;
  routeEnv?: string;
}

export const SERVICE_DESCRIPTORS: readonly ServiceDescriptor[] = [
  { key: "api-gateway", displayName: "API Gateway", basePath: "/api", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/api-gateway" },
  { key: "telegram-gateway", displayName: "Telegram Gateway", basePath: "/api/telegram", ownerSchema: "public", extractionStatus: "extraction_ready", processPackage: "@workspace/api-server" },
  { key: "identity", displayName: "Identity", basePath: "/api/auth", ownerSchema: "public", extractionStatus: "extraction_ready", processPackage: "@workspace/api-server" },
  { key: "authorization", displayName: "Authorization", basePath: "/api", ownerSchema: "public", extractionStatus: "extraction_ready", processPackage: "@workspace/api-server" },
  { key: "workspace", displayName: "Workspace", basePath: "/api/workspaces", ownerSchema: "public", extractionStatus: "extraction_ready", processPackage: "@workspace/api-server" },
  { key: "finance", displayName: "Finance", basePath: "/api/finance", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/finance-service", routeEnv: "FINANCE_SERVICE_URL" },
  { key: "vault", displayName: "Vault", basePath: "/api/vault", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/vault-service", routeEnv: "VAULT_SERVICE_URL" },
  { key: "workflow", displayName: "Workflow", basePath: "/api/workflows", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/workflow-service", routeEnv: "WORKFLOW_SERVICE_URL" },
  { key: "mail", displayName: "Mail", basePath: "/api/mail", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/mail-service", routeEnv: "WISP_SERVICE_URL" },
  { key: "notification", displayName: "Notification", basePath: "/api/notifications", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/notification-service", routeEnv: "NOTIFICATION_SERVICE_URL" },
  { key: "ai-agent", displayName: "AI / Agent", basePath: "/api/ai", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/ai-service", routeEnv: "AI_SERVICE_URL" },
  { key: "marketplace", displayName: "Marketplace", basePath: "/api/marketplace", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/marketplace-service", routeEnv: "MARKETPLACE_SERVICE_URL" },
  { key: "search-knowledge", displayName: "Search / Knowledge", basePath: "/api/search", ownerSchema: "public", extractionStatus: "independent_process", processPackage: "@ayzen/search-service", routeEnv: "SEARCH_SERVICE_URL" },
  { key: "analytics", displayName: "Analytics", basePath: "/api/analytics", ownerSchema: "public", extractionStatus: "modular_monolith", processPackage: "@workspace/api-server" },
  { key: "event-bus", displayName: "Event Bus", basePath: "/api/events", ownerSchema: "public", extractionStatus: "extraction_ready", processPackage: "@workspace/api-server" },
];

export function getServiceDescriptor(key: string): ServiceDescriptor | undefined {
  return SERVICE_DESCRIPTORS.find((service) => service.key === key);
}