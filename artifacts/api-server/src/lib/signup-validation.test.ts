import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDisplayName, validateUsername } from "./signup-validation";
import { DEMO_LOGIN_EMAILS, getStepUpPolicy, loginNeedsStepUp } from "./login-step-up-policy";

test("validateUsername accepts 3-30 lowercase/number/underscore names", () => {
  assert.equal(validateUsername("amir_dev"), null);
  assert.equal(validateUsername("abc"), null);
});

test("validateUsername rejects bad shapes and reserved names", () => {
  for (const bad of ["ab", "Amir", "a b", "a-b", "x".repeat(31), "admin", "", undefined, 5]) {
    assert.notEqual(validateUsername(bad), null, String(bad));
  }
});

test("normalizeDisplayName trims, collapses spaces, caps length, empty -> null", () => {
  assert.equal(normalizeDisplayName("  Amir   Hossain "), "Amir Hossain");
  assert.equal(normalizeDisplayName("   "), null);
  assert.equal(normalizeDisplayName(undefined), null);
  assert.equal(normalizeDisplayName("x".repeat(100))?.length, 60);
});

test("step-up policy: always by default, anomalous only when asked", () => {
  assert.equal(getStepUpPolicy({} as NodeJS.ProcessEnv), "always");
  assert.equal(getStepUpPolicy({ LOGIN_STEP_UP_POLICY: "anomalous" } as unknown as NodeJS.ProcessEnv), "anomalous");
});

test("loginNeedsStepUp: every real login under 'always', new IP only under 'anomalous'", () => {
  assert.equal(loginNeedsStepUp({ policy: "always", email: "a@b.co", anomalousIp: false }), true);
  assert.equal(loginNeedsStepUp({ policy: "anomalous", email: "a@b.co", anomalousIp: false }), false);
  assert.equal(loginNeedsStepUp({ policy: "anomalous", email: "a@b.co", anomalousIp: true }), true);
});

test("loginNeedsStepUp: seeded demo accounts keep the demo-button path", () => {
  for (const e of DEMO_LOGIN_EMAILS) assert.equal(loginNeedsStepUp({ policy: "always", email: e, anomalousIp: false }), false);
});
