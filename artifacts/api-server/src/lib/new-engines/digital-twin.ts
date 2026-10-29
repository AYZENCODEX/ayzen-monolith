import crypto from "node:crypto";
import { canonicalize, iso } from "./store";
import type { AdvancedEngineStore } from "./advanced-store";
import type { TwinEvent, TwinProjection } from "./advanced-types";

export class DigitalTwinEngine {
  constructor(private readonly store: AdvancedEngineStore) {}
  append(event: TwinEvent): TwinEvent {
    if (this.store.twinEvents.has(event.id)) return this.store.twinEvents.get(event.id)!;
    this.store.twinEvents.set(event.id, { ...event, occurredAt: iso(event.occurredAt) });
    return this.store.twinEvents.get(event.id)!;
  }
  project(aggregateType: string, aggregateId: string, reducer: (state: Record<string, unknown>, event: TwinEvent) => Record<string, unknown>): TwinProjection {
    const key = `${aggregateType}:${aggregateId}`;
    const current = this.store.twinProjections.get(key);
    const events = [...this.store.twinEvents.values()]
      .filter((event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId)
      .sort((a, b) => a.version - b.version || a.occurredAt.localeCompare(b.occurredAt));
    const start = current?.lastEventId ? events.findIndex((event) => event.id === current.lastEventId) + 1 : 0;
    let state = current?.state ?? {};
    for (const event of events.slice(Math.max(0, start))) state = reducer(state, event);
    const projection = { id: current?.id ?? crypto.randomUUID(), aggregateType, aggregateId, version: events.at(-1)?.version ?? current?.version ?? 0, state, lastEventId: events.at(-1)?.id ?? current?.lastEventId, updatedAt: iso() };
    this.store.twinProjections.set(key, projection);
    return projection;
  }
  rebuild(aggregateType: string, aggregateId: string, reducer: (state: Record<string, unknown>, event: TwinEvent) => Record<string, unknown>): TwinProjection {
    this.store.twinProjections.delete(`${aggregateType}:${aggregateId}`);
    return this.project(aggregateType, aggregateId, reducer);
  }
  drift(aggregateType: string, aggregateId: string, expected: Record<string, unknown>): { drifted: boolean; differences: string[] } {
    const projection = this.store.twinProjections.get(`${aggregateType}:${aggregateId}`);
    const differences = Object.keys({ ...expected, ...(projection?.state ?? {}) }).filter((key) => canonicalize(expected[key]) !== canonicalize(projection?.state[key]));
    return { drifted: differences.length > 0, differences };
  }
}