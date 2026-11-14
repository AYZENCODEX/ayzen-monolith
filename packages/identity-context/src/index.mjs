import crypto from "node:crypto";

// Shared format for every id this module mints: requestId, traceId,
// correlationId, causationId, eventId, workflowRunId, deploymentId.
// Kept in sync with schemas/platform/identifiers.json#/definitions/instanceId.
// Deliberately narrower than a Phase 01 component id (no '@' or '/') because
// these are runtime-minted values, not registry slugs.
export const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ID_TYPES = Object.freeze([
  "requestId", "traceId", "correlationId", "causationId",
  "eventId", "workflowRunId", "deploymentId",
]);

export function isValidId(value) {
  return typeof value === "string" && INSTANCE_ID.test(value);
}

export function assertId(value, label = "Identifier") {
  if (!isValidId(value)) throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
  return value;
}

export function generateId() {
  return crypto.randomUUID();
}

/**
 * Returns `value` unchanged if it is a valid instance id, otherwise `undefined`.
 * This is the one place "did the caller actually send us a usable id" is
 * decided — every package that reads an incoming id (HTTP header, event
 * envelope field, workflow context field) should go through this rather than
 * re-implementing its own regex check, so a fix here fixes every caller.
 */
export function normalizeId(value) {
  return isValidId(value) ? value : undefined;
}

/**
 * Builds one hop's identity context.
 *
 * `hopId` is this hop's own id — a requestId for an HTTP hop, an eventId for
 * a published event, a workflowRunId for a workflow execution, a worker job
 * id for a queue pop. It is deliberately generic here; the caller (e.g.
 * @ayzen/tracing for HTTP) renames it to the field name its transport uses.
 *
 * `traceId` and `correlationId` are minted only when genuinely absent — an
 * incoming valid value is always preserved unchanged. This is the fix for
 * the class of bug where a hop discards a caller-supplied trace/correlation
 * id and mints a fresh one, silently breaking the identity chain.
 */
export function createIdentityContext({ hopId, traceId, correlationId, causationId } = {}) {
  return Object.freeze({
    hopId: normalizeId(hopId) ?? generateId(),
    traceId: normalizeId(traceId) ?? generateId(),
    correlationId: normalizeId(correlationId) ?? generateId(),
    ...(normalizeId(causationId) ? { causationId: normalizeId(causationId) } : {}),
  });
}

/**
 * Derives the next hop's context from a parent hop's context, per the
 * platform causation rule (schemas/platform/identifiers.json#causationRule):
 * traceId/correlationId are carried unchanged; causationId is set to the
 * parent's own hopId (the thing that actually caused this hop) unless the
 * caller explicitly overrides it (e.g. "this workflow step was caused by the
 * event that started the run, not by the run id itself").
 */
export function deriveChildContext(parent, { causationId } = {}) {
  if (!parent || !isValidId(parent.hopId) || !isValidId(parent.traceId) || !isValidId(parent.correlationId)) {
    throw new Error("deriveChildContext requires a valid parent identity context");
  }
  return createIdentityContext({
    traceId: parent.traceId,
    correlationId: parent.correlationId,
    causationId: causationId ?? parent.hopId,
  });
}

// ─── Module user ids (W1-P1, ADR A1) ────────────────────────────────────────
// Display/lookup id for a user's account inside one module: <PREFIX>-<6+ digit seq>, e.g.
// SYL-000001. Unlike the instance ids above these are durable (they identify an account, not
// a request), so they are minted by the database (ayzen_provision_module_account) from a
// per-module sequence, never by generateId(). The prefix → module mapping lives in
// @ayzen/module-registry; this package stays dependency-free, so callers that need to know
// the module pass the expected prefix.
export const MODULE_UID = /^([A-Z]{3})-([0-9]{6,})$/;
const MODULE_UID_MIN_DIGITS = 6;

export function formatModuleUid(prefix, seq) {
  if (typeof prefix !== "string" || !/^[A-Z]{3}$/.test(prefix)) {
    throw new Error(`Module uid prefix is invalid: ${JSON.stringify(prefix)}`);
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`Module uid sequence must be a positive integer: ${JSON.stringify(seq)}`);
  }
  // Pad to 6 digits; beyond 999999 the number just grows (never truncates).
  return `${prefix}-${String(seq).padStart(MODULE_UID_MIN_DIGITS, "0")}`;
}

/** Returns { prefix, seq } for a well-formed module uid, otherwise null. */
export function parseModuleUid(value) {
  if (typeof value !== "string") return null;
  const match = MODULE_UID.exec(value);
  if (!match) return null;
  const seq = Number(match[2]);
  // Reject non-canonical padding (SYL-0000001 / SYL-000000) so one account has one spelling.
  if (!Number.isSafeInteger(seq) || seq < 1 || formatModuleUid(match[1], seq) !== value) return null;
  return { prefix: match[1], seq };
}

export function isValidModuleUid(value, { prefix } = {}) {
  const parsed = parseModuleUid(value);
  return parsed !== null && (prefix === undefined || parsed.prefix === prefix);
}
