import type { EngineActor, GraphEdge, GraphNode, JsonObject, ProvenanceRecord } from "./types";

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoRegion {
  id: string;
  name: string;
  polygon: GeoPoint[];
  metadata?: JsonObject;
}

export interface Geofence {
  id: string;
  name: string;
  regionId: string;
  enter?: boolean;
  exit?: boolean;
  metadata?: JsonObject;
}

export interface GeoContextEvent {
  id: string;
  subjectId: string;
  point: GeoPoint;
  regionIds: string[];
  geofenceEvents: Array<"ENTER" | "EXIT">;
  occurredAt: string;
}

export interface DependencyNode extends GraphNode {
  owner?: string;
  dependencyVersion?: string;
}

export interface DependencyEdge extends GraphEdge {
  constraint?: string;
  optional?: boolean;
}

export interface DependencyPlan {
  id: string;
  nodes: string[];
  orderedNodes: string[];
  conflicts: string[];
  cycles: string[][];
  reproducibilityKey: string;
}

export interface TwinProjection {
  id: string;
  aggregateType: string;
  aggregateId: string;
  version: number;
  state: JsonObject;
  lastEventId?: string;
  updatedAt: string;
}

export interface TwinEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  payload: JsonObject;
  occurredAt: string;
}

export type RemediationRisk = "LOW" | "MEDIUM" | "HIGH";

export interface RemediationAction {
  id: string;
  name: string;
  risk: RemediationRisk;
  execute: (context: JsonObject) => Promise<JsonObject> | JsonObject;
  compensate?: (context: JsonObject, result: JsonObject) => Promise<void> | void;
}

export interface RemediationPolicy {
  id: string;
  actionId: string;
  approved: boolean;
  requiresApproval: boolean;
  maxExecutions: number;
  windowMs: number;
}

export interface RemediationExecution {
  id: string;
  actionId: string;
  policyId: string;
  status: "DRY_RUN" | "PENDING_APPROVAL" | "COMPLETED" | "FAILED";
  actor?: EngineActor;
  context: JsonObject;
  result?: JsonObject;
  error?: string;
  createdAt: string;
}

export interface ChangeDefinition {
  id: string;
  nodeIds: string[];
  description?: string;
  metadata?: JsonObject;
}

export interface ImpactResult {
  changeId: string;
  direct: string[];
  transitive: string[];
  affectedTypes: Record<string, number>;
  riskScore: number;
  sourceReferences: string[];
}

export interface OptimizationObjective {
  name: string;
  direction: "minimize" | "maximize";
  weight: number;
}

export interface OptimizationCandidate {
  id: string;
  plan: JsonObject;
  metrics: Record<string, number>;
  violations: string[];
}

export interface OptimizationResult {
  candidates: OptimizationCandidate[];
  selected?: OptimizationCandidate;
  reproducibilityKey: string;
  explanation: string[];
}

export interface DecisionEvidence {
  id: string;
  source: string;
  value: unknown;
  weight: number;
  occurredAt?: string;
  provenance?: ProvenanceRecord;
}

export interface DecisionResult {
  id: string;
  outcome: string;
  confidence: number;
  evidence: DecisionEvidence[];
  conflicts: string[];
  explanation: string[];
  contextHash: string;
  authorizationRequired: boolean;
  createdAt: string;
}