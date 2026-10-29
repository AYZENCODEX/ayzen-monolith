import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, createDocumentIndexer } from "./indexing.mjs";

function fakeStore() {
  const map = new Map();
  return { map, set: (id, value) => map.set(id, value) };
}

test("tokenize lowercases and splits on non-alphanumeric runs, dropping single characters", () => {
  const tokens = tokenize("Invoice #482 — Q3 Renewal!");
  assert.deepEqual([...tokens].sort(), ["482", "invoice", "q3", "renewal"]);
});

test("indexDocument writes a document with tokens derived from title + content", () => {
  const store = fakeStore();
  const audit = { entries: [], record(entry) { this.entries.push(entry); } };
  const indexer = createDocumentIndexer({ documents: store, audit, randomUUID: () => "doc-1" });

  const document = indexer.indexDocument({ sourceId: "msg-1", title: "Renewal notice", content: "Your plan renews Q3", tenant: { workspaceId: "ws-1" }, actor: { subject: "user:1" } });

  assert.equal(document.id, "doc-1");
  assert.equal(document.sourceId, "msg-1");
  assert.equal(document.workspaceId, "ws-1");
  assert.ok(document.tokens.includes("renewal"));
  assert.ok(document.tokens.includes("renews"));
  assert.equal(store.map.get("doc-1"), document);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].action, "search.document.index");
  assert.equal(audit.entries[0].metadata.sourceId, "msg-1");
});

test("indexDocument requires sourceId and content, same as POST /api/search/documents", () => {
  const indexer = createDocumentIndexer({ documents: fakeStore() });
  assert.throws(() => indexer.indexDocument({ sourceId: "msg-1", content: "" }), /sourceId and content are required/);
  assert.throws(() => indexer.indexDocument({ sourceId: "", content: "hello" }), /sourceId and content are required/);
});

test("indexDocument defaults title to sourceId when none is given", () => {
  const store = fakeStore();
  const indexer = createDocumentIndexer({ documents: store, randomUUID: () => "doc-2" });
  const document = indexer.indexDocument({ sourceId: "txn-1", content: "Coffee purchase" });
  assert.equal(document.title, "txn-1");
});
