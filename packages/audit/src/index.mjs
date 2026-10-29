import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEY = /secret|token|password|private|plaintext|credential|authorization|cookie|key/i;

export function redactAuditValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 2_000) : value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[redacted]" : redactAuditValue(item, depth + 1),
  ]));
}

export function createAuditRecord(input = {}, previousHash = "GENESIS") {
  if (typeof input.action !== "string" || !input.action.trim()) throw new Error("Audit action is required");
  if (typeof input.service !== "string" || !input.service.trim()) throw new Error("Audit service is required");
  const record = {
    schemaVersion: 1,
    id: input.id ?? crypto.randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    service: input.service,
    action: input.action,
    outcome: input.outcome ?? "success",
    ...(input.actor ? { actor: redactAuditValue(input.actor) } : {}),
    ...(input.tenant ? { tenant: redactAuditValue(input.tenant) } : {}),
    ...(input.resource ? { resource: redactAuditValue(input.resource) } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    metadata: redactAuditValue(input.metadata ?? {}),
    previousHash,
  };
  return Object.freeze({
    ...record,
    hash: crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  });
}

export function createAuditStore({ maxEntries = 10_000, filePath } = {}) {
  const records = [];
  let chainAnchor = "GENESIS";
  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(saved)) records.push(...saved.slice(-maxEntries));
      else if (Array.isArray(saved?.records)) {
        records.push(...saved.records.slice(-maxEntries));
        chainAnchor = saved.anchor ?? "GENESIS";
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ anchor: chainAnchor, records }));
    fs.renameSync(temporary, filePath);
  }
  return Object.freeze({
    append(input) {
      const record = createAuditRecord(input, records.at(-1)?.hash ?? chainAnchor);
      records.push(record);
      while (records.length > maxEntries) chainAnchor = records.shift().hash;
      persist();
      return record;
    },
    list({ service, tenantId, action } = {}) {
      return records.filter((record) =>
        (!service || record.service === service)
        && (!action || record.action === action)
        && (!tenantId || record.tenant?.organizationId === tenantId || record.tenant?.workspaceId === tenantId));
    },
    verifyChain() {
      let previousHash = chainAnchor;
      for (const record of records) {
        const { hash, ...content } = record;
        const expected = crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
        if (record.previousHash !== previousHash || hash !== expected) return false;
        previousHash = hash;
      }
      return true;
    },
  });
}