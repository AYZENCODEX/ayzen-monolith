import crypto from "node:crypto";
import { compareObservedEdges, redactSecrets } from "@ayzen/enforcement-core";

export function createRuntimeGraph({ now = () => new Date().toISOString(), audit = () => {} } = {}) {
  const hops = [];
  function record(input) {
    const hop = Object.freeze({
      id: input.id ?? crypto.randomUUID(),
      traceId: input.traceId ?? crypto.randomUUID(),
      correlationId: input.correlationId ?? input.traceId,
      from: input.from,
      to: input.to,
      kind: input.kind ?? "service-hop",
      status: input.status ?? "ok",
      latencyMs: input.latencyMs ?? 0,
      retry: input.retry ?? 0,
      error: input.error ? String(input.error).slice(0, 500) : undefined,
      occurredAt: now(),
      metadata: redactSecrets(input.metadata ?? {}),
    });
    hops.push(hop);
    audit({ action: "runtime.hop.recorded", hop });
    return hop;
  }
  return Object.freeze({
    record,
    list: ({ traceId, correlationId } = {}) => hops.filter((hop) => (!traceId || hop.traceId === traceId) && (!correlationId || hop.correlationId === correlationId)),
    compare: (expected, observed = hops) => compareObservedEdges(expected, observed),
    clear: () => { hops.length = 0; },
    snapshot: () => [...hops],
  });
}