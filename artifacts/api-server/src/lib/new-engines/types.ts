import type { z } from "zod";

export type JsonObject = Record<string, unknown>;

export interface EngineActor {
  userId?: number;
  organizationId?: number;
  source?: string;
}

export interface SearchDocument {
  indexName: string;
  entityType: string;
  entityId: string;
  title?: string;
  text: string;
  fields?: JsonObject;
  permissions?: string[];
  version?: number;
  metadata?: JsonObject;
}

export interface SearchQuery {
  indexName: string;
  query?: string;
  entityType?: string;
  filters?: Record<string, string | number | boolean>;
  offset?: number;
  limit?: number;
  canRead?: (document: SearchDocument) => boolean;
}

export interface SearchHit extends SearchDocument {
  score: number;
  indexedAt: string;
}

export interface RebuildJob {
  id: string;
  indexName: string;
  indexVersion: number;
  total: number;
  processed: number;
  nextCursor: number;
  status: "PENDING" | "RUNNING" | "COMPLETED";
  createdAt: string;
  updatedAt: string;
}

export interface GraphNode {
  id: string;
  entityType: string;
  label?: string;
  properties?: JsonObject;
  sourceRefs: string[];
  version: number;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  properties?: JsonObject;
  sourceRefs: string[];
  version: number;
  updatedAt: string;
}

export interface GraphTraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface SchemaField {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  required?: boolean;
  nullable?: boolean;
}

export interface SchemaVersion {
  name: string;
  version: number;
  fields: Record<string, SchemaField>;
  metadata?: JsonObject;
  deprecatedAt?: string;
  migration?: JsonObject;
  createdAt: string;
}

export interface CompatibilityReport {
  compatible: boolean;
  breakingChanges: string[];
  warnings: string[];
}

export interface LineageRecord {
  id: string;
  runId?: string;
  source: { type: string; id: string };
  transformation?: { type: string; id: string; version?: number };
  destination: { type: string; id: string };
  schemaName?: string;
  schemaVersion?: number;
  retentionUntil?: string;
  metadata?: JsonObject;
  recordedAt: string;
}

export interface ProvenanceRecord {
  id: string;
  subject: { type: string; id: string };
  source?: string;
  actor?: EngineActor;
  action: string;
  decision?: string;
  evidence?: JsonObject;
  previousHash: string | null;
  hash: string;
  occurredAt: string;
}

export interface ProvenanceVerification {
  valid: boolean;
  checked: number;
  firstInvalidId?: string;
  reason?: string;
}

export interface TimeSeriesPoint {
  id?: string;
  series: string;
  timestamp: string | Date;
  value: number;
  tags?: Record<string, string>;
  metadata?: JsonObject;
}

export interface StoredTimeSeriesPoint extends Omit<TimeSeriesPoint, "timestamp"> {
  id: string;
  timestamp: string;
}

export interface TimeSeriesQuery {
  series: string;
  from?: string | Date;
  to?: string | Date;
  tags?: Record<string, string>;
  limit?: number;
}

export interface TimeSeriesAggregate {
  bucketStart: string;
  bucketEnd: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
}

export interface ConsentVersion {
  consentType: string;
  version: number;
  purpose: string;
  policyUri?: string;
  requiredScopes: string[];
  createdAt: string;
  deprecatedAt?: string;
}

export interface ConsentGrant {
  id: string;
  subjectId: string;
  organizationId?: number;
  consentType: string;
  version: number;
  scopes: string[];
  grantedAt: string;
  expiresAt?: string;
  withdrawnAt?: string;
  actor?: EngineActor;
  metadata?: JsonObject;
}

export interface ConsentCheck {
  granted: boolean;
  grant?: ConsentGrant;
  reason: "ACTIVE" | "NOT_FOUND" | "WITHDRAWN" | "EXPIRED" | "SCOPE_MISSING";
}

export type SchemaValidator = z.ZodType<JsonObject>;