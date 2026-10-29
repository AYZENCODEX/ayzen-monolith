import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryWorkflowStore, createWorkflowExecutor } from "../src/index.mjs";

const ENFORCING_POLICY = Object.freeze({
  schemaVersion: 1,
  defaultDeny: true,
  workflowOwnerRequired: true,
  stepAuthorizationRequired: true,
  approvalForSensitiveSteps: true,
  cancellationIsAudited: true,
});

function definitionWithCapabilityStep(policyContext) {
  return {
    id: "step-policy-test",
    version: 1,
    owner: "platform",
    steps: [{ id: "post-tx", type: "worker", action: "postTransaction" }],
    policyContext,
  };
}

test("a step with no policyContext entry runs unaffected, whatever the policy says", async () => {
  const store = createInMemoryWorkflowStore();
  const calls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  const result = await executor.run(definitionWithCapabilityStep({}), { runId: "run-no-entry" });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(calls, ["post-tx"]);
});

test("a step declaring a capability the caller lacks the scope for is denied", async () => {
  const store = createInMemoryWorkflowStore();
  const calls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  await assert.rejects(
    executor.run(definition, { runId: "run-missing-scope", authContext: { subject: "user-1", scopes: [] } }),
    (error) => error.code === "WORKFLOW_STEP_AUTHORIZATION_DENIED",
  );
  assert.deepEqual(calls, [], "the step's real work must never run once authorization is denied");
  const run = await store.loadWorkflowInstance("run-missing-scope");
  assert.equal(run.status, "FAILED");
});

test("a step declaring a capability with no authContext at all is denied, not silently allowed", async () => {
  const store = createInMemoryWorkflowStore();
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    worker: async () => ({ ok: true }),
  });
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  await assert.rejects(
    executor.run(definition, { runId: "run-no-auth" }), // no authContext passed at all
    (error) => error.code === "WORKFLOW_STEP_AUTHORIZATION_DENIED",
  );
});

test("a sensitive capability step is routed through approval before its real work runs, and only proceeds once approved", async () => {
  const store = createInMemoryWorkflowStore();
  const calls = [];
  const approvalCalls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    approval: async ({ step }) => { approvalCalls.push(step.id); return { approved: true }; },
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  // finance.post-transaction is registered sensitive in @ayzen/capabilities,
  // so a fresh stepUpAt is required for authorizeCapability to allow it at
  // all — this is exactly what should also trigger the approval hand-off.
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  const result = await executor.run(definition, {
    runId: "run-sensitive-approved",
    authContext: { subject: "user-1", scopes: ["finance:write"], stepUpAt: new Date().toISOString() },
  });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(approvalCalls, ["post-tx"], "approval must run before the step's own work");
  assert.deepEqual(calls, ["post-tx"]);
});

test("a rejected approval on a sensitive step fails the run and never executes the step's real work", async () => {
  const store = createInMemoryWorkflowStore();
  const calls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    approval: async () => {
      const error = new Error("Approval was rejected");
      error.code = "WORKFLOW_APPROVAL_REJECTED";
      throw error;
    },
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  await assert.rejects(
    executor.run(definition, {
      runId: "run-sensitive-rejected",
      authContext: { subject: "user-1", scopes: ["finance:write"], stepUpAt: new Date().toISOString() },
    }),
    (error) => error.code === "WORKFLOW_APPROVAL_REJECTED",
  );
  assert.deepEqual(calls, []);
});

test("a sensitive step with no approval handler configured fails clearly instead of silently skipping the pause", async () => {
  const store = createInMemoryWorkflowStore();
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    // No `approval` handler passed at all.
    worker: async () => ({ ok: true }),
  });
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  await assert.rejects(
    executor.run(definition, {
      runId: "run-sensitive-no-handler",
      authContext: { subject: "user-1", scopes: ["finance:write"], stepUpAt: new Date().toISOString() },
    }),
    (error) => error.code === "WORKFLOW_STEP_APPROVAL_REQUIRED",
  );
});

test("an explicitly-flagged sensitive step (no registered-sensitive capability) also routes through approval", async () => {
  const store = createInMemoryWorkflowStore();
  const approvalCalls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: ENFORCING_POLICY,
    approval: async ({ step }) => { approvalCalls.push(step.id); return { approved: true }; },
    worker: async () => ({ ok: true }),
  });
  // No `capability` at all here — `sensitive: true` alone must be enough.
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { sensitive: true } } });
  const result = await executor.run(definition, { runId: "run-explicit-sensitive" });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(approvalCalls, ["post-tx"]);
});

test("approvalForSensitiveSteps: false skips the approval hand-off even for a sensitive capability, once authorized", async () => {
  const store = createInMemoryWorkflowStore();
  const approvalCalls = [];
  const calls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: { ...ENFORCING_POLICY, approvalForSensitiveSteps: false },
    approval: async ({ step }) => { approvalCalls.push(step.id); return { approved: true }; },
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  const result = await executor.run(definition, {
    runId: "run-approval-disabled",
    authContext: { subject: "user-1", scopes: ["finance:write"], stepUpAt: new Date().toISOString() },
  });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(approvalCalls, [], "approval must not run when approvalForSensitiveSteps is off");
  assert.deepEqual(calls, ["post-tx"]);
});

test("stepAuthorizationRequired: false disables the whole gate, even for a declared capability", async () => {
  const store = createInMemoryWorkflowStore();
  const calls = [];
  const executor = createWorkflowExecutor({
    store,
    securityPolicy: { ...ENFORCING_POLICY, stepAuthorizationRequired: false },
    worker: async ({ step }) => { calls.push(step.id); return { ok: true }; },
  });
  // No authContext, no scopes, capability declared — would be denied if the
  // gate were on at all.
  const definition = definitionWithCapabilityStep({ steps: { "post-tx": { capability: "finance.post-transaction" } } });
  const result = await executor.run(definition, { runId: "run-gate-off" });
  assert.equal(result.run.status, "COMPLETED");
  assert.deepEqual(calls, ["post-tx"]);
});
