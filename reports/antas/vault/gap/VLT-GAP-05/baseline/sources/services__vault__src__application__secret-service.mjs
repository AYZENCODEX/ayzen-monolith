import crypto from "node:crypto";
import { createSecretRecord, metadataOnly, tenantMatches } from "../domain/secret.mjs";

export function createSecretApplication({ records, vaultCrypto, vaultAccess, audit, publish }) {
  return {
    list({ tenant }) {
      return [...records.values()]
        .filter((record) => tenantMatches(record, tenant))
        .map(metadataOnly);
    },

    async create({ body, tenant, auth, requestId }) {
      if (!body.name || typeof body.value !== "string") {
        return { status: 400, body: { error: "name and value are required", code: "INVALID_SECRET" } };
      }
      const id = crypto.randomUUID();
      const encrypted = vaultCrypto.encrypt(body.value);
      const now = new Date().toISOString();
      const record = createSecretRecord({ id, name: body.name, tenant, encrypted, now });
      records.set(id, record);
      audit.record({ action: "vault.secret.create", actor: auth, tenant, resource: id, requestId, metadata: { version: record.version } });
      await publish.publish({
        eventType: "vault.secret.updated",
        payload: { secretId: id, version: record.version, operation: "created" },
        actor: auth,
        ...tenant,
        aggregate: { type: "vault_secret", id },
      });
      return { status: 201, body: { id, name: record.name, version: record.version, ...tenant, createdAt: record.createdAt } };
    },

    async reveal({ id, tenant, auth, request, requestId }) {
      const record = records.get(id);
      if (!record) return { status: 404, body: { error: "Secret not found", code: "SECRET_NOT_FOUND" } };
      if (tenant.workspaceId && record.workspaceId && tenant.workspaceId !== record.workspaceId) {
        return { status: 403, body: { error: "Tenant isolation failed", code: "TENANT_MISMATCH" } };
      }
      const stepUp = vaultAccess.verifyReveal(request, { auth, tenant });
      if (!stepUp.valid) {
        return { status: 428, body: { error: "Fresh single-use step-up authorization is required", code: stepUp.reason } };
      }
      const value = vaultCrypto.decrypt(record);
      audit.record({ action: "vault.secret.access", actor: auth, tenant, resource: record.id, requestId, metadata: { version: record.version } });
      await publish.publish({
        eventType: "vault.secret.accessed",
        payload: { secretId: record.id, version: record.version },
        actor: auth,
        ...tenant,
        aggregate: { type: "vault_secret", id: record.id },
      });
      return { status: 200, body: { id: record.id, name: record.name, version: record.version, value, ...tenant } };
    },
  };
}
