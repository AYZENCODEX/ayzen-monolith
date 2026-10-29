import type {
  ConsentGrant,
  ConsentVersion,
  GraphEdge,
  GraphNode,
  LineageRecord,
  ProvenanceRecord,
  RebuildJob,
  SchemaVersion,
  SearchDocument,
  StoredTimeSeriesPoint,
} from "./types";

/**
 * The engine contracts are storage-agnostic. This store is intentionally
 * small and deterministic so the engines can be used by workers and tests
 * without opening a database connection. A database adapter can implement
 * the same collections without changing any engine contract.
 */
export class InMemoryNewEngineStore {
  readonly searchDocuments = new Map<string, SearchDocument & { indexedAt: string }>();
  readonly rebuildJobs = new Map<string, RebuildJob & { documents: SearchDocument[] }>();
  readonly graphNodes = new Map<string, GraphNode>();
  readonly graphEdges = new Map<string, GraphEdge>();
  readonly schemas = new Map<string, SchemaVersion[]>();
  readonly lineage = new Map<string, LineageRecord>();
  readonly provenance = new Map<string, ProvenanceRecord>();
  readonly timeSeries = new Map<string, StoredTimeSeriesPoint[]>();
  readonly consentVersions = new Map<string, ConsentVersion[]>();
  readonly consentGrants = new Map<string, ConsentGrant>();
}

export function documentKey(document: Pick<SearchDocument, "indexName" | "entityType" | "entityId">): string {
  return `${document.indexName}:${document.entityType}:${document.entityId}`;
}

export function edgeKey(edge: Pick<GraphEdge, "from" | "to" | "relationship">): string {
  return `${edge.from}:${edge.relationship}:${edge.to}`;
}

export function stableId(prefix: string, value: string): string {
  return `${prefix}_${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function iso(value: string | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date.toISOString();
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(",")}}`;
}