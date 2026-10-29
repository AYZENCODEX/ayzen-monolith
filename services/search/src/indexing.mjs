import crypto from "node:crypto";

/**
 * Phase H7.3 — this module is the indexing logic that used to live inline
 * inside the POST /api/search/documents handler. Pulling it out means the
 * event-driven consumers registered in ./event-handlers.mjs can call it
 * directly, in-process, instead of the service making an HTTP request to
 * itself to reach the exact same code path.
 */

export function tokenize(value) {
  return new Set(String(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

/**
 * @param documents a service-state store (the same one POST /api/search/documents writes to)
 * @param audit     the service's audit log
 * @param publish   Audit finding (event/workflow/notification/scheduler/policy
 *                  wiring pass): `search.document.indexed` was declared in
 *                  `emittedEvents` (services/search/src/index.mjs) with no
 *                  publish() call anywhere — every index write was silent
 *                  on the bus, so nothing else in the system (e.g. an
 *                  admin/observability consumer) could ever react to a
 *                  document actually being indexed. Optional and
 *                  best-effort: indexing must not fail (and the document
 *                  must not go un-indexed) just because the publish side
 *                  of this call has trouble — same posture as ai/index.mjs's
 *                  own `.catch(() => {})` on its failure-path publish.
 */
export function createDocumentIndexer({ documents, audit, publish, randomUUID = () => crypto.randomUUID() }) {
  if (!documents || typeof documents.set !== "function") throw new Error("documents store is required");
  return {
    /**
     * Same validation and same document shape POST /api/search/documents
     * produces — sourceId and content are required there and here, so an
     * event handler with nothing real to index (H7.3 rather not index a
     * document built from an ID alone) should fail loudly, not persist a
     * partial document.
     */
    indexDocument({ sourceId, title, content, tenant = {}, actor }) {
      if (!sourceId || !content) throw new Error("sourceId and content are required");
      const document = {
        id: randomUUID(),
        sourceId,
        title: title ?? sourceId,
        content,
        tokens: [...tokenize(`${title ?? ""} ${content}`)],
        ...tenant,
        indexedAt: new Date().toISOString(),
      };
      documents.set(document.id, document);
      audit?.record?.({ action: "search.document.index", actor, tenant, resource: document.id, metadata: { sourceId: document.sourceId } });
      if (publish) {
        publish.publish({
          eventType: "search.document.indexed",
          payload: { documentId: document.id, sourceId: document.sourceId },
          actor,
          ...tenant,
          aggregate: { type: "search_document", id: document.id },
        }).catch(() => {});
      }
      return document;
    },
  };
}
