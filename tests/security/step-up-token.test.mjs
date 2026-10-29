import test from "node:test";
import assert from "node:assert/strict";
import { createStepUpToken, verifyStepUpToken } from "../../packages/auth-client/src/index.mjs";

test("step-up tokens are purpose, tenant, expiry, and single-use bound", () => {
  const consumed = new Set();
  const token = createStepUpToken({
    subject: "user-1",
    purpose: "vault.reveal",
    organizationId: "org-1",
    workspaceId: "ws-1",
    secret: "test-step-up-secret",
    now: 1_700_000_000_000,
    ttlMs: 60_000,
    nonce: "nonce-1",
  });
  assert.equal(verifyStepUpToken(token, {
    subject: "user-1",
    purpose: "vault.reveal",
    organizationId: "org-1",
    workspaceId: "ws-1",
    secret: "test-step-up-secret",
    now: 1_700_000_010_000,
    consumed,
  }).valid, true);
  assert.equal(verifyStepUpToken(token, {
    subject: "user-1",
    purpose: "vault.reveal",
    organizationId: "org-1",
    workspaceId: "ws-1",
    secret: "test-step-up-secret",
    now: 1_700_000_010_000,
    consumed,
  }).reason, "STEP_UP_REPLAYED");
  assert.equal(verifyStepUpToken(token, {
    subject: "user-2",
    purpose: "vault.reveal",
    organizationId: "org-1",
    workspaceId: "ws-1",
    secret: "test-step-up-secret",
    now: 1_700_000_010_000,
    consumed: new Set(),
  }).reason, "STEP_UP_BINDING_MISMATCH");
});