import crypto from "node:crypto";
import { documentKey, iso, type InMemoryNewEngineStore } from "./store";
import type { RebuildJob, SearchDocument, SearchHit, SearchQuery } from "./types";

function terms(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function fingerprint(document: SearchDocument): string {
  const { indexedAt: _indexedAt, ...content } = document as SearchDocument & { indexedAt?: string };
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export class SearchIndexEngine {
  constructor(private readonly store: InMemoryNewEngineStore) {}

  index(document: SearchDocument): SearchDocument & { indexedAt: string } {
    if (!document.indexName || !document.entityType || !document.entityId) {
      throw new Error("indexName, entityType and entityId are required");
    }
    const key = documentKey(document);
    const current = this.store.searchDocuments.get(key);
    const next = { ...document, indexedAt: current?.indexedAt ?? iso() };
    if (!current || fingerprint(current) !== fingerprint(document)) {
      next.indexedAt = iso();
      this.store.searchDocuments.set(key, next);
    }
    return this.store.searchDocuments.get(key)!;
  }

  remove(document: Pick<SearchDocument, "indexName" | "entityType" | "entityId">): boolean {
    return this.store.searchDocuments.delete(documentKey(document));
  }

  search(query: SearchQuery): { hits: SearchHit[]; total: number; offset: number; limit: number } {
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const requestedTerms = terms(query.query ?? "");
    const candidates = [...this.store.searchDocuments.values()]
      .filter((document) => document.indexName === query.indexName)
      .filter((document) => !query.entityType || document.entityType === query.entityType)
      .filter((document) => !query.filters || Object.entries(query.filters).every(([key, value]) => document.fields?.[key] === value))
      .filter((document) => !query.canRead || query.canRead(document));
    const ranked = candidates
      .map((document) => {
        const haystack = terms([document.title ?? "", document.text, JSON.stringify(document.fields ?? {})].join(" "));
        const score = requestedTerms.length === 0
          ? 1
          : requestedTerms.reduce((total, term) => total + (haystack.includes(term) ? (document.title?.toLocaleLowerCase().includes(term) ? 3 : 1) : 0), 0) / requestedTerms.length;
        return { document, score };
      })
      .filter(({ score }) => requestedTerms.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.document.entityId.localeCompare(b.document.entityId));
    return {
      hits: ranked.slice(offset, offset + limit).map(({ document, score }) => ({ ...document, score })),
      total: ranked.length,
      offset,
      limit,
    };
  }

  startRebuild(indexName: string, documents: SearchDocument[], indexVersion = 1): RebuildJob {
    const id = crypto.randomUUID();
    const now = iso();
    this.store.rebuildJobs.set(id, {
      id, indexName, indexVersion, total: documents.length, processed: 0, nextCursor: 0,
      status: documents.length ? "PENDING" : "COMPLETED", createdAt: now, updatedAt: now, documents: documents.map((item) => ({ ...item, indexName })),
    });
    return this.publicJob(this.store.rebuildJobs.get(id)!);
  }

  resumeRebuild(id: string, batchSize = 100): RebuildJob {
    const job = this.store.rebuildJobs.get(id);
    if (!job) throw new Error("Rebuild job not found");
    if (job.status === "COMPLETED") return this.publicJob(job);
    const end = Math.min(job.documents.length, job.nextCursor + Math.max(1, Math.min(batchSize, 1000)));
    for (const document of job.documents.slice(job.nextCursor, end)) this.index({ ...document, version: job.indexVersion });
    job.nextCursor = end;
    job.processed = end;
    job.status = end >= job.documents.length ? "COMPLETED" : "RUNNING";
    job.updatedAt = iso();
    return this.publicJob(job);
  }

  private publicJob(job: RebuildJob & { documents: SearchDocument[] }): RebuildJob {
    const { documents: _documents, ...publicJob } = job;
    return publicJob;
  }
}