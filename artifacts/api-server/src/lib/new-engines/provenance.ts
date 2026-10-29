import crypto from "node:crypto";
import { canonicalize, iso, type InMemoryNewEngineStore } from "./store";
import type { EngineActor, ProvenanceRecord, ProvenanceVerification } from "./types";

export class ProvenanceEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  append(input: Omit<ProvenanceRecord, "id" | "previousHash" | "hash" | "occurredAt"> & { id?: string; occurredAt?: string }): ProvenanceRecord {
    const records = this.list(input.subject);
    const previousHash = records.at(-1)?.hash ?? null;
    const occurredAt = input.occurredAt ?? iso();
    const id = input.id ?? crypto.randomUUID();
    const unsigned = { id, subject: input.subject, source: input.source, actor: input.actor, action: input.action, decision: input.decision, evidence: input.evidence, previousHash, occurredAt };
    const hash = crypto.createHash("sha256").update(canonicalize(unsigned)).digest("hex");
    const record = { ...unsigned, hash };
    if (this.store.provenance.has(id)) return this.store.provenance.get(id)!;
    this.store.provenance.set(id, record);
    return record;
  }

  list(subject?: { type: string; id: string }): ProvenanceRecord[] {
    return [...this.store.provenance.values()]
      .filter((record) => !subject || (record.subject.type === subject.type && record.subject.id === subject.id))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  verify(subject?: { type: string; id: string }): ProvenanceVerification {
    const records = this.list(subject);
    let previousHash: string | null = null;
    for (const record of records) {
      const unsigned = { id: record.id, subject: record.subject, source: record.source, actor: record.actor, action: record.action, decision: record.decision, evidence: record.evidence, previousHash: record.previousHash, occurredAt: record.occurredAt };
      const expected = crypto.createHash("sha256").update(canonicalize(unsigned)).digest("hex");
      if (record.previousHash !== previousHash || record.hash !== expected) return { valid: false, checked: records.indexOf(record) + 1, firstInvalidId: record.id, reason: "Hash chain mismatch" };
      previousHash = record.hash;
    }
    return { valid: true, checked: records.length };
  }
}

export type { EngineActor };