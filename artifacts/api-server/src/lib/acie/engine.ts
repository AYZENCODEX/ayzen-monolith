import type { EventEnvelope } from "../event-bus";
import { baseline, evidence, linearForecast, makeResult, signalFromObservation } from "./analysis";
import { InMemoryAcieRepository, clamp, hash, id, iso } from "./store";
import type {
  AcieContext,
  AcieDomainEvent,
  AnalysisInput,
  ClosedLoopResult,
  DecisionRecord,
  Forecast,
  IntelligenceResult,
  MetricObservation,
  Recommendation,
  Signal,
} from "./types";

export class AcieEngine {
  constructor(readonly repository = new InMemoryAcieRepository()) {}

  ingest(event: AcieDomainEvent): IntelligenceResult[] {
    if (this.repository.processedEvents.has(event.id)) return [];
    this.repository.processedEvents.add(event.id);
    const context = this.contextFromEvent(event);
    const observations = event.payload.observations ?? (typeof event.payload.value === "number" && event.payload.subjectId ? [{
      subjectId: event.payload.subjectId,
      metric: event.type,
      value: event.payload.value,
      occurredAt: event.occurredAt,
      metadata: event.payload,
    }] : []);
    return observations.length ? this.analyze({ context, observations, now: event.occurredAt }) : [];
  }

  analyze(input: AnalysisInput): IntelligenceResult[] {
    const context = input.context;
    const observations = input.observations.map((observation) => ({ ...observation, occurredAt: iso(observation.occurredAt ?? input.now) }));
    if (!observations.length) return [];
    const history = [...(input.history ?? []), ...observations];
    const results: IntelligenceResult[] = [];
    const allSignals: Signal[] = [];

    for (const observation of observations) {
      const subjectHistory = history.filter((point) => point.subjectId === observation.subjectId && point.metric === observation.metric && iso(point.occurredAt) < iso(observation.occurredAt));
      const stats = baseline(subjectHistory);
      const signal = signalFromObservation(context, observation, stats, "observation");
      signal.evidenceIds = [observation.id ?? `${observation.metric}:${observation.occurredAt}`];
      this.repository.signals.set(signal.id, signal);
      allSignals.push(signal);

      const observationEvidence = [evidence("OBSERVATION", observation.metric, observation, observation.occurredAt)];
      results.push(makeResult(context, "BEHAVIOR", observation.subjectId, `${observation.metric} behavioral baseline is ${stats.mean.toFixed(2)}`, clamp(Math.abs(stats.trend) / Math.max(1, Math.abs(stats.mean))), observationEvidence, [signal], [{
        id: id("recommendation"),
        action: "Continue monitoring",
        rationale: "Behavioral baselines are advisory and require more context before intervention",
        risk: "LOW",
        requiresApproval: false,
      }], { metadata: { mean: stats.mean, deviation: stats.deviation, trend: stats.trend } }));
      if (subjectHistory.length >= 2) {
        results.push(makeResult(context, "PATTERN", observation.subjectId, `${observation.metric} recurs across ${subjectHistory.length + 1} observations`, clamp((subjectHistory.length + 1) / 10), subjectHistory.map((point) => evidence("HISTORY", point.metric, point, iso(point.occurredAt))), [signal], [], {
          metadata: { recurrenceCount: subjectHistory.length + 1, cadence: "observed-history" },
        }));
      }
      if (signal.type === "ANOMALY") {
        results.push(makeResult(context, "ANOMALY", observation.subjectId, signal.summary, signal.value, observationEvidence, [signal], [{
          id: id("recommendation"),
          action: "Investigate the anomaly and validate the source data",
          rationale: "Anomaly detection identifies deviation; it does not establish causation or authorize remediation",
          risk: signal.severity,
          requiresApproval: signal.severity === "HIGH" || signal.severity === "CRITICAL",
        }]));
      }
    }

    const bySubject = new Map<string, Signal[]>();
    for (const signal of allSignals) bySubject.set(signal.subjectId, [...(bySubject.get(signal.subjectId) ?? []), signal]);
    for (const [subjectId, signals] of bySubject) {
      const inputSignals = [...signals, ...(input.signals ?? []).map((signal) => ({
        id: id("signal"),
        tenantId: context.tenantId,
        subjectId,
        type: signal.type,
        value: clamp(signal.value),
        severity: signal.severity ?? "INFO",
        confidence: 0.6,
        summary: signal.summary ?? signal.type,
        evidenceIds: [],
        occurredAt: input.now ?? new Date().toISOString(),
        traceId: context.traceId,
        source: signal.source ?? "caller",
      } as Signal))];
      if (inputSignals.length > 1) {
        const score = clamp(inputSignals.reduce((sum, signal) => sum + signal.value * signal.confidence, 0) / inputSignals.length);
        const fusedEvidence = inputSignals.flatMap((signal) => signal.evidenceIds).map((idValue) => evidence("MODEL", signalSource(inputSignals, idValue), idValue, input.now ?? new Date().toISOString()));
        results.push(makeResult(context, "FUSED_SIGNAL", subjectId, `${inputSignals.length} signals fused into a contextual assessment`, score, fusedEvidence, inputSignals, [{
          id: id("recommendation"),
          action: "Review the combined signal context",
          rationale: "Multiple signals increase context but do not convert correlation into causation",
          risk: severityFromScore(score),
          requiresApproval: false,
        }]));
        results.push(makeResult(context, "CAUSAL", subjectId, "Candidate causes are ranked from contributing signals; correlation is not treated as causation", score, fusedEvidence, inputSignals, [], {
          causes: inputSignals
            .sort((a, b) => b.value * b.confidence - a.value * a.confidence)
            .slice(0, 3)
            .map((signal) => ({ cause: signal.summary, confidence: clamp(signal.value * signal.confidence), evidenceIds: signal.evidenceIds })),
          metadata: { alternativesRequired: true, causalStatus: "CANDIDATE_ONLY" },
        }));
      }
    }

    const subjectIds = [...new Set(observations.map((observation) => observation.subjectId))];
    for (const subjectId of subjectIds) {
      const subjectPoints = history.filter((point) => point.subjectId === subjectId);
      const forecast = linearForecast(subjectPoints, 60 * 60 * 1000);
      if (forecast) {
        const subjectSignals = allSignals.filter((signal) => signal.subjectId === subjectId);
        results.push(this.forecastResult(context, forecast, subjectPoints, subjectSignals));
        const latest = subjectPoints.at(-1);
        if (latest && Math.abs(forecast.predictedValue - latest.value) > Math.max(Math.abs(latest.value) * 0.25, 1)) {
          results.push(makeResult(context, "MAINTENANCE", subjectId, `${latest.metric} shows an early degradation indicator`, clamp(Math.abs(forecast.predictedValue - latest.value) / Math.max(1, Math.abs(latest.value))), subjectPoints.map((point) => evidence("HISTORY", point.metric, point, iso(point.occurredAt))), subjectSignals, [{
            id: id("recommendation"),
            action: "Schedule a diagnostic review before service degradation",
            rationale: "Predictive maintenance identifies an early indicator; it does not trigger an autonomous change",
            risk: "HIGH",
            requiresApproval: true,
            expectedOutcome: "A validated diagnostic separates telemetry drift from a real maintenance need",
          }], { metadata: { forecast, trigger: "trend-degradation" } }));
        }
      }
    }
    if (input.dependencies?.length) results.push(...this.riskResults(context, input, allSignals));
    if (input.process?.length) results.push(this.processResult(context, input));
    if (input.costs?.length || input.resourceLimits) {
      results.push(this.resourceResult(context, input, observations, allSignals));
      if (input.costs?.length) results.push(this.costResult(context, input));
    }
    return results.map((result) => this.save(result));
  }

