import crypto from "node:crypto";
import { iso, type InMemoryNewEngineStore } from "./store";
import type { LineageRecord } from "./types";

export class DataLineageEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  record(input: Omit<LineageRecord, "id" | "recordedAt"> & { id?: string; recordedAt?: string }): LineageRecord {
    const identity = JSON.stringify([input.runId, input.source, input.transformation, input.destination]);
    const id = input.id ?? crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
    const existing = this.store.lineage.get(id);
    if (existing) return existing;
    const record = { ...input, id, recordedAt: input.recordedAt ?? iso() };
    this.store.lineage.set(id, record);
    return record;
  }

  list(filters: { sourceId?: string; destinationId?: string; runId?: string } = {}): LineageRecord[] {
    return [...this.store.lineage.values()].filter((item) =>
      (!filters.sourceId || item.source.id === filters.sourceId) &&
      (!filters.destinationId || item.destination.id === filters.destinationId) &&
      (!filters.runId || item.runId === filters.runId),
    );
  }

  upstream(destinationId: string, depth = 10): LineageRecord[] {
    return this.walk(destinationId, "upstream", depth);
  }

  downstream(sourceId: string, depth = 10): LineageRecord[] {
    return this.walk(sourceId, "downstream", depth);
  }

  impact(destinationId: string): { records: LineageRecord[]; sources: string[] } {
    const records = this.upstream(destinationId);
    return { records, sources: [...new Set(records.map((record) => record.source.id))] };
  }

  private walk(id: string, direction: "upstream" | "downstream", depth: number): LineageRecord[] {
    const result: LineageRecord[] = [];
    const visited = new Set<string>();
    let frontier = new Set([id]);
    for (let level = 0; level <= Math.min(depth, 50) && frontier.size; level++) {
      const next = new Set<string>();
      for (const record of this.store.lineage.values()) {
        const matches = direction === "upstream" ? frontier.has(record.destination.id) : frontier.has(record.source.id);
        if (!matches || visited.has(record.id)) continue;
        visited.add(record.id);
        result.push(record);
        next.add(direction === "upstream" ? record.source.id : record.destination.id);
      }
      frontier = next;
    }
    return result;
  }
}