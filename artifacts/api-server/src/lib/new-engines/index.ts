import { ConsentEngine } from "./consent";
import { KnowledgeGraphEngine } from "./graph";
import { DataLineageEngine } from "./lineage";
import { ProvenanceEngine } from "./provenance";
import { SchemaRegistryEngine } from "./schema-registry";
import { SearchIndexEngine } from "./search";
import { InMemoryNewEngineStore } from "./store";
import { TimeSeriesEngine } from "./time-series";
import { AdvancedEngineStore } from "./advanced-store";
import { DecisionIntelligenceEngine } from "./decision";
import { DependencyGraphEngine, DependencyResolutionEngine } from "./dependency";
import { DigitalTwinEngine } from "./digital-twin";
import { GeoIntelligenceEngine } from "./geo";
import { ImpactAnalysisEngine } from "./impact";
import { OptimizationEngine } from "./optimization";
import { RemediationEngine } from "./remediation";

export * from "./types";
export * from "./store";
export * from "./search";
export * from "./graph";
export * from "./schema-registry";
export * from "./lineage";
export * from "./provenance";
export * from "./time-series";
export * from "./consent";
export * from "./advanced-types";
export * from "./advanced-store";
export * from "./geo";
export * from "./dependency";
export * from "./digital-twin";
export * from "./remediation";
export * from "./impact";
export * from "./optimization";
export * from "./decision";

export const newEngineStore = new InMemoryNewEngineStore();
export const searchIndexEngine = new SearchIndexEngine(newEngineStore);
export const knowledgeGraphEngine = new KnowledgeGraphEngine(newEngineStore);
export const schemaRegistryEngine = new SchemaRegistryEngine(newEngineStore);
export const dataLineageEngine = new DataLineageEngine(newEngineStore);
export const provenanceEngine = new ProvenanceEngine(newEngineStore);
export const timeSeriesEngine = new TimeSeriesEngine(newEngineStore);
export const consentEngine = new ConsentEngine(newEngineStore);
export const advancedEngineStore = new AdvancedEngineStore();
export const geoIntelligenceEngine = new GeoIntelligenceEngine(advancedEngineStore);
export const dependencyGraphEngine = new DependencyGraphEngine(advancedEngineStore);
export const dependencyResolutionEngine = new DependencyResolutionEngine(dependencyGraphEngine, advancedEngineStore);
export const digitalTwinEngine = new DigitalTwinEngine(advancedEngineStore);
export const remediationEngine = new RemediationEngine(advancedEngineStore);
export const impactAnalysisEngine = new ImpactAnalysisEngine(dependencyGraphEngine, advancedEngineStore);
export const optimizationEngine = new OptimizationEngine(advancedEngineStore);
export const decisionIntelligenceEngine = new DecisionIntelligenceEngine(advancedEngineStore);

export const newEngines = {
  search: searchIndexEngine,
  graph: knowledgeGraphEngine,
  schemas: schemaRegistryEngine,
  lineage: dataLineageEngine,
  provenance: provenanceEngine,
  timeSeries: timeSeriesEngine,
  consent: consentEngine,
  geo: geoIntelligenceEngine,
  dependencyGraph: dependencyGraphEngine,
  dependencyResolution: dependencyResolutionEngine,
  digitalTwin: digitalTwinEngine,
  remediation: remediationEngine,
  impact: impactAnalysisEngine,
  optimization: optimizationEngine,
  decision: decisionIntelligenceEngine,
};