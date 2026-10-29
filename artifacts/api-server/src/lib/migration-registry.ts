import type { DomainService } from "./architecture/domains";

export type MigrationCutoverState =
  | "monolith"
  | "dual_read"
  | "read_switched"
  | "write_switched"
  | "extracted";

export interface MigrationRoute {
  routePrefix: string;
  service: DomainService;
  serviceUrlEnv: string;
  servicePackage: string;
  fallback: "monolith";
  state: MigrationCutoverState;
  requiredGates: readonly ["backup", "characterization", "backfill", "validation", "rollback"];
}

const REQUIRED_GATES: MigrationRoute["requiredGates"] = [
  "backup",
  "characterization",
  "backfill",
  "validation",
  "rollback",
];

/**
 * Phase 25 strangler matrix. Routes remain served by the modular monolith
 * until an operator explicitly advances a cutover state; there is no silent
 * traffic switch hidden in route registration.
 */
export const MIGRATION_ROUTES: readonly MigrationRoute[] = [
  { routePrefix: "/api/finance", service: "finance", serviceUrlEnv: "FINANCE_SERVICE_URL", servicePackage: "@ayzen/finance-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/vault", service: "vault", serviceUrlEnv: "VAULT_SERVICE_URL", servicePackage: "@ayzen/vault-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/mail", service: "mail", serviceUrlEnv: "WISP_SERVICE_URL", servicePackage: "@ayzen/mail-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/notifications", service: "notification", serviceUrlEnv: "NOTIFICATION_SERVICE_URL", servicePackage: "@ayzen/notification-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/workflows", service: "workflow", serviceUrlEnv: "WORKFLOW_SERVICE_URL", servicePackage: "@ayzen/workflow-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/ai", service: "ai-agent", serviceUrlEnv: "AI_SERVICE_URL", servicePackage: "@ayzen/ai-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/marketplace", service: "marketplace", serviceUrlEnv: "MARKETPLACE_SERVICE_URL", servicePackage: "@ayzen/marketplace-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
  { routePrefix: "/api/search", service: "search-knowledge", serviceUrlEnv: "SEARCH_SERVICE_URL", servicePackage: "@ayzen/search-service", fallback: "monolith", state: "monolith", requiredGates: REQUIRED_GATES },
];

const STATE_ORDER: readonly MigrationCutoverState[] = [
  "monolith",
  "dual_read",
  "read_switched",
  "write_switched",
  "extracted",
];

export function getMigrationRoute(routePrefix: string): MigrationRoute | undefined {
  return MIGRATION_ROUTES.find((route) => route.routePrefix === routePrefix);
}

export function canAdvanceMigration(
  current: MigrationCutoverState,
  next: MigrationCutoverState,
  completedGates: readonly string[],
): boolean {
  const currentIndex = STATE_ORDER.indexOf(current);
  const nextIndex = STATE_ORDER.indexOf(next);
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) return false;
  return REQUIRED_GATES.every((gate) => completedGates.includes(gate));
}

export function getMigrationReadiness(): {
  ready: boolean;
  routes: Array<MigrationRoute & { missingGates: string[] }>;
} {
  const routes = MIGRATION_ROUTES.map((route) => ({
    ...route,
    missingGates: [...route.requiredGates],
  }));
  return { ready: false, routes };
}