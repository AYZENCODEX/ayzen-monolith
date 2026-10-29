#!/usr/bin/env node
import { createIdentityContext, deriveChildContext, isValidId } from "@ayzen/identity-context";
import { createCorrelationChain } from "@ayzen/correlation";

/**
 * Phase 02 verification primitive (referenced by
 * schemas/platform/identifiers.json#verification).
 *
 * Simulates the four canonical hop kinds a real request-to-worker path
 * crosses — API -> event -> workflow -> worker — using the same
 * createIdentityContext/deriveChildContext helpers every real service is
 * expected to call, then feeds the resulting hops through
 * createCorrelationChain to assert:
 *
 *   1. Exactly one correlationId across every hop.
 *   2. Every non-entrypoint hop has a causationId that resolves to a real
 *      predecessor hop (not a copy of correlationId/traceId, not dangling).
 *   3. No hop is missing a hopId, traceId or correlationId.
 *
 * Also runs a deliberately-broken variant (a hop that discards the incoming
 * traceId/correlationId and mints its own, per the identifiers.json
 * propagationRequirement) to prove the chain verifier actually catches the
 * defect it exists to catch, not just the happy path.
 *
 * Exit code 0 + "PHASE_02_VERIFICATION: PASS" on success; exit code 1 +
 * the chain findings on failure. Intended to run in CI alongside the
 * package-level `node --test` suites in packages/identity-context and
 * packages/correlation.
 */
function simulateChain({ breakPropagation = false } = {}) {
  const api = createIdentityContext(); // entrypoint: mints traceId + correlationId
  const event = deriveChildContext(api); // outbox -> eventbus hop
  const workflow = breakPropagation
    ? createIdentityContext({ causationId: event.hopId }) // BUG: mints a fresh traceId/correlationId instead of carrying the parent's
    : deriveChildContext(event); // durable-workflow hop
  const worker = deriveChildContext(workflow); // worker-service hop

  const chain = createCorrelationChain();
  for (const [kind, context] of [["api", api], ["event", event], ["workflow", workflow], ["worker", worker]]) {
    chain.recordHop({ kind, hopId: context.hopId, traceId: context.traceId, correlationId: context.correlationId, causationId: context.causationId });
  }
  return { api, event, workflow, worker, chain };
}

function assertValidChain(label, chain) {
  const findings = chain.findings();
  if (findings.length > 0) {
    throw new Error(`${label}: chain verification failed:\n${JSON.stringify(findings, null, 2)}`);
  }
  if (chain.status() !== "READY") {
    throw new Error(`${label}: expected status READY, got ${chain.status()}`);
  }
  for (const hop of chain.hops()) {
    if (!isValidId(hop.hopId) || !isValidId(hop.traceId) || !isValidId(hop.correlationId)) {
      throw new Error(`${label}: hop ${hop.kind} has an invalid id`);
    }
  }
  const correlationIds = new Set(chain.hops().map((hop) => hop.correlationId));
  if (correlationIds.size !== 1) {
    throw new Error(`${label}: expected exactly one correlationId across the chain, found ${correlationIds.size}`);
  }
}

function main() {
  const clean = simulateChain();
  assertValidChain("API -> event -> workflow -> worker (clean propagation)", clean.chain);

  const broken = simulateChain({ breakPropagation: true });
  const brokenFindings = broken.chain.findings();
  const caughtDivergence = brokenFindings.some((finding) => finding.code === "CORRELATION_ID_DIVERGED");
  if (!caughtDivergence || broken.chain.status() !== "BLOCKED") {
    throw new Error(
      "Negative-path check failed: a hop that discards the incoming traceId/correlationId " +
      "should be caught as CORRELATION_ID_DIVERGED and BLOCKED, but was not. " +
      `Findings: ${JSON.stringify(brokenFindings)}`,
    );
  }

  console.log("PHASE_02_VERIFICATION: PASS");
  console.log(JSON.stringify({
    cleanChain: { hops: clean.chain.hops().length, correlationId: clean.api.correlationId, status: clean.chain.status() },
    negativePathCaught: { code: "CORRELATION_ID_DIVERGED", status: broken.chain.status() },
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error("PHASE_02_VERIFICATION: FAIL");
  console.error(error.message);
  process.exitCode = 1;
}
