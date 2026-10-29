import crypto from "node:crypto";
import type { DecisionRecord, IntelligenceResult, Signal } from "./types";

export interface AcieRepository {
  results: Map<string, IntelligenceResult>;
  signals: Map<string, Signal>;
  decisions: Map<string, DecisionRecord>;
  processedEvents: Set<string>;
  tenantOfResult: Map<string, string>;
}

export class InMemoryAcieRepository implements AcieRepository {
  readonly results = new Map<string, IntelligenceResult>();
  readonly signals = new Map<string, Signal>();
  readonly decisions = new Map<string, DecisionRecord>();
  readonly processedEvents = new Set<string>();
  readonly tenantOfResult = new Map<string, string>();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function iso(value?: string): string {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid timestamp");
  return parsed.toISOString();
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}