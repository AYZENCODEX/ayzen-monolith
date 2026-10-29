import crypto from "node:crypto";
import { createEventEnvelope } from "@ayzen/events";
import { authorizeCapability, requiresStepUp } from "@ayzen/authorization";
import { validateWorkflowDefinition } from "./index.mjs";
import { createInMemoryWorkflowStore } from "./store.mjs";
import { loadWorkflowSecurityPolicy } from "./security-policy.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function render(value, context) {
  if (typeof value === "string") return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => path.trim().split(".").reduce((current, key) => current?.[key], context) ?? "");
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, render(item, context)]));
  return value;
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = "WORKFLOW_STEP_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Phase H8.3 — before this, `policyContext` on a workflow definition (S1
 * #5) was validated and stored (see ./index.mjs's validateWorkflowDefinition)
 * and never read by anything, and `config/workflow/security.json`'s
 * `stepAuthorizationRequired` / `approvalForSensitiveSteps` (S2 #9) were
 * never enforced anywhere. This is the step-boundary gate that closes
 * both: it runs once per step, before `executeStep`'s own switch, using
 * whatever the step's own `policyContext.steps[step.id]` entry declares:
 *
 *   { "capability": "finance.post-transaction", "sensitive": true,
 *     "scopes": [...], "roles": [...] }
 *
 * A step with no entry in `policyContext.steps` is left alone — this is
 * additive enforcement for steps a workflow author opts in, not a
 * requirement that every step declare a capability.
 *
 * `capability` (when present) is checked via `@ayzen/authorization`'s
 * `authorizeCapability` against the run's `authContext` (the real caller's
 * subject/scopes/roles, threaded in from `run()`'s options — see below);
 * anything other than `"allow"` fails the step with
 * `WORKFLOW_STEP_AUTHORIZATION_DENIED`, the same way any other step
 * failure does (retried up to the step's own `retry`, then propagated).
 *
 * A step counts as sensitive if its policyContext entry says so directly,
 * or if it declares a `capability` that `@ayzen/capabilities`'s own
 * registry already marks sensitive (`requiresStepUp`) — an author doesn't
 * have to duplicate that flag by hand for a capability that already
 * carries it. When `approvalForSensitiveSteps` is on, a sensitive step is
 * routed through the same `approval` handler an explicit `type: "approval"`
 * step uses, before its real work runs — turning "sensitive" into a hard
 * pause for a human decision, not just a logged authorization check.
 */
async function enforceStepPolicy(step, context, { policyContext, securityPolicy, approval, input }) {
  if (!securityPolicy.stepAuthorizationRequired) return;
  const requirement = policyContext?.steps?.[step.id];
  if (!requirement) return;
  const authContext = context.authContext ?? {};
  if (requirement.capability) {
    const decision = authorizeCapability({
      capability: requirement.capability,
      subject: authContext.subject,
      actorType: authContext.actorType,
      organizationId: authContext.organizationId,
      workspaceId: authContext.workspaceId,
      scopes: [...(authContext.scopes ?? []), ...(requirement.scopes ?? [])],
      roles: [...(authContext.roles ?? []), ...(requirement.roles ?? [])],
      stepUpAt: authContext.stepUpAt,
    });
    if (decision.decision !== "allow") {
      const error = new Error(`Workflow step ${step.id} denied by capability authorization: ${decision.reason}`);
      error.code = "WORKFLOW_STEP_AUTHORIZATION_DENIED";
      error.decision = decision;
      throw error;
    }
  }
  const sensitive = Boolean(requirement.sensitive) || (requirement.capability ? requiresStepUp(requirement.capability) : false);
  if (sensitive && securityPolicy.approvalForSensitiveSteps && step.type !== "approval") {
    if (typeof approval !== "function") {
      const error = new Error(`Workflow step ${step.id} is flagged sensitive and requires approval, but no approval handler is configured`);
      error.code = "WORKFLOW_STEP_APPROVAL_REQUIRED";
      throw error;
    }
    // Any rejection throws (WORKFLOW_APPROVAL_REJECTED, per the approval
    // handler's own contract — see apps/worker/src/approval.mjs); a
    // successful decision just lets execution fall through to the step's
    // real work below.
    await approval({
      step: { ...step, type: "approval", description: step.description ?? `Sensitive step "${step.id}" (${step.type}, capability: ${requirement.capability ?? "n/a"})` },
      context,
      input,
    });
  }
}

export function createWorkflowExecutor({
  store = createInMemoryWorkflowStore(),
  http = fetch,
  publish,
  waitForEvent,
  approval,
  worker,
  logger = console,
  leaseOwner = crypto.randomUUID(),
  leaseTtlMs = 30_000,
  securityPolicy = loadWorkflowSecurityPolicy(),
} = {}) {
  const leaseLost = new Set();
  const cancelled = new Set();
  const active = new Map();

  async function executeStep(step, context, { policyContext } = {}) {
    const input = render(step.input ?? step.body ?? {}, context);
    await enforceStepPolicy(step, context, { policyContext, securityPolicy, approval, input });
    switch (step.type) {
      case "http": {
        const response = await http(step.url, {
          method: step.method ?? "GET",
          headers: { "content-type": "application/json", ...(step.headers ?? {}) },
          ...(step.method && step.method !== "GET" ? { body: JSON.stringify(input) } : {}),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`HTTP workflow step returned ${response.status}`);
        return body;
      }
      case "event": {
        if (typeof publish !== "function") throw new Error("Workflow event step requires an event publisher");
        const envelope = createEventEnvelope({ eventType: step.eventType, payload: input, correlationId: context.correlationId });
        await publish(envelope);
        if (step.awaitEventType && typeof waitForEvent === "function") return waitForEvent(step.awaitEventType, { correlationId: context.correlationId, timeoutMs: step.timeoutMs });
        return envelope;
      }
      case "delay":
        await sleep(Number(step.delayMs ?? step.durationMs ?? 0));
        return { delayedMs: Number(step.delayMs ?? step.durationMs ?? 0) };
      case "approval":
        if (typeof approval !== "function") throw new Error("Workflow approval step requires an approval handler");
        return approval({ step, context, input });
      case "condition":
        return { matched: typeof step.when === "function" ? Boolean(await step.when(context)) : Boolean(render(step.when ?? step.condition, context)) };
      case "worker":
        if (typeof worker !== "function") throw new Error("Workflow worker step requires a worker handler");
        return worker({ step, context, input });
      default:
        throw new Error(`Unsupported workflow step type: ${step.type}`);
    }
  }

  async function run(definition, { runId = crypto.randomUUID(), input = {}, correlationId, causationId, authContext } = {}) {
    const valid = validateWorkflowDefinition(definition);
    const existing = await store.loadWorkflowInstance(runId);
    const run = existing ?? await store.createWorkflowInstance({
      id: runId,
      definitionId: valid.id,
      definitionVersion: valid.version,
      context: { input, correlationId: correlationId ?? crypto.randomUUID(), causationId },
    });
    if (run.definitionId !== valid.id || Number(run.definitionVersion) !== valid.version) {
      throw new Error(`Workflow definition does not match existing run: ${runId}`);
    }
    if (["COMPLETED", "CANCELLED", "COMPENSATED"].includes(run.status)) {
      // Redelivered event for a run that already finished: nothing to do.
      return { run, values: run.context?.values ?? {}, skipped: true, reason: "ALREADY_TERMINAL" };
    }
    const leased = typeof store.acquireLease === "function" ? await store.acquireLease(runId, leaseOwner, leaseTtlMs) : true;
    if (!leased) return { run, values: {}, skipped: true, reason: "LEASE_HELD" };
    const heartbeat = typeof store.renewLease === "function"
      ? setInterval(() => {
        store.renewLease(runId, leaseOwner, leaseTtlMs).then((ok) => { if (!ok) leaseLost.add(runId); }, () => leaseLost.add(runId));
      }, Math.max(50, Math.floor(leaseTtlMs / 3)))
      : null;
    heartbeat?.unref?.();
    active.set(runId, true);
    const checkpoint = await store.loadLatestCheckpoint(runId);
    const checkpointState = checkpoint?.state ?? checkpoint?.state_json ?? {};
    const values = { ...(checkpointState.values ?? input) };
    const completedIds = new Set(checkpointState.completed ?? []);
    const completed = valid.steps
      .filter((step) => completedIds.has(step.id))
      .map((step) => ({ step, output: values[step.id] }));
    try {
      await store.updateWorkflowInstance(runId, { status: "RUNNING", startedAt: new Date().toISOString() });
      for (const step of valid.steps) {
        if (completedIds.has(step.id)) continue;
        if (leaseLost.has(runId)) throw Object.assign(new Error("Workflow lease lost"), { code: "WORKFLOW_LEASE_LOST" });
        // Phase H7.4: `cancelled` (below) only catches a cancel() call made
        // on *this* executor instance — enough when this replica is the one
        // that received the workflow.cancelled event, but worker replicas
        // share one event-bus consumer group, so that's frequently a
        // different replica than the one actually running this loop.
        // store.cancelWorkflowInstance already persists CANCELLED to the
        // shared store regardless of which replica called it; re-reading
        // the instance here is what lets *this* replica notice, at the next
        // step boundary, a cancellation requested somewhere else.
        if (cancelled.has(runId)) throw Object.assign(new Error("Workflow cancelled"), { code: "WORKFLOW_CANCELLED" });
        const currentInstance = await store.loadWorkflowInstance(runId);
        if (currentInstance?.status === "CANCELLED") throw Object.assign(new Error("Workflow cancelled"), { code: "WORKFLOW_CANCELLED" });
        await store.updateWorkflowInstance(runId, { currentStepId: step.id });
        const maxAttempts = (step.retry ?? 0) + 1;
        let output;
        let lastError;
        const startedAt = new Date().toISOString();
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await store.saveStep(runId, { stepId: step.id, attempt, status: "RUNNING", input: values, startedAt, idempotencyKey: `${runId}:${step.id}:${attempt}` });
            output = await withTimeout(
              executeStep(step, { ...values, runId, correlationId: correlationId ?? run.context?.correlationId, authContext }, { policyContext: valid.policyContext }),
              step.timeoutMs,
              `Workflow step ${step.id}`,
            );
            await store.saveStep(runId, { stepId: step.id, attempt, status: "COMPLETED", input: values, output, startedAt, finishedAt: new Date().toISOString(), idempotencyKey: `${runId}:${step.id}:${attempt}` });
            break;
          } catch (error) {
            lastError = error;
            await store.saveStep(runId, { stepId: step.id, attempt, status: "FAILED", input: values, error: String(error?.message ?? error), startedAt, finishedAt: new Date().toISOString(), idempotencyKey: `${runId}:${step.id}:${attempt}` });
            if (attempt < maxAttempts) await sleep(Math.min(1_000 * 2 ** (attempt - 1), 10_000));
          }
        }
        if (lastError && output === undefined) throw lastError;
        values[step.id] = output;
        completed.push({ step, output });
        await store.saveCheckpoint(runId, { stepId: step.id, state: { values, completed: completed.map(({ step: item }) => item.id) } });
      }
      const result = await store.updateWorkflowInstance(runId, { status: "COMPLETED", currentStepId: null, completedAt: new Date().toISOString(), context: { input, values, correlationId } });
      return { run: result, values };
    } catch (error) {
      // Another worker owns the run now; it decides the outcome. Do not
      // overwrite its status or run compensations underneath it.
      if (error?.code === "WORKFLOW_LEASE_LOST") throw error;
      const status = error?.code === "WORKFLOW_CANCELLED" ? "CANCELLED" : "FAILED";
      await store.updateWorkflowInstance(runId, { status, lastError: String(error?.message ?? error), completedAt: new Date().toISOString() });
      let compensationFailed = false;
      for (const { step, output } of completed.reverse()) {
        if (!step.compensate) continue;
        try {
          await (typeof step.compensate === "function"
            ? step.compensate({ output, values, runId })
            : worker?.({ step: { ...step, type: "worker", action: step.compensate }, context: values, input: output }));
        } catch (compensationError) {
          compensationFailed = true;
          logger.error?.({ runId, step: step.id, error: compensationError }, "Workflow compensation failed");
        }
      }
      if (!compensationFailed && completed.some(({ step }) => step.compensate)) {
        await store.updateWorkflowInstance(runId, { status: "COMPENSATED" });
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      leaseLost.delete(runId);
      active.delete(runId);
      await store.releaseLease?.(runId, leaseOwner).catch(() => {});
    }
  }

  return {
    run,
    resume(runId, definition, options = {}) {
      return run(definition, { ...options, runId });
    },
    cancel(runId) {
      cancelled.add(runId);
      return store.cancelWorkflowInstance(runId);
    },
    activeRuns() {
      return [...active.keys()];
    },
  };
}