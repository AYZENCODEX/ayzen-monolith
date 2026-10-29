import { clamp, hash, id, iso } from "./store";
import type {
  AcieContext,
  AnalysisInput,
  Evidence,
  Forecast,
  IntelligenceResult,
  IntelligenceType,
  MetricObservation,
  Recommendation,
  Severity,
  Signal,
} from "./types";

const severity = (score: number): Severity => score >= 0.9 ? "CRITICAL" : score >= 0.7 ? "HIGH" : score >= 0.45 ? "MEDIUM" : score >= 0.2 ? "LOW" : "INFO";

export function evidence(kind: Evidence["kind"], source: string, value: unknown, occurredAt: string): Evidence {
  return { id: id("evidence"), kind, source, value, occurredAt, hash: hash({ kind, source, value, occurredAt }) };
}

export function baseline(points: MetricObservation[]): { mean: number; deviation: number; trend: number } {
  if (!points.length) return { mean: 0, deviation: 0, trend: 0 };
  const values = points.map((point) => point.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const first = values[0];
  const last = values[values.length - 1];
  return { mean, deviation: Math.sqrt(variance), trend: values.length > 1 ? (last - first) / (values.length - 1) : 0 };
}

export function signalFromObservation(context: AcieContext, observation: MetricObservation, base: { mean: number; deviation: number; trend: number }, source: string): Signal {
  const deviation = base.deviation > 0 ? Math.abs(observation.value - base.mean) / base.deviation : 0;
  const value = clamp(deviation / 4);
  return {
    id: id("signal"),
    tenantId: context.tenantId,
    subjectId: observation.subjectId,
    type: deviation >= 2 ? "ANOMALY" : "BEHAVIOR",
    value,
    severity: severity(value),
    confidence: clamp(0.55 + Math.min(0.4, observation.value === base.mean ? 0 : 0.1)),
    summary: deviation >= 2 ? `${observation.metric} deviates ${deviation.toFixed(2)} standard deviations from baseline` : `${observation.metric} is within the observed behavioral baseline`,
    evidenceIds: [],
    occurredAt: iso(observation.occurredAt),
    traceId: context.traceId,
    source,
  };
}

export function makeResult(
  context: AcieContext,
  type: IntelligenceType,
  subjectId: string,
  summary: string,
  score: number,
  evidenceItems: Evidence[],
  signals: Signal[],
  recommendations: Recommendation[] = [],
  options: { causes?: IntelligenceResult["possibleCauses"]; impact?: IntelligenceResult["impact"]; metadata?: Record<string, unknown> } = {},
): IntelligenceResult {
  const normalizedScore = clamp(score);
  const now = new Date().toISOString();
  return {
    id: id("result"),
    tenantId: context.tenantId,
    type,
    subjectId,
    timestamp: now,
    severity: severity(normalizedScore),
    confidence: clamp(evidenceItems.length ? 0.55 + Math.min(0.4, evidenceItems.length / 20) : 0.25),
    score: normalizedScore,
    summary,
    evidence: evidenceItems,
    contributingSignals: signals,
    possibleCauses: options.causes ?? [],
    impact: options.impact ?? { entities: [subjectId], score: normalizedScore, summary: normalizedScore > 0.6 ? "Potential operational impact requires review" : "No material impact detected" },
    recommendations,
    provenance: { source: "acie", model: "deterministic-statistical", version: "1.0.0", hash: hash({ type, subjectId, summary, score: normalizedScore, evidence: evidenceItems.map((item) => item.hash) }) },
    lineage: evidenceItems.map((item) => ({ source: item.source, transformation: `${type.toLowerCase()}-analysis@1.0.0` })),
    policyContext: { authorizationRequired: recommendations.some((recommendation) => recommendation.requiresApproval), authorized: false },
    traceId: context.traceId,
    model: { name: "deterministic-statistical", version: "1.0.0" },
    metadata: options.metadata,
  };
}

export function linearForecast(points: MetricObservation[], horizonMs: number): Forecast | undefined {
  if (!points.length || horizonMs < 1) return undefined;
  const ordered = [...points].sort((a, b) => iso(a.occurredAt).localeCompare(iso(b.occurredAt)));
  if (ordered.length === 1) {
    return { metric: ordered[0].metric, subjectId: ordered[0].subjectId, horizonMs, predictedValue: ordered[0].value, lowerBound: ordered[0].value, upperBound: ordered[0].value, confidence: 0.35, assumptions: ["The latest value persists"], sourceData: ordered.map((point) => point.id ?? point.metric), uncertainty: 0.65 };
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const elapsed = Math.max(1, new Date(iso(last.occurredAt)).getTime() - new Date(iso(first.occurredAt)).getTime());
  const slope = (last.value - first.value) / elapsed;
  const predictedValue = last.value + slope * horizonMs;
  const error = Math.max(Math.abs(predictedValue - last.value) * 0.25, Math.abs(slope * horizonMs) * 0.1, 0.01);
  return { metric: last.metric, subjectId: last.subjectId, horizonMs, predictedValue, lowerBound: predictedValue - error, upperBound: predictedValue + error, confidence: clamp(0.5 + Math.min(0.4, ordered.length / 20)), assumptions: ["Recent trend continues", "No unobserved step change occurs"], sourceData: ordered.map((point) => point.id ?? point.metric), uncertainty: clamp(error / Math.max(1, Math.abs(predictedValue))) };
}