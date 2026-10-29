import { isValidId } from "@ayzen/identity-context";

/**
 * Records a chain of hops (API call, event, workflow run, worker job, ...)
 * and verifies the platform identity-propagation rules:
 *
 *  1. Every hop in the chain shares exactly one correlationId.
 *  2. Every hop after the first has a causationId that resolves to another
 *     hop actually recorded in the chain (a real predecessor, not a dangling
 *     reference and not a copy of correlationId/traceId).
 *  3. No hop is missing a hopId, traceId or correlationId.
 *
 * This is the Phase 02 verification primitive: a passing chain is direct
 * evidence of "one traceable identity chain across synchronous and async
 * paths" for whatever sequence of hops was recorded.
 */
export function createCorrelationChain() {
  const hops = [];

  function recordHop({ kind, hopId, traceId, correlationId, causationId } = {}) {
    if (typeof kind !== "string" || !kind.trim()) throw new Error("Hop kind is required");
    if (!isValidId(hopId)) throw new Error(`Hop ${kind}: hopId is invalid`);
    if (!isValidId(traceId)) throw new Error(`Hop ${kind}: traceId is invalid`);
    if (!isValidId(correlationId)) throw new Error(`Hop ${kind}: correlationId is invalid`);
    const hop = Object.freeze({ kind, hopId, traceId, correlationId, causationId: causationId ?? null, recordedAt: new Date().toISOString() });
    hops.push(hop);
    return hop;
  }

  function findings() {
    const result = [];
    if (hops.length === 0) return result;
    const knownHopIds = new Set(hops.map((hop) => hop.hopId));
    const correlationIds = new Set(hops.map((hop) => hop.correlationId));
    if (correlationIds.size > 1) {
      result.push({ severity: "critical", code: "CORRELATION_ID_DIVERGED", correlationIds: [...correlationIds] });
    }
    hops.forEach((hop, index) => {
      if (index === 0) return; // the entrypoint hop legitimately has no causationId
      if (!hop.causationId) {
        result.push({ severity: "critical", code: "MISSING_CAUSATION_ID", hop: hop.kind });
        return;
      }
      if (hop.causationId === hop.correlationId || hop.causationId === hop.traceId) {
        result.push({ severity: "critical", code: "CAUSATION_ID_NOT_A_PARENT_POINTER", hop: hop.kind });
        return;
      }
      if (!knownHopIds.has(hop.causationId)) {
        result.push({ severity: "critical", code: "CAUSATION_ID_UNRESOLVED", hop: hop.kind, causationId: hop.causationId });
      }
    });
    return result;
  }

  return Object.freeze({
    recordHop,
    hops: () => [...hops],
    findings,
    status: () => (findings().some((finding) => finding.severity === "critical") ? "BLOCKED" : "READY"),
  });
}