  recordOutcome(context: AcieContext, input: { decisionId: string; actualOutcome?: string; status?: DecisionRecord["outcomeStatus"] }): DecisionRecord {
    const decision = this.repository.decisions.get(input.decisionId);
    if (!decision || decision.tenantId !== context.tenantId) throw new Error("Decision not found");
    decision.actualOutcome = input.actualOutcome;
    decision.outcomeStatus = input.status ?? "UNKNOWN";
    decision.evaluatedAt = new Date().toISOString();
    decision.lesson = decision.outcomeStatus === "MET" ? "The selected action met its expected outcome in this context" : "Review evidence, assumptions, and environmental changes before repeating this decision";
    return decision;
  }

  recordDecision(context: AcieContext, input: { subjectId: string; decision: string; evidenceIds?: string[]; action?: string; expectedOutcome?: string }): DecisionRecord {
    const decision: DecisionRecord = { id: id("decision"), tenantId: context.tenantId, subjectId: input.subjectId, decision: input.decision, evidenceIds: input.evidenceIds ?? [], action: input.action, expectedOutcome: input.expectedOutcome, outcomeStatus: "PENDING", createdAt: new Date().toISOString(), traceId: context.traceId };
    this.repository.decisions.set(decision.id, decision);
    return decision;
  }

