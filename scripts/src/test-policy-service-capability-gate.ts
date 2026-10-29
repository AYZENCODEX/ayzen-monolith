/**
 * scripts/src/test-policy-service-capability-gate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Enforcement Roadmap — Track H, Phase H4: extend policy coverage to
 * the extracted services (Telegram's half of H4 needed no new code — see
 * CHANGES_ENFORCEMENT_ROADMAP_TRACK_H_PHASE_H4.md's "Telegram" section for
 * why: it already proxies to real, already-gated HTTP routes).
 *
 * DB-free, runnable anywhere (`npx tsx scripts/src/test-policy-service-capability-gate.ts`);
 * picked up by `check:verification`'s `test-policy-*` glob (run-verification-suite.mjs).
 *
 * Exercises the REAL exports — `@ayzen/capabilities`'s `matchCapabilityRoute`
 * and `@ayzen/authorization`'s `authorizeServiceCapability` — the same two
 * functions `packages/service-runtime/src/index.mjs`'s `createServiceServer`
 * calls on every request. Not covered here (needs a running HTTP server):
 * the end-to-end 401 response `createServiceServer` returns for a denied
 * request, and the `SERVICE_CAPABILITY_GATE` kill switch's effect on that
 * response — both are a thin, direct read of `service-runtime/src/index.mjs`
 * (see the "Not verified" section in the CHANGES doc) rather than exercised
 * live in this sandbox (no server startable here — same limitation Phase H3
 * hit for its own DB-backed half).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITY_REGISTRY, getCapability, matchCapabilityRoute } from "../../packages/capabilities/src/index.mjs";
import { authorizeCapability, authorizeServiceCapability } from "../../packages/authorization/src/index.mjs";

test("CAPABILITY_REGISTRY carries a sensitive flag for every entry, no undefineds", () => {
  for (const entry of CAPABILITY_REGISTRY) {
    assert.equal(typeof entry.sensitive, "boolean", `${entry.capability} is missing a boolean sensitive flag`);
  }
});

test("sensitivity is a real per-capability call, not derived from the scope string alone", () => {
  // Both share the scope "identity:session:write" — this is the exact case
  // that rules out deriving `sensitive` mechanically from `permission`.
  assert.equal(getCapability("identity.issue-session")?.sensitive, false);
  assert.equal(getCapability("identity.revoke-session")?.sensitive, true);
});

test("authorizeCapability's pre-refactor behavior is unchanged after sourcing from CAPABILITY_REGISTRY", () => {
  // Same two assertions scripts/validate-phase-1-11.mjs already makes —
  // duplicated here as a regression pin so this suite alone would catch a
  // break in that mapping, not just the phase-1-11 evidence check.
  const allowed = authorizeCapability({ capability: "finance.get-balance", subject: "user:validation", scopes: ["finance:read"] });
  assert.equal(allowed.decision, "allow");
  const stepUp = authorizeCapability({ capability: "finance.post-transaction", subject: "user:validation", scopes: ["finance:write"] });
  assert.equal(stepUp.decision, "step_up_required");
});

test("matchCapabilityRoute resolves an extracted-service request to the same capability the monolith/Telegram already agree on", () => {
  const match = matchCapabilityRoute("POST", "/api/finance/accounts/acc_123/transactions");
  assert.equal(match?.capability, "finance.post-transaction");
  assert.equal(matchCapabilityRoute("GET", "/api/vault/secret_1/reveal"), undefined, "reveal is a POST capability, must not match GET");
  assert.equal(matchCapabilityRoute("POST", "/api/vault/secret_1/reveal")?.capability, "vault.read-secret");
});

test("matchCapabilityRoute returns undefined for transport-only paths (not_gated, not denied)", () => {
  assert.equal(matchCapabilityRoute("GET", "/health"), undefined);
  assert.equal(matchCapabilityRoute("GET", "/internal/manifest"), undefined);
  assert.equal(matchCapabilityRoute("GET", "/ready"), undefined);
});

test("authorizeServiceCapability: not_gated for a route with no registered capability", () => {
  const result = authorizeServiceCapability({ method: "GET", pathname: "/internal/audit" });
  assert.equal(result.decision, "not_gated");
});

test("authorizeServiceCapability: denies an anonymous caller on a scope-requiring route", () => {
  const result = authorizeServiceCapability({ method: "POST", pathname: "/api/finance/accounts/acc_1/transactions" });
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "AUTHENTICATED_SUBJECT_REQUIRED");
  assert.deepEqual(result.requiredScopes, ["finance:write"]);
});

test("authorizeServiceCapability: denies even a read-only capability's route when the caller carries no identity at all", () => {
  // finance.list-accounts still declares a "finance:read" scope requirement
  // in the registry, so an entirely unauthenticated caller is still denied —
  // only capabilities with an EMPTY scope list AND sensitive:false skip the
  // identity check (see the next test).
  const result = authorizeServiceCapability({ method: "GET", pathname: "/api/finance/accounts" });
  assert.equal(result.decision, "deny");
});

test("authorizeServiceCapability: allows once ANY identity claim is present (userId, sub, or subject) — real session JWTs carry userId, not sub/subject", () => {
  const byUserId = authorizeServiceCapability({ method: "POST", pathname: "/api/finance/accounts/acc_1/transactions", auth: { userId: 42, role: "user" } });
  assert.equal(byUserId.decision, "allow");
  assert.equal(byUserId.reason, "IDENTITY_PRESENT_SCOPE_NOT_VERIFIED", "honestly labeled: identity was confirmed, the finance:write scope itself was not");

  const bySub = authorizeServiceCapability({ method: "POST", pathname: "/api/finance/accounts/acc_1/transactions", auth: { sub: "42" } });
  assert.equal(bySub.decision, "allow");
});

test("authorizeServiceCapability: trusts an already-verified internal service-to-service caller unconditionally", () => {
  const result = authorizeServiceCapability({
    method: "POST",
    pathname: "/api/finance/accounts/acc_1/transactions",
    auth: undefined, // internal-secret path carries no bearer JWT at all
    internalService: true,
  });
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "INTERNAL_SERVICE_TRUSTED");
});

test("authorizeServiceCapability: an empty auth object (no userId/sub/subject) is treated the same as no auth at all", () => {
  const result = authorizeServiceCapability({ method: "POST", pathname: "/api/finance/accounts/acc_1/transactions", auth: {} });
  assert.equal(result.decision, "deny");
});
