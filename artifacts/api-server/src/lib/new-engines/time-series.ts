import crypto from "node:crypto";
import { iso, type InMemoryNewEngineStore } from "./store";
import type { StoredTimeSeriesPoint, TimeSeriesAggregate, TimeSeriesPoint, TimeSeriesQuery } from "./types";

export class TimeSeriesEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  append(input: TimeSeriesPoint): StoredTimeSeriesPoint {
    const timestamp = iso(input.timestamp);
    const id = input.id ?? crypto.createHash("sha256").update(JSON.stringify([input.series, timestamp, input.value, input.tags ?? {}])).digest("hex");
    const points = this.store.timeSeries.get(input.series) ?? [];
    const existing = points.find((point) => point.id === id);
    if (existing) return existing;
    const point = { ...input, id, timestamp };
    delete (point as { timestamp?: string | Date }).timestamp;
    const stored = { ...point, timestamp } as StoredTimeSeriesPoint;
    points.push(stored);
    points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.store.timeSeries.set(input.series, points);
    return stored;
  }

  query(input: TimeSeriesQuery): StoredTimeSeriesPoint[] {
    const from = input.from ? new Date(input.from).getTime() : -Infinity;
    const to = input.to ? new Date(input.to).getTime() : Infinity;
    return (this.store.timeSeries.get(input.series) ?? [])
      .filter((point) => new Date(point.timestamp).getTime() >= from && new Date(point.timestamp).getTime() <= to)
      .filter((point) => !input.tags || Object.entries(input.tags).every(([key, value]) => point.tags?.[key] === value))
      .slice(0, Math.min(10000, input.limit ?? 10000));
  }

  aggregate(input: TimeSeriesQuery & { bucketMs: number }): TimeSeriesAggregate[] {
    if (!Number.isInteger(input.bucketMs) || input.bucketMs < 1) throw new Error("bucketMs must be a positive integer");
    const buckets = new Map<number, number[]>();
    for (const point of this.query(input)) {
      const bucket = Math.floor(new Date(point.timestamp).getTime() / input.bucketMs) * input.bucketMs;
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), point.value]);
    }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([start, values]) => ({
      bucketStart: new Date(start).toISOString(),
      bucketEnd: new Date(start + input.bucketMs).toISOString(),
      count: values.length,
      sum: values.reduce((total, value) => total + value, 0),
      min: Math.min(...values),
      max: Math.max(...values),
      average: values.reduce((total, value) => total + value, 0) / values.length,
    }));
  }

  applyRetention(series: string, retentionMs: number, now = Date.now()): number {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("retentionMs must be non-negative");
    const points = this.store.timeSeries.get(series) ?? [];
    const kept = points.filter((point) => new Date(point.timestamp).getTime() >= now - retentionMs);
    this.store.timeSeries.set(series, kept);
    return points.length - kept.length;
  }
}