import test from "node:test";
import assert from "node:assert/strict";
import {
  INSTANCE_ID,
  ID_TYPES,
  isValidId,
  assertId,
  generateId,
  normalizeId,
  createIdentityContext,
  deriveChildContext,
} from "../src/index.mjs";

test("INSTANCE_ID / isValidId accept a UUID and reject malformed values", () => {
  const id = generateId();
  assert.match(id, INSTANCE_ID);
  assert.equal(isValidId(id), true);
  assert.equal(isValidId(""), false);
  assert.equal(isValidId("has a space"), false);
  assert.equal(isValidId("@not-allowed"), false); // '@' is reserved for Phase 01 component ids, not instance ids
  assert.equal(isValidId(123), false);
});

test("ID_TYPES lists exactly the seven identifier types from identifiers.json", () => {
  assert.deepEqual(ID_TYPES, [
    "requestId", "traceId", "correlationId", "causationId",
    "eventId", "workflowRunId", "deploymentId",
  ]);
});

test("assertId returns valid ids unchanged and throws with a labeled message otherwise", () => {
  const id = generateId();
  assert.equal(assertId(id, "traceId"), id);
  assert.throws(() => assertId("bad id", "traceId"), /traceId is invalid/);
});

test("normalizeId passes through valid ids and discards invalid/missing ones", () => {
  const id = generateId();
  assert.equal(normalizeId(id), id);
  assert.equal(normalizeId(undefined), undefined);
  assert.equal(normalizeId(""), undefined);
  assert.equal(normalizeId("not valid"), undefined);
});

test("createIdentityContext mints ids for a bare entrypoint hop", () => {
  const context = createIdentityContext();
  assert.equal(isValidId(context.hopId), true);
  assert.equal(isValidId(context.traceId), true);
  assert.equal(isValidId(context.correlationId), true);
  assert.equal("causationId" in context, false); // entrypoint hop has no parent
});

test("createIdentityContext preserves an incoming valid traceId/correlationId instead of minting new ones", () => {
  const incomingTrace = generateId();
  const incomingCorrelation = generateId();
  const context = createIdentityContext({ traceId: incomingTrace, correlationId: incomingCorrelation });
  assert.equal(context.traceId, incomingTrace);
  assert.equal(context.correlationId, incomingCorrelation);
});

test("createIdentityContext discards an invalid incoming id and mints a fresh one instead", () => {
  const context = createIdentityContext({ traceId: "not-a-real-trace-id!!" });
  assert.notEqual(context.traceId, "not-a-real-trace-id!!");
  assert.equal(isValidId(context.traceId), true);
});

test("deriveChildContext carries traceId/correlationId unchanged and sets causationId to the parent's hopId", () => {
  const parent = createIdentityContext();
  const child = deriveChildContext(parent);
  assert.equal(child.traceId, parent.traceId);
  assert.equal(child.correlationId, parent.correlationId);
  assert.equal(child.causationId, parent.hopId);
  assert.notEqual(child.hopId, parent.hopId); // the child is its own hop
});

test("deriveChildContext lets a caller override causationId (e.g. workflow step caused by the originating event)", () => {
  const parent = createIdentityContext();
  const eventId = generateId();
  const child = deriveChildContext(parent, { causationId: eventId });
  assert.equal(child.causationId, eventId);
});

test("deriveChildContext rejects a parent missing a valid hopId/traceId/correlationId", () => {
  assert.throws(() => deriveChildContext(undefined), /requires a valid parent/);
  assert.throws(() => deriveChildContext({ hopId: "not valid", traceId: generateId(), correlationId: generateId() }), /requires a valid parent/);
});

test("a multi-hop chain (API -> event -> workflow -> worker) keeps one traceId/correlationId with a resolvable causationId parent pointer", () => {
  const api = createIdentityContext();
  const event = deriveChildContext(api);
  const workflow = deriveChildContext(event);
  const worker = deriveChildContext(workflow);

  for (const hop of [event, workflow, worker]) {
    assert.equal(hop.traceId, api.traceId);
    assert.equal(hop.correlationId, api.correlationId);
  }
  assert.equal(event.causationId, api.hopId);
  assert.equal(workflow.causationId, event.hopId);
  assert.equal(worker.causationId, workflow.hopId);
});

// ─── W1-P1: module uids ──────────────────────────────────────────────────────
import { MODULE_UID, formatModuleUid, parseModuleUid, isValidModuleUid } from "../src/index.mjs";

test("formatModuleUid pads to 6 digits and grows past 999999 without truncating", () => {
  assert.equal(formatModuleUid("SYL", 1), "SYL-000001");
  assert.equal(formatModuleUid("ZYN", 42), "ZYN-000042");
  assert.equal(formatModuleUid("SYL", 999999), "SYL-999999");
  assert.equal(formatModuleUid("SYL", 1000000), "SYL-1000000");
});

test("formatModuleUid rejects bad prefixes and sequences", () => {
  for (const p of ["syl", "SY", "SYLO", "S1L", "", undefined]) assert.throws(() => formatModuleUid(p, 1), /prefix/);
  for (const n of [0, -1, 1.5, NaN, "1", Number.MAX_SAFE_INTEGER + 2]) assert.throws(() => formatModuleUid("SYL", n), /sequence/);
});

test("parseModuleUid round-trips and accepts only the canonical spelling", () => {
  for (const n of [1, 9, 123456, 999999, 1000000]) {
    assert.deepEqual(parseModuleUid(formatModuleUid("RFT", n)), { prefix: "RFT", seq: n });
  }
  for (const bad of ["SYL-000000", "SYL-0000001", "SYL-00001", "syl-000001", "SYL000001", "SYL-1", "SYL-01", " SYL-000001", "SYL-000001 ", 5, null, undefined, "AYZEN-0001"]) {
    assert.equal(parseModuleUid(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("isValidModuleUid can pin the expected module prefix", () => {
  assert.equal(isValidModuleUid("SYL-000001"), true);
  assert.equal(isValidModuleUid("SYL-000001", { prefix: "SYL" }), true);
  assert.equal(isValidModuleUid("SYL-000001", { prefix: "SKR" }), false);
  assert.equal(isValidModuleUid("nope"), false);
  assert.match("SYL-000001", MODULE_UID);
});

test("module uids are not instance ids: a UUID is not a module uid and the reverse still holds for the instance format", () => {
  assert.equal(parseModuleUid(generateId()), null);
  assert.equal(isValidId("SYL-000001"), true); // legal instance-id charset, but only parseModuleUid knows the module format
});
