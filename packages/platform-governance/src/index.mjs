import crypto from "node:crypto";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LIFECYCLE_STATES = new Set(["DRAFT", "READY", "ACTIVE", "PAUSED", "DEPRECATED", "QUARANTINED"]);
const VALID_TRANSITIONS = new Map([
  ["DRAFT", new Set(["READY", "DEPRECATED"])],
  ["READY", new Set(["ACTIVE", "DRAFT", "DEPRECATED"])],
  ["ACTIVE", new Set(["PAUSED", "DEPRECATED", "QUARANTINED"])],
  ["PAUSED", new Set(["ACTIVE", "DEPRECATED", "QUARANTINED"])],
  ["QUARANTINED", new Set(["PAUSED", "DEPRECATED"])],
  ["DEPRECATED", new Set()],
]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function assertIdentifier(value, label = "Identifier") {
  const normalized = requiredString(value, label);
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function stringList(value, label, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must contain at least ${min} non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export function validateServiceDefinition(definition = {}) {
  const service = {
    id: assertIdentifier(definition.id, "Service id"),
    owner: assertIdentifier(definition.owner, "Service owner"),
    app: assertIdentifier(definition.app ?? definition.owner, "Service app"),
    kind: requiredString(definition.kind, "Service kind"),
    source: requiredString(definition.source, "Service source"),
    version: requiredString(definition.version ?? "1.0.0", "Service version"),
    port: definition.port,
    health: requiredString(definition.health, "Service health"),
    readiness: requiredString(definition.readiness, "Service readiness"),
    deploymentTarget: requiredString(definition.deploymentTarget, "Service deployment target"),
    dependencies: stringList(definition.dependencies ?? [] , "Service dependencies"),
    ownedResources: stringList(definition.ownedResources ?? [], "Service owned resources"),
    emittedEvents: stringList(definition.emittedEvents ?? [], "Service emitted events"),
    consumedEvents: stringList(definition.consumedEvents ?? [], "Service consumed events"),
    lifecycle: definition.lifecycle ?? "ACTIVE",
  };
  if (!Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error(`${service.id}: invalid port`);
  if (!LIFECYCLE_STATES.has(service.lifecycle)) throw new Error(`${service.id}: invalid lifecycle`);
  return Object.freeze(service);
}

export function validateEventContract(contract = {}) {
  const result = {
    id: assertIdentifier(contract.id ?? contract.eventType, "Event id"),
    eventType: requiredString(contract.eventType ?? contract.id, "Event type"),
    version: contract.version ?? contract.schemaVersion ?? 1,
    producer: assertIdentifier(contract.producer, "Event producer"),
    consumers: stringList(contract.consumers ?? contract.consumerGroups, "Event consumers", { min: 1 }),
    delivery: requiredString(contract.delivery ?? "at-least-once", "Event delivery"),
    idempotencyKey: requiredString(contract.idempotencyKey ?? "eventId", "Event idempotency key"),
    securityScope: requiredString(contract.securityScope ?? "tenant", "Event security scope"),
    failurePolicy: requiredString(contract.failurePolicy ?? "retry-dlq", "Event failure policy"),
    audit: contract.audit !== false,
  };
  if (!Number.isSafeInteger(result.version) || result.version < 1) throw new Error(`${result.id}: invalid event version`);
  if (!["at-least-once", "at-most-once"].includes(result.delivery)) throw new Error(`${result.id}: unsupported delivery semantics`);
  if (!result.audit) throw new Error(`${result.id}: audit is required`);
  return Object.freeze(result);
}

export function validateWorkflowContract(workflow = {}) {
  const result = {
    id: assertIdentifier(workflow.id, "Workflow id"),
    owner: assertIdentifier(workflow.owner, "Workflow owner"),
    trigger: requiredString(workflow.trigger, "Workflow trigger"),
    input: requiredString(workflow.input ?? "object", "Workflow input"),
    steps: stringList(workflow.steps, "Workflow steps", { min: 1 }),
    dependencies: stringList(workflow.dependencies ?? [], "Workflow dependencies"),
    retryPolicy: workflow.retryPolicy ?? { maxAttempts: 3, backoff: "exponential" },
    timeoutMs: workflow.timeoutMs ?? 86_400_000,
    compensation: requiredString(workflow.compensation ?? "operator-recovery", "Workflow compensation"),
    completionEvent: requiredString(workflow.completionEvent, "Workflow completion event"),
    policy: requiredString(workflow.policy ?? workflow.requiresPolicy, "Workflow policy"),
  };
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 100 || result.timeoutMs > 7 * 86_400_000) throw new Error(`${result.id}: invalid timeout`);
  if (!Number.isSafeInteger(result.retryPolicy.maxAttempts) || result.retryPolicy.maxAttempts < 0 || result.retryPolicy.maxAttempts > 10) throw new Error(`${result.id}: invalid retry policy`);
  return Object.freeze(result);
}

export function validateScheduleDefinition(schedule = {}) {
  const result = {
    id: assertIdentifier(schedule.id, "Schedule id"),
    owner: assertIdentifier(schedule.owner, "Schedule owner"),
    trigger: requiredString(schedule.trigger, "Schedule trigger"),
    lease: requiredString(schedule.lease ?? schedule.leaseKey, "Schedule lease"),
    idempotency: requiredString(schedule.idempotency ?? "scheduled-run-id", "Schedule idempotency"),
    targetWorkflow: assertIdentifier(schedule.targetWorkflow, "Schedule target workflow"),
    missedRunPolicy: requiredString(schedule.missedRunPolicy ?? "skip", "Schedule missed-run policy"),
    lifecycle: schedule.lifecycle ?? "ACTIVE",
  };
  if (!["skip", "run-once", "catch-up"].includes(result.missedRunPolicy)) throw new Error(`${result.id}: invalid missed-run policy`);
  if (!LIFECYCLE_STATES.has(result.lifecycle)) throw new Error(`${result.id}: invalid lifecycle`);
  return Object.freeze(result);
}

export function validateNotificationContract(notification = {}) {
  const result = {
    id: assertIdentifier(notification.id, "Notification id"),
    owner: assertIdentifier(notification.owner, "Notification owner"),
    source: requiredString(notification.source ?? notification.sourceEvent, "Notification source"),
    recipientScope: requiredString(notification.recipientScope, "Notification recipient scope"),
    channel: requiredString(notification.channel, "Notification channel"),
    policy: requiredString(notification.policy, "Notification policy"),
    template: requiredString(notification.template, "Notification template"),
    deliveryState: requiredString(notification.deliveryState ?? "queued-sent-failed", "Notification delivery state"),
    retry: notification.retry ?? { maxAttempts: 3, fallback: "none" },
  };
  return Object.freeze(result);
}

export function validatePolicyContext(context = {}) {
  const result = {
    subject: assertIdentifier(context.subject, "Policy subject"),
    actorType: requiredString(context.actorType ?? "user", "Policy actor type"),
    app: assertIdentifier(context.app, "Policy app"),
    action: assertIdentifier(context.action, "Policy action"),
    resource: assertIdentifier(context.resource, "Policy resource"),
    decision: context.decision ?? "deny",
    scopes: stringList(context.scopes ?? [], "Policy scopes"),
    traceId: requiredString(context.traceId ?? crypto.randomUUID(), "Policy trace id"),
    audit: context.audit !== false,
  };
  if (!["allow", "deny"].includes(result.decision)) throw new Error("Policy decision must be allow or deny");
  if (!result.audit) throw new Error("Policy decisions require audit");
  return Object.freeze(result);
}

export function validateLifecycleTransition(from, to) {
  if (!LIFECYCLE_STATES.has(from) || !LIFECYCLE_STATES.has(to)) throw new Error("Unknown lifecycle state");
  if (!VALID_TRANSITIONS.get(from).has(to)) throw new Error(`Invalid lifecycle transition: ${from} -> ${to}`);
  return true;
}

const DEFAULT_CONDITIONAL_CONDITIONS = Object.freeze([
  Object.freeze({ code: "POLICY_CONDITIONAL", description: "This action is allowed only once the policy's declared condition is satisfied." }),
]);

/**
 * Phase 07 ("Unified Policy Decision Contract") — additive extension, not a
 * rewrite: through Phase 06 a policy entry could only ever resolve to
 * `true` (allow) or anything else (deny), because that was every caller's
 * only need at the time. The roadmap's Phase 07 verification line ("Allow/
 * deny/conditional regression suite") needs a third outcome to exist
 * somewhere, and this PDP is the one place every {app -> {action ->
 * policy}} decision already funnels through — so a policy entry (or a
 * policy function's return value) may now also be the string
 * `"conditional"`, or an object `{ decision: "conditional", conditions,
 * reason }`, in addition to the boolean it already supported. A `true`
 * policy and a boolean-returning policy function behave exactly as before
 * (Phase 06's own tests, unmodified, still pass — see
 * tests/policy/platform-policy.test.mjs); the new `conditions` field on
 * the returned decision is `[]` for allow/deny, matching schemas/policy/
 * decision.v1.json's Phase 07 addition.
 */
export function createPolicyDecisionPoint({ policies = {}, audit = () => {} } = {}) {
  const decisions = [];
  function decide(input = {}) {
    const base = {
      subject: input.subject ?? "anonymous",
      actorType: input.actorType ?? "user",
      app: input.app,
      action: input.action,
      resource: input.resource,
      scopes: input.scopes ?? [],
      traceId: input.traceId ?? crypto.randomUUID(),
    };
    const policy = policies[input.app]?.[input.action] ?? policies[input.action];
    const evaluated = typeof policy === "function" ? policy(base) : policy;
    let decisionValue = "deny";
    let conditions = [];
    if (evaluated === true) {
      decisionValue = "allow";
    } else if (evaluated === "conditional" || (evaluated && typeof evaluated === "object" && evaluated.decision === "conditional")) {
      decisionValue = "conditional";
      conditions = Array.isArray(evaluated?.conditions) && evaluated.conditions.length ? evaluated.conditions : DEFAULT_CONDITIONAL_CONDITIONS;
    }
    const reason = decisionValue === "allow" ? "POLICY_MATCH" : decisionValue === "conditional" ? "POLICY_CONDITIONAL" : "DEFAULT_DENY";
    const decision = { ...base, decision: decisionValue, reason, conditions, audit: true, evaluatedAt: new Date().toISOString() };
    decisions.push(decision);
    audit(decision);
    return Object.freeze(decision);
  }
  return Object.freeze({ decide, decisions: () => [...decisions] });
}

export function createIntegrationGraph({ nodes = [], edges = [] } = {}) {
  const nodeMap = new Map();
  const edgeList = [];
  for (const node of nodes) {
    const id = assertIdentifier(node.id, "Graph node id");
    if (nodeMap.has(id)) throw new Error(`Duplicate graph node: ${id}`);
    nodeMap.set(id, Object.freeze({ ...node, id, lifecycle: node.lifecycle ?? "ACTIVE" }));
  }
  for (const edge of edges) {
    const from = assertIdentifier(edge.from, "Graph edge source");
    const to = assertIdentifier(edge.to, "Graph edge target");
    const item = Object.freeze({ ...edge, id: edge.id ?? `${from}->${to}`, from, to, transport: edge.transport ?? "internal", critical: edge.critical !== false });
    edgeList.push(item);
  }
  function findings() {
    const result = [];
    for (const edge of edgeList) {
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) result.push({ severity: "critical", code: "UNRESOLVED_EDGE", edge });
      if (edge.transport === "database" && edge.crossApp !== false) result.push({ severity: "critical", code: "DIRECT_CROSS_APP_DATABASE", edge });
      if (!edge.contract) result.push({ severity: edge.critical ? "critical" : "warning", code: "MISSING_CONTRACT", edge });
      if (!edge.policy) result.push({ severity: edge.critical ? "critical" : "warning", code: "MISSING_POLICY", edge });
      if (!edge.audit || !edge.trace) result.push({ severity: edge.critical ? "critical" : "warning", code: "MISSING_OBSERVABILITY", edge });
      if (edge.critical && !edge.recovery) result.push({ severity: "critical", code: "MISSING_RECOVERY", edge });
    }
    return result;
  }
  return Object.freeze({
    nodes: () => [...nodeMap.values()],
    edges: () => [...edgeList],
    findings,
    status: () => findings().some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY",
  });
}

export function createEnforcementFabric({ graph, audit = () => {}, quarantine = () => {} } = {}) {
  if (!graph || typeof graph.findings !== "function") throw new Error("Integration graph is required");
  function evaluate(edge) {
    const finding = graph.findings().find((item) => item.edge.id === edge.id);
    const allowed = !finding;
    const result = { edgeId: edge.id, allowed, status: allowed ? "approved" : "quarantined", reason: finding?.code ?? "APPROVED", evaluatedAt: new Date().toISOString() };
    audit(result);
    if (!allowed) quarantine(result);
    return Object.freeze(result);
  }
  return Object.freeze({ evaluate, assertApproved(edge) {
    const result = evaluate(edge);
    if (!result.allowed) {
      const error = new Error(`Integration edge ${edge.id} is quarantined: ${result.reason}`);
      error.code = "INTEGRATION_EDGE_QUARANTINED";
      error.reason = result.reason;
      throw error;
    }
    return result;
  } });
}

export function createHealthRegistry({ checks = [] } = {}) {
  const state = new Map();
  for (const check of checks) state.set(assertIdentifier(check.id, "Health check id"), { ...check, status: check.status ?? "unknown" });
  return Object.freeze({
    set(id, status, details = {}) {
      if (!["healthy", "degraded", "unhealthy", "unknown"].includes(status)) throw new Error("Invalid health status");
      const previous = state.get(id) ?? { id };
      const next = { ...previous, status, details, checkedAt: new Date().toISOString() };
      state.set(id, next);
      return Object.freeze({ ...next });
    },
    list: () => [...state.values()],
    summary: () => {
      const values = [...state.values()];
      return { status: values.some((item) => item.status === "unhealthy") ? "unhealthy" : values.some((item) => item.status === "degraded" || item.status === "unknown") ? "degraded" : "healthy", checks: values.length };
    },
  });
}

export const LIFECYCLE = Object.freeze([...LIFECYCLE_STATES]);

export { createPlatformGraph } from "./dependency-graph.mjs";
export { createStateSyncRegistry } from "./state-sync.mjs";
export { createDataGovernanceCatalog } from "./data-governance.mjs";
export { createResourceOrchestrator } from "./resource-orchestration.mjs";
export { createRuntimeOptimization } from "./runtime-optimization.mjs";
export { createRecoveryController } from "./recovery.mjs";
export { createLifecycleRegistry } from "./lifecycle.mjs";