  strategic(context: AcieContext, results?: IntelligenceResult[]): IntelligenceResult {
    const visible = (results ?? this.listResults(context.tenantId)).filter((result) => result.tenantId === context.tenantId);
    const grouped = new Map<string, IntelligenceResult>();
    for (const result of visible) grouped.set(result.type, result);
    const score = visible.length ? clamp(visible.reduce((sum, result) => sum + result.score, 0) / visible.length) : 0;
    const recommendations: Recommendation[] = [];
    if (score >= 0.6) recommendations.push({ id: id("recommendation"), action: "Prioritize an operator investigation", rationale: "Strategic score indicates multiple active intelligence concerns", risk: "HIGH", requiresApproval: true });
    const strategic = makeResult(context, "STRATEGIC", "system", `Strategic context aggregates ${visible.length} intelligence result(s) across ${grouped.size} module(s)`, score, visible.flatMap((result) => result.evidence).slice(0, 100), visible.flatMap((result) => result.contributingSignals).slice(0, 100), recommendations, {
      impact: { entities: [...new Set(visible.map((result) => result.subjectId))], score, summary: "Advisory system-level context; Policy/PEP and SIORA remain the control boundary" },
      metadata: { moduleTypes: [...grouped.keys()], emergingConcerns: visible.filter((result) => result.score >= 0.6).map((result) => result.summary) },
    });
    return this.save(strategic);
  }

  closeLoop(input: AnalysisInput & { decision?: { decision: string; action?: string; expectedOutcome?: string } }): ClosedLoopResult {
    const analysis = this.analyze(input);
    const recommendations = analysis.flatMap((result) => result.recommendations);
    const decision = input.decision ? this.recordDecision(input.context, { subjectId: input.observations[0]?.subjectId ?? "system", ...input.decision, evidenceIds: analysis.flatMap((result) => result.evidence.map((item) => item.id)) }) : undefined;
    return { analysis, recommendations, decision, nextStep: "POLICY_SIORA_VALIDATION" };
  }

