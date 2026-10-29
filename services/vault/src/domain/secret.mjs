export function tenantMatches(record, tenant) {
  return (!tenant.workspaceId || record.workspaceId === tenant.workspaceId)
    && (!tenant.organizationId || record.organizationId === tenant.organizationId);
}

export function metadataOnly(record) {
  const { ciphertext, iv, tag, ...metadata } = record;
  return metadata;
}

export function createSecretRecord({ id, name, tenant, encrypted, now }) {
  return {
    id,
    name,
    version: 1,
    ...tenant,
    ...encrypted,
    createdAt: now,
    updatedAt: now,
  };
}
