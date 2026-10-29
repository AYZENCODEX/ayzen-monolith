import type {
  ChangeDefinition,
  DecisionResult,
  DependencyEdge,
  DependencyNode,
  GeoContextEvent,
  GeoRegion,
  Geofence,
  OptimizationResult,
  RemediationAction,
  RemediationExecution,
  RemediationPolicy,
  TwinEvent,
  TwinProjection,
} from "./advanced-types";

export class AdvancedEngineStore {
  readonly regions = new Map<string, GeoRegion>();
  readonly geofences = new Map<string, Geofence>();
  readonly geoEvents = new Map<string, GeoContextEvent>();
  readonly dependencyNodes = new Map<string, DependencyNode>();
  readonly dependencyEdges = new Map<string, DependencyEdge>();
  readonly twinEvents = new Map<string, TwinEvent>();
  readonly twinProjections = new Map<string, TwinProjection>();
  readonly remediationActions = new Map<string, RemediationAction>();
  readonly remediationPolicies = new Map<string, RemediationPolicy>();
  readonly remediationExecutions = new Map<string, RemediationExecution>();
  readonly changes = new Map<string, ChangeDefinition>();
  readonly optimizationResults = new Map<string, OptimizationResult>();
  readonly decisions = new Map<string, DecisionResult>();
}