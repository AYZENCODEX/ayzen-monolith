import { listEventDefinitions } from "./event-bus";
import { DOMAIN_SERVICE_CONTRACTS } from "./domain-service-contracts";
import { getOwnedTables } from "./service-boundaries";
import type { DomainService } from "./architecture/domains";

export type RoadmapPhaseNumber =
  | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17
  | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25;

export type RoadmapPhaseStatus = "implemented" | "boundary_ready" | "migration_ready";

export interface RoadmapPhaseContract {
  phase: RoadmapPhaseNumber;
  title: string;
  purpose: string;
  status: RoadmapPhaseStatus;
  services: readonly DomainService[];
  acceptanceCriteria: readonly string[];
}

/**
 * The roadmap is deliberately represented as data rather than comments spread
 * across routes. This is the reviewable checklist for the modular-monolith
 * stage: each domain can remain in one process while its ownership, events,
 * security controls, and extraction gates stay explicit.
 */
export const ROADMAP_PHASES_10_25: readonly RoadmapPhaseContract[] = [
  {
    phase: 10,
    title: "Event Bus",
    purpose: "Reliable asynchronous communication with versioned event envelopes.",
    status: "implemented",
    services: ["event-bus"],
    acceptanceCriteria: ["registered event vocabulary", "schema validation", "at-least-once dispatch", "consumer idempotency", "dead-letter handling"],
  },
  {
    phase: 11,
    title: "Outbox & Distributed Reliability",
    purpose: "Keep business writes and published events consistent.",
    status: "implemented",
    services: ["event-bus"],
    acceptanceCriteria: ["transactional outbox", "lease-based claims", "exponential backoff with jitter", "timeouts", "graceful worker shutdown"],
  },
  {
    phase: 12,
    title: "Finance Service / RYFT",
    purpose: "Own financial records and mutation integrity behind workspace authorization.",
    status: "boundary_ready",
    services: ["finance"],
    acceptanceCriteria: ["finance table ownership", "workspace authorization", "audit trail", "request idempotency", "concurrency-safe mutations"],
  },
  {
    phase: 13,
    title: "Vault Service / SYLO",
    purpose: "Protect encrypted records with explicit access and audit controls.",
    status: "boundary_ready",
    services: ["vault"],
    acceptanceCriteria: ["encrypted storage", "step-up/reveal controls", "access history", "expiration", "no sensitive content in logs"],
  },
  {
    phase: 14,
    title: "WISP Mailbox Service",
    purpose: "Own mailbox, thread, attachment, search, and permission behavior.",
    status: "boundary_ready",
    services: ["mail"],
    acceptanceCriteria: ["mailbox ownership", "threading", "attachment authorization", "spam controls", "mailbox audit"],
  },
  {
    phase: 15,
    title: "Mail Delivery Service",
    purpose: "Separate provider delivery from the WISP mailbox product.",
    status: "boundary_ready",
    services: ["mail"],
    acceptanceCriteria: ["provider abstraction", "durable send queue", "retry and bounce handling", "delivery tracking", "webhook verification"],
  },
  {
    phase: 16,
    title: "Notification Service",
    purpose: "Centralize cross-channel delivery and preferences.",
    status: "boundary_ready",
    services: ["notification"],
    acceptanceCriteria: ["channel adapters", "user preferences", "in-app delivery", "delivery status", "event-driven consumers"],
  },
  {
    phase: 17,
    title: "Workflow Service / SKARN",
    purpose: "Run durable, retryable, auditable automation.",
    status: "boundary_ready",
    services: ["workflow"],
    acceptanceCriteria: ["definitions and runs", "schedules", "pause/resume", "retry and compensation", "execution history"],
  },
  {
    phase: 18,
    title: "AI / Agent Service / ZYNTH",
    purpose: "Route AI work through permissions, tools, guardrails, and audit.",
    status: "boundary_ready",
    services: ["ai-agent"],
    acceptanceCriteria: ["tool registry", "policy checks", "credit controls", "AI audit", "explicit confirmation for sensitive actions"],
  },
  {
    phase: 19,
    title: "VERVE Communication/Productivity",
    purpose: "Keep communication and productivity capabilities behind a future extraction boundary.",
    status: "boundary_ready",
    services: ["workspace"],
    acceptanceCriteria: ["existing communication routes identified", "workspace isolation", "activity and preference ownership", "no direct client dependency on internal modules"],
  },
  {
    phase: 20,
    title: "Marketplace / Search / Knowledge / Analytics",
    purpose: "Keep secondary domains event-consumer-ready and independent of transactional tables.",
    status: "boundary_ready",
    services: ["marketplace", "search-knowledge", "analytics"],
    acceptanceCriteria: ["catalog and order ownership", "search route boundary", "analytics event boundary", "event-first integration"],
  },
  {
    phase: 21,
    title: "Observability",
    purpose: "Make request, event, workflow, and provider behavior diagnosable.",
    status: "implemented",
    services: ["api-gateway", "event-bus"],
    acceptanceCriteria: ["structured logs", "trace and correlation propagation", "request and queue metrics", "health/readiness", "secret-safe logging"],
  },
  {
    phase: 22,
    title: "Testing & Contract Platform",
    purpose: "Prevent boundary, authorization, and delivery regressions.",
    status: "implemented",
    services: ["api-gateway", "event-bus"],
    acceptanceCriteria: ["unit and integration tests", "contract tests", "security tests", "failure/recovery tests", "idempotency coverage"],
  },
  {
    phase: 23,
    title: "Frontend & Client Migration",
    purpose: "Keep clients behind the gateway with typed shared contracts.",
    status: "boundary_ready",
    services: ["api-gateway"],
    acceptanceCriteria: ["gateway-owned public paths", "shared API contract package", "no internal service addresses in clients", "privileged admin paths are explicit"],
  },
  {
    phase: 24,
    title: "Database Ownership",
    purpose: "Make each service's tables and schemas explicit before physical splitting.",
    status: "implemented",
    services: ["api-gateway", "event-bus"],
    acceptanceCriteria: ["owned-table registry", "fail-closed cross-service checks", "service schema metadata", "single cluster remains supported"],
  },
  {
    phase: 25,
    title: "Data Migration & Strangler Pattern",
    purpose: "Extract domains incrementally with backup, validation, monitoring, and rollback.",
    status: "migration_ready",
    services: ["api-gateway", "finance", "vault", "mail", "notification"],
    acceptanceCriteria: ["route migration matrix", "characterization tests", "backfill and validation gates", "read/write cutover states", "rollback plan"],
  },
];

