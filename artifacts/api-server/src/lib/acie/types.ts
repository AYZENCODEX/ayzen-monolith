import type { EventEnvelope } from "../event-bus";

export type Json = Record<string, unknown>;
export type IntelligenceType =
  | "PATTERN"
  | "BEHAVIOR"
  | "ANOMALY"
  | "FUSED_SIGNAL"
  | "CAUSAL"
  | "RISK"
  | "RESOURCE"
  | "COST"
  | "CAPACITY"
  | "PROCESS"
  | "FORECAST"
  | "MAINTENANCE"
  | "DECISION"
  | "STRATEGIC"
  | "RECOMMENDATION";
export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AcieContext {
  tenantId: string;
  actorId?: number;
  traceId: string;
  correlationId?: string;
  source?: string;
}

export interface MetricObservation {
  id?: string;
  subjectId: string;
  metric: string;
  value: number;
  occurredAt?: string;
  unit?: string;
  tags?: Record<string, string>;
  metadata?: Json;
}

export interface Signal {
  id: string;
  tenantId: string;
  subjectId: string;
  type: string;
  value: number;
  severity: Severity;
  confidence: number;
  summary: string;
  evidenceIds: string[];
  occurredAt: string;
  traceId: string;
  source: string;
}

export interface Evidence {
  id: string;
  kind: "OBSERVATION" | "EVENT" | "HISTORY" | "GRAPH" | "PROVENANCE" | "MODEL";
  source: string;
  value: unknown;
  occurredAt: string;
  hash: string;
}

export interface IntelligenceResult {
  id: string;
  tenantId: string;
  type: IntelligenceType;
  subjectId: string;
  timestamp: string;
  timeWindow?: { from: string; to: string };
  severity: Severity;
  confidence: number;
  score: number;
  summary: string;
  evidence: Evidence[];
  contributingSignals: Signal[];
  possibleCauses: Array<{ cause: string; confidence: number; evidenceIds: string[] }>;
  impact: { entities: string[]; score: number; summary: string };
  recommendations: Recommendation[];
  provenance: { source: string; model: string; version: string; hash: string };
  lineage: Array<{ source: string; transformation: string }>;
  policyContext: { authorizationRequired: boolean; authorized: false };
  traceId: string;
  model: { name: string; version: string };
  metadata?: Json;
}

export interface Recommendation {
  id: string;
  action: string;
  rationale: string;
  risk: Severity;
  requiresApproval: boolean;
  expectedOutcome?: string;
}

export interface DecisionRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  decision: string;
  evidenceIds: string[];
  action?: string;
  expectedOutcome?: string;
  actualOutcome?: string;
  outcomeStatus: "PENDING" | "MET" | "MISSED" | "PARTIAL" | "UNKNOWN";
  lesson?: string;
  createdAt: string;
  evaluatedAt?: string;
  traceId: string;
}

export interface Forecast {
  metric: string;
  subjectId: string;
  horizonMs: number;
  predictedValue: number;
  lowerBound: number;
  upperBound: number;
  confidence: number;
  assumptions: string[];
  sourceData: string[];
  uncertainty: number;
}

export interface AnalysisInput {
  context: AcieContext;
  observations: MetricObservation[];
  signals?: Array<{ type: string; value: number; severity?: Severity; summary?: string; source?: string }>;
  history?: MetricObservation[];
  dependencies?: Array<{ subjectId: string; dependsOn: string; health?: number }>;
  process?: Array<{ name: string; durationMs: number; waitMs?: number; retries?: number; failed?: boolean }>;
  costs?: Array<{ category: string; amount: number }>;
  resourceLimits?: Record<string, number>;
  now?: string;
}

export interface ClosedLoopResult {
  analysis: IntelligenceResult[];
  recommendations: Recommendation[];
  decision?: DecisionRecord;
  nextStep: "POLICY_SIORA_VALIDATION";
}

export interface AcieEventPayload {
  subjectId?: string;
  observations?: MetricObservation[];
  outcome?: Json;
  [key: string]: unknown;
}

export type AcieDomainEvent = EventEnvelope<AcieEventPayload>;