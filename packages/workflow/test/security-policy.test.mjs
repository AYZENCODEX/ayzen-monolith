import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKFLOW_SECURITY_POLICY,
  __resetWorkflowSecurityPolicyCacheForTests,
  loadWorkflowSecurityPolicy,
} from "../src/security-policy.mjs";

test.beforeEach(() => {
  delete process.env.WORKFLOW_SECURITY_CONFIG_PATH;
  __resetWorkflowSecurityPolicyCacheForTests();
});

test("loads the repo's real config/workflow/security.json with every flag at its documented true", () => {
  const policy = loadWorkflowSecurityPolicy();
  assert.equal(policy.defaultDeny, true);
  assert.equal(policy.workflowOwnerRequired, true);
  assert.equal(policy.stepAuthorizationRequired, true);
  assert.equal(policy.approvalForSensitiveSteps, true);
  assert.equal(policy.cancellationIsAudited, true);
});

test("caches the loaded policy until forceReload is requested", () => {
  const first = loadWorkflowSecurityPolicy();
  const second = loadWorkflowSecurityPolicy();
  assert.equal(first, second, "same object reference without forceReload");
});

test("WORKFLOW_SECURITY_CONFIG_PATH lets a test point at a fixture and see it take effect", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-security-"));
  const fixturePath = path.join(dir, "security.json");
  fs.writeFileSync(fixturePath, JSON.stringify({ schemaVersion: 1, workflowOwnerRequired: false }));
  process.env.WORKFLOW_SECURITY_CONFIG_PATH = fixturePath;
  const policy = loadWorkflowSecurityPolicy({ forceReload: true });
  assert.equal(policy.workflowOwnerRequired, false, "fixture's explicit false is honored");
  // Every flag the fixture didn't mention still falls back to the
  // documented-safe default, not to `undefined`.
  assert.equal(policy.stepAuthorizationRequired, true);
  assert.equal(policy.approvalForSensitiveSteps, true);
  assert.equal(policy.cancellationIsAudited, true);
});

test("a missing config file fails closed to every flag at its documented true, never fails open", () => {
  process.env.WORKFLOW_SECURITY_CONFIG_PATH = "/nonexistent/path/security.json";
  const policy = loadWorkflowSecurityPolicy({ forceReload: true });
  assert.deepEqual(policy, DEFAULT_WORKFLOW_SECURITY_POLICY);
});

test("an unparseable config file also fails closed rather than throwing out to the caller", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-security-bad-"));
  const fixturePath = path.join(dir, "security.json");
  fs.writeFileSync(fixturePath, "{ not valid json");
  process.env.WORKFLOW_SECURITY_CONFIG_PATH = fixturePath;
  const policy = loadWorkflowSecurityPolicy({ forceReload: true });
  assert.deepEqual(policy, DEFAULT_WORKFLOW_SECURITY_POLICY);
});
