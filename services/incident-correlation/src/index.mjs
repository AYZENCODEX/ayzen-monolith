import { redactSecrets } from "@ayzen/enforcement-core";

export function createIncidentTimeline({ now = () => new Date().toISOString() } = {}) {
  const sources = new Map();
  function append({ correlationId, source, type, payload, occurredAt = now() } = {}) {
    if (!correlationId || !source || !type) throw new Error("correlationId, source, and type are required");
    const item = Object.freeze({ correlationId, source, type, payload: redactSecrets(payload ?? {}), occurredAt });
    const items = sources.get(correlationId) ?? [];
    items.push(item);
    sources.set(correlationId, items);
    return item;
  }
  return Object.freeze({
    append,
    timeline: (correlationId) => [...(sources.get(correlationId) ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
    ids: () => [...sources.keys()],
    completeness: (correlationId, requiredSources = []) => {
      const seen = new Set((sources.get(correlationId) ?? []).map((item) => item.source));
      return { required: requiredSources, missing: requiredSources.filter((source) => !seen.has(source)), complete: requiredSources.every((source) => seen.has(source)) };
    },
  });
}