export interface RoadmapReadinessCheck {
  phase: RoadmapPhaseNumber;
  title: string;
  ready: boolean;
  missing: string[];
}

function hasContract(service: DomainService): boolean {
  return DOMAIN_SERVICE_CONTRACTS.some((contract) => contract.service === service);
}

/**
 * Computes a cheap, deterministic readiness report without touching the
 * database. It is suitable for CI and the internal architecture endpoint.
 */
export function getRoadmapReadiness(): {
  ready: boolean;
  checks: RoadmapReadinessCheck[];
} {
  const eventBusTables = new Set(getOwnedTables("event-bus"));
  const checks = ROADMAP_PHASES_10_25.map((phase) => {
    const missing: string[] = [];
    for (const service of phase.services) {
      if (!hasContract(service)) missing.push(`missing service contract: ${service}`);
    }
    if ((phase.phase === 10 || phase.phase === 11) && !eventBusTables.has("event_outbox")) {
      missing.push("missing event_outbox ownership");
    }
    const gatewayTables = new Set(getOwnedTables("api-gateway"));
    if (phase.phase === 24 && !gatewayTables.has("service_table_ownership")) {
      missing.push("missing service_table_ownership registry");
    }
    if (phase.phase === 25 && !phase.acceptanceCriteria.includes("rollback plan")) {
      missing.push("missing rollback plan");
    }
    return { phase: phase.phase, title: phase.title, ready: missing.length === 0, missing };
  });
  return { ready: checks.every((check) => check.ready), checks };
}

export function getRoadmapPhase(phase: RoadmapPhaseNumber): RoadmapPhaseContract {
  const result = ROADMAP_PHASES_10_25.find((candidate) => candidate.phase === phase);
  if (!result) throw new Error(`Unknown roadmap phase: ${phase}`);
  return result;
}

export function getRegisteredEventTypes(): string[] {
  return listEventDefinitions().map((definition) => definition.type).sort();
}