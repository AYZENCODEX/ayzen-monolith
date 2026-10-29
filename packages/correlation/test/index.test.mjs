import test from "node:test";
import assert from "node:assert/strict";
import { generateId, createIdentityContext, deriveChildContext } from "@ayzen/identity-context";
import { createCorrelationChain } from "../src/index.mjs";

function chainFromContexts(contexts) {
  const chain = createCorrelationChain();
  contexts.forEach(({ kind, context }) => {
    chain.recordHop({ kind, hopId: context.hopId, traceId: context.traceId, correlationId: context.correlationId, causationId: context.causationId });
  });
  return chain;
}

test("recordHop rejects a missing kind or an invalid id", () => {
  const chain = createCorrelationChain();
  assert.throws(() => chain.recordHop({ hopId: generateId(), traceId: generateId(), correlationId: generateId() }), /kind is required/);
  assert.throws(() => chain.recordHop({ kind: "api", hopId: "not valid", traceId: generateId(), correlationId: generateId() }), /hopId is invalid/);
});

test("a clean API -> event -> workflow -> worker chain has zero findings and status READY", () => {
  const api = createIdentityContext();
  const event = deriveChildContext(api);
  const workflow = deriveChildContext(event);
  const worker = deriveChildContext(workflow);

  const chain = chainFromContexts([
    { kind: "api", context: api },
    { kind: "event", context: event },
    { kind: "workflow", context: workflow },
    { kind: "worker", context: worker },
  ]);

  assert.equal(chain.hops().length, 4);
  assert.deepEqual(chain.findings(), []);
  assert.equal(chain.status(), "READY");
});

test("a hop after the entrypoint with no causationId is a critical MISSING_CAUSATION_ID finding", () => {
  const api = createIdentityContext();
  const chain = createCorrelationChain();
  chain.recordHop({ kind: "api", hopId: api.hopId, traceId: api.traceId, correlationId: api.correlationId });
  chain.recordHop({ kind: "event", hopId: generateId(), traceId: api.traceId, correlationId: api.correlationId }); // causationId omitted

  const findings = chain.findings();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "MISSING_CAUSATION_ID");
  assert.equal(chain.status(), "BLOCKED");
});

test("a hop whose correlationId diverges from the rest of the chain is a critical CORRELATION_ID_DIVERGED finding", () => {
  const api = createIdentityContext();
  const event = deriveChildContext(api);
  const chain = chainFromContexts([{ kind: "api", context: api }]);
  chain.recordHop({ kind: "event", hopId: event.hopId, traceId: event.traceId, correlationId: generateId(), causationId: api.hopId });

  const findings = chain.findings();
  assert.equal(findings.some((finding) => finding.code === "CORRELATION_ID_DIVERGED"), true);
  assert.equal(chain.status(), "BLOCKED");
});

test("a causationId that is a copy of correlationId/traceId is not a resolvable parent pointer (CAUSATION_ID_NOT_A_PARENT_POINTER)", () => {
  const api = createIdentityContext();
  const chain = chainFromContexts([{ kind: "api", context: api }]);
  chain.recordHop({ kind: "event", hopId: generateId(), traceId: api.traceId, correlationId: api.correlationId, causationId: api.correlationId });

  const findings = chain.findings();
  assert.equal(findings[0].code, "CAUSATION_ID_NOT_A_PARENT_POINTER");
  assert.equal(chain.status(), "BLOCKED");
});

test("a causationId pointing at a hop that was never recorded is CAUSATION_ID_UNRESOLVED", () => {
  const api = createIdentityContext();
  const chain = chainFromContexts([{ kind: "api", context: api }]);
  const danglingCausationId = generateId();
  chain.recordHop({ kind: "event", hopId: generateId(), traceId: api.traceId, correlationId: api.correlationId, causationId: danglingCausationId });

  const findings = chain.findings();
  assert.equal(findings[0].code, "CAUSATION_ID_UNRESOLVED");
  assert.equal(findings[0].causationId, danglingCausationId);
});

test("an empty chain has no findings and status READY (nothing to be blocked on yet)", () => {
  const chain = createCorrelationChain();
  assert.deepEqual(chain.findings(), []);
  assert.equal(chain.status(), "READY");
});
