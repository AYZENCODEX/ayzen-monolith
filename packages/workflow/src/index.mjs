const STEP_TYPES = new Set(["http", "event", "delay", "approval", "condition", "worker"]);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function validateWorkflowDefinition(definition = {}) {
  assertIdentifier(definition.id, "Workflow id");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error("Workflow version must be positive");
  if (typeof definition.owner !== "string" || !definition.owner.trim()) throw new Error("Workflow owner is required");
  if (!Array.isArray(definition.steps) || definition.steps.length === 0 || definition.steps.length > 100) {
    throw new Error("Workflow must contain 1 to 100 steps");
  }
  const ids = new Set();
  for (const step of definition.steps) {
    assertIdentifier(step?.id, "Workflow step id");
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`);
    ids.add(step.id);
    if (!STEP_TYPES.has(step.type)) throw new Error(`Unsupported workflow step type: ${step.type}`);
    if (step.type === "http" && typeof step.url !== "string") throw new Error("HTTP workflow steps require a URL");
    if (step.type === "event" && typeof step.eventType !== "string") throw new Error("Event workflow steps require an event type");
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 86_400_000)) {
      throw new Error("Workflow step timeout is outside the safe range");
    }
    if (step.retry !== undefined && (!Number.isSafeInteger(step.retry) || step.retry < 0 || step.retry > 10)) {
      throw new Error("Workflow step retry count is outside the safe range");
    }
  }
  return Object.freeze({
    id: definition.id,
    version: definition.version,
    owner: definition.owner,
    steps: Object.freeze(definition.steps.map((step) => Object.freeze({ ...step }))),
    policyContext: Object.freeze({ ...(definition.policyContext ?? {}) }),
  });
}

export function createWorkflowRegistry(definitions = []) {
  const registry = new Map();
  for (const definition of definitions) {
    const valid = validateWorkflowDefinition(definition);
    registry.set(valid.id, valid);
  }
  return Object.freeze({
    get(id) { return registry.get(id); },
    list() { return [...registry.values()]; },
    register(definition) {
      const valid = validateWorkflowDefinition(definition);
      if (registry.has(valid.id) && registry.get(valid.id).version >= valid.version) {
        throw new Error(`Workflow version must advance: ${valid.id}`);
      }
      registry.set(valid.id, valid);
      return valid;
    },
  });
}

export function createWorkflowAudit({ workflowId, executionId, status, actor, traceId, correlationId, error } = {}) {
  return Object.freeze({
    workflowId: assertIdentifier(workflowId, "Workflow id"),
    executionId: assertIdentifier(executionId, "Execution id"),
    status: assertIdentifier(status, "Workflow status"),
    ...(actor ? { actor: { subject: actor.subject, actorType: actor.actorType } } : {}),
    ...(traceId ? { traceId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(error ? { error: String(error).slice(0, 500) } : {}),
    occurredAt: new Date().toISOString(),
  });
}

export function validateRecoveryContract(recovery = {}) {
  const failures = [];
  if (!Number.isSafeInteger(recovery.timeoutMs) || recovery.timeoutMs < 1) failures.push("timeoutMs");
  if (!recovery.retry || !Number.isSafeInteger(recovery.retry.maxAttempts) || recovery.retry.maxAttempts < 1) failures.push("retry");
  if (recovery.checkpoint !== true) failures.push("checkpoint");
  if (!Array.isArray(recovery.compensation)) failures.push("compensation");
  if (recovery.resume !== true) failures.push("resume");
  if (typeof recovery.failureOwner !== "string" || !recovery.failureOwner.trim()) failures.push("failureOwner");
  return { valid: failures.length === 0, failures };
}

export function assertRecoverableWorkflow(definition = {}) {
  const result = validateRecoveryContract(definition.recovery);
  if (!result.valid) throw new Error(`Workflow recovery contract is incomplete: ${result.failures.join(", ")}`);
  return definition;
}

export { createInMemoryWorkflowStore, createPostgresWorkflowStore } from "./store.mjs";
export { createWorkflowExecutor } from "./executor.mjs";
export { createStalledWorkflowMonitor } from "./stall-monitor.mjs";
// Phase H8.4 — services/workflow enforces workflowOwnerRequired /
// cancellationIsAudited on its create/execute/cancel routes and needs the
// same parsed config executor.mjs already reads for
// stepAuthorizationRequired / approvalForSensitiveSteps (H8.3). Exporting it
// here keeps `config/workflow/security.json` parsed in exactly one place
// (./security-policy.mjs) for every consumer, instead of services/workflow
// growing its own copy that could drift from the executor's.
export { loadWorkflowSecurityPolicy } from "./security-policy.mjs";
// H13 — Season 2 audit finding §4: the one primitive services/workflow's
// schedules.mjs needs that didn't exist anywhere in the new architecture.
// See ./cron.mjs's own header for why this is a fresh implementation
// rather than reusing the legacy monolith's separate cron-parser.
export { parseCron, nextRunAfter } from "./cron.mjs";