  listResults(tenantId: string, subjectId?: string): IntelligenceResult[] {
    return [...this.repository.results.values()].filter((result) => result.tenantId === tenantId && (!subjectId || result.subjectId === subjectId)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  health(): Record<string, unknown> {
    return { name: "ACIE", version: "1.0.0", modules: ["pattern", "behavior", "anomaly", "signal-fusion", "causal", "risk", "resource", "cost", "capacity", "process", "forecast", "maintenance", "decision-learning", "strategic", "closed-loop"], results: this.repository.results.size, signals: this.repository.signals.size, decisions: this.repository.decisions.size, processedEvents: this.repository.processedEvents.size, authorizationBoundary: "Policy/PEP + SIORA", status: "ready" };
  }

  private save(result: IntelligenceResult): IntelligenceResult {
    this.repository.results.set(result.id, result);
    this.repository.tenantOfResult.set(result.id, result.tenantId);
    return result;
  }

  private forecastResult(context: AcieContext, forecast: Forecast, points: MetricObservation[], signals: Signal[]): IntelligenceResult {
    const forecastEvidence = points.map((point) => evidence("HISTORY", point.metric, point, iso(point.occurredAt)));
    return makeResult(context, "FORECAST", forecast.subjectId, `${forecast.metric} is forecast at ${forecast.predictedValue.toFixed(2)} over the next ${Math.round(forecast.horizonMs / 60000)} minutes`, clamp(forecast.uncertainty), forecastEvidence, signals, [{
      id: id("recommendation"),
      action: "Review forecast assumptions before capacity or cost changes",
      rationale: `Forecast confidence is ${(forecast.confidence * 100).toFixed(0)}%; uncertainty is ${(forecast.uncertainty * 100).toFixed(0)}%`,
      risk: "MEDIUM",
      requiresApproval: false,
      expectedOutcome: "A validated forecast informs planning without directly changing production state",
    }], { metadata: { forecast } });
  }

  private riskResults(context: AcieContext, input: AnalysisInput, signals: Signal[]): IntelligenceResult[] {
    return input.dependencies!.filter((dependency) => dependency.health !== undefined && dependency.health < 0.7).map((dependency) => {
      const score = clamp(1 - (dependency.health ?? 0));
      const item = evidence("GRAPH", "dependency-graph", dependency, input.now ?? new Date().toISOString());
      return makeResult(context, "RISK", dependency.subjectId, `Dependency ${dependency.dependsOn} reports reduced health`, score, [item], signals.filter((signal) => signal.subjectId === dependency.subjectId), [{
        id: id("recommendation"),
        action: "Inspect the dependency and prepare a controlled mitigation",
        rationale: "Dependency health is a risk signal, not an authorization decision",
        risk: severityFromScore(score),
        requiresApproval: score >= 0.7,
      }], { impact: { entities: [dependency.subjectId, dependency.dependsOn], score, summary: "Potential transitive dependency impact" } });
    });
  }

  private processResult(context: AcieContext, input: AnalysisInput): IntelligenceResult {
    const process = input.process!;
    const avgWait = process.reduce((sum, step) => sum + (step.waitMs ?? 0), 0) / process.length;
    const failures = process.filter((step) => step.failed).length;
    const retries = process.reduce((sum, step) => sum + (step.retries ?? 0), 0);
    const score = clamp((failures / process.length) * 0.6 + Math.min(1, avgWait / 60000) * 0.25 + Math.min(1, retries / process.length) * 0.15);
    return makeResult(context, "PROCESS", "workflow", `Process analysis found ${failures} failure(s), ${retries} retry(ies), and ${Math.round(avgWait)}ms average waiting time`, score, [evidence("HISTORY", "workflow", process, input.now ?? new Date().toISOString())], [], [{
      id: id("recommendation"),
      action: "Investigate the highest-wait or highest-retry process step",
      rationale: "Cycle time and retry concentration identify bottleneck candidates",
      risk: severityFromScore(score),
      requiresApproval: false,
    }], { metadata: { averageWaitMs: avgWait, failures, retries } });
  }

  private resourceResult(context: AcieContext, input: AnalysisInput, observations: MetricObservation[], signals: Signal[]): IntelligenceResult {
    const resourceSignals = observations.filter((observation) => input.resourceLimits?.[observation.metric] !== undefined).map((observation) => {
      const limit = input.resourceLimits![observation.metric];
      return { observation, utilization: limit > 0 ? observation.value / limit : 0 };
    });
    const usageScore = resourceSignals.length ? clamp(Math.max(...resourceSignals.map((item) => item.utilization))) : 0;
    const cost = (input.costs ?? []).reduce((sum, item) => sum + item.amount, 0);
    const detail = resourceSignals.length ? `${Math.round(usageScore * 100)}% peak resource utilization` : `${cost.toFixed(2)} total attributed cost`;
    return makeResult(context, usageScore >= 0.8 ? "CAPACITY" : "RESOURCE", "system", `${detail} across the analyzed window`, usageScore || clamp(cost / 1000), resourceSignals.map((item) => evidence("OBSERVATION", item.observation.metric, item, iso(item.observation.occurredAt))), signals, [{
      id: id("recommendation"),
      action: usageScore >= 0.8 ? "Review capacity headroom" : "Review cost attribution and optimization opportunities",
      rationale: "Resource and cost intelligence are advisory planning inputs",
      risk: usageScore >= 0.8 ? "HIGH" : "LOW",
      requiresApproval: false,
    }], { metadata: { cost, resourceSignals } });
  }

  private costResult(context: AcieContext, input: AnalysisInput): IntelligenceResult {
    const costs = input.costs ?? [];
    const total = costs.reduce((sum, item) => sum + item.amount, 0);
    const byCategory = costs.reduce<Record<string, number>>((totals, item) => ({ ...totals, [item.category]: (totals[item.category] ?? 0) + item.amount }), {});
    const largest = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
    const score = clamp(total / 1000);
    return makeResult(context, "COST", "system", `Cost intelligence attributed ${total.toFixed(2)} across ${Object.keys(byCategory).length} categor(ies)`, score, [evidence("HISTORY", "cost-input", costs, input.now ?? new Date().toISOString())], [], [{
      id: id("recommendation"),
      action: "Review the largest cost driver and validate its attribution",
      rationale: largest ? `${largest[0]} contributes ${largest[1].toFixed(2)} to the analyzed window` : "No cost category was provided",
      risk: "LOW",
      requiresApproval: false,
    }], { metadata: { total, byCategory, largestCategory: largest?.[0] } });
  }

  private contextFromEvent(event: EventEnvelope<unknown>): AcieContext {
    return { tenantId: String(event.actor?.organizationId ?? `user:${event.actor?.userId ?? "system"}`), actorId: event.actor?.userId, traceId: event.traceId ?? event.id, correlationId: event.correlationId, source: event.type };
  }
}

function signalSource(signals: Signal[], evidenceId: string): string {
  return signals.find((signal) => signal.evidenceIds.includes(evidenceId))?.source ?? "signal-fusion";
}

function severityFromScore(score: number): "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  return score >= 0.9 ? "CRITICAL" : score >= 0.7 ? "HIGH" : score >= 0.45 ? "MEDIUM" : score >= 0.2 ? "LOW" : "INFO";
}

export const acieEngine = new AcieEngine();