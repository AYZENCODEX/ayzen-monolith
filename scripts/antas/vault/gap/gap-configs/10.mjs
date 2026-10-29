// Config for scripts/antas/vault/gap/validate-gap.mjs — VLT-GAP-10 (Share / attachment).
import path from "node:path";
const API = "artifacts/api-server/src";
const SH = `${API}/vault/application/share`, AT = `${API}/vault/application/attachment`, REPOS = `${API}/vault/infrastructure/repositories`, SEC = `${API}/vault/security`;
const SHARES = `${API}/routes/vault-shares.ts`, ATTACH = `${API}/routes/vault-attachments.ts`;
const SHARE_REPO = `${REPOS}/vault-share-repository.ts`, ATTACH_REPO = `${REPOS}/vault-attachment-repository.ts`;
const SHARE_OWN = `${SEC}/share-ownership.ts`, ATTACH_OWN = `${SEC}/attachment-ownership.ts`;
const sm = (from, to, names) => names.map((name) => ({ from, name, to }));
// No standalone libs belong to this gap: both sources are routes, so everything moves as route symbols.
const moves = {};
const symbolMoves = [
  ...sm(SHARES, `${SH}/entity-types.ts`, ["ENTITY_TABLES", "notTrashedClause", "VALID_TYPES", "NON_SHAREABLE_COLUMNS", "safe", "ENTITY_TYPE_TO_RESOURCE_TYPE", "isValidType", "FieldPermission", "FieldPermissionMap"]),
  ...sm(SHARES, `${SH}/field-permissions.ts`, ["shareableColumns", "parseFieldPermissions", "filterToAllowedFields"]),
  ...sm(SHARES, SHARE_OWN, ["VAULT_SHARE_OWNER_SENTINEL_NONE", "vaultShareResource", "requireVaultShareOwnership", "denyVaultShareNotFound", "vaultShareBulkOwnershipEngine", "auditVaultShareBulkOwnership", "vaultShareCandidateOwnershipEngine", "auditVaultShareCreateOwnership"]),
  ...sm(ATTACH, ATTACH_OWN, ["VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE", "vaultAttachmentEntityResource", "requireVaultAttachmentEntityOwnership"]),
  ...sm(ATTACH, `${AT}/use-cases.ts`, ["MAX_ATTACHMENT_BYTES", "ALLOWED_CATEGORIES"]),
  ...sm(ATTACH, ATTACH_REPO, ["assertEntityOwnership"]),
];
const routes = {
  [SHARES]: {
    app: `${SH}/use-cases.ts`,
    literalFiles: [SHARES, `${SH}/use-cases.ts`, `${SH}/entity-types.ts`, `${SH}/field-permissions.ts`, SHARE_OWN, SHARE_REPO],
    symbols: ["createShare", "listShareableFields", "bulkCreateShares", "listSentShares", "listReceivedShares", "getEntityAccess", "bulkUpdateShares", "bulkDeleteShares", "updateShare", "deleteShare"],
    routes: ["POST /vault-shares", "GET /vault-shares/fields/:entityType", "POST /vault-shares/bulk", "GET /vault-shares/sent", "GET /vault-shares/received", "GET /vault-shares/entity/:entityType/:entityId", "PATCH /vault-shares/bulk", "DELETE /vault-shares/bulk", "PATCH /vault-shares/:id", "DELETE /vault-shares/:id"],
  },
  [ATTACH]: {
    app: `${AT}/use-cases.ts`,
    literalFiles: [ATTACH, `${AT}/use-cases.ts`, ATTACH_OWN, ATTACH_REPO],
    symbols: ["listAttachments", "uploadAttachment", "downloadAttachment", "updateAttachment", "deleteAttachment"],
    routes: ["GET /vault/:id/attachments", "POST /vault/:id/attachments", "GET /vault/:id/attachments/:attachmentId", "PATCH /vault/:id/attachments/:attachmentId", "DELETE /vault/:id/attachments/:attachmentId"],
  },
};
export default {
  gap: "VLT-GAP-10", dir: "reports/antas/vault/gap/VLT-GAP-10", api: API,
  differential: "scripts/antas/vault/gap/differential-vlt-gap-10.mjs",
  moves, routes, symbolMoves, repositories: [SHARE_REPO, ATTACH_REPO], extraOwners: [],
  repositoryExports: {
    [SHARE_REPO]: ["findOwnedEntityIdRows", "findShareTarget", "upsertShareRow", "listSentShareRows", "listReceivedShareRows", "listEntityRowsByIds", "getOwnedEntityRows", "getActiveShareFor", "getEntityRows", "bulkUpdateShareRows", "bulkDeleteShareRows", "getOwnedShareRow", "updateShareRows", "deleteShareRows"],
    [ATTACH_REPO]: ["assertEntityOwnership", "listAttachmentRows", "insertAttachmentRow", "getAttachmentRow", "updateAttachmentRows", "deleteAttachmentRow"],
  },
  allowedRouteImporters: [`${API}/routes/index.ts`, `${API}/vault/api/index.ts`],
  forbiddenInRoute: [/@workspace\/db/, /drizzle-orm/, /\bdb\s*\./, /\bsql(`|\.raw)/, /new\s+Map\s*[<(]/, /publishAyzenDomainEvent|createNotification/, /authorizeMany|PolicyEngine|createResourceOwnershipRule/, /decryptRow|encryptField|decryptField/, /logActivity/, /parseFieldPermissions|shareableColumns|filterToAllowedFields/],
  maxRouteLines: 200,
  typecheckExtra: [`${API}/index.ts`, `${API}/routes/organizations.ts`, `${API}/vault/application/index.ts`, `${API}/vault/infrastructure/index.ts`],
  mapRows: () => [
    `| Vault share route logic (vault-shares) | \`${SHARES}\` | \`${SH}/use-cases.ts\` | EXTRACTED (VLT-GAP-10); route is a thin adapter |`,
    `| Vault share entity registry (ENTITY_TABLES, VALID_TYPES, isValidType) | \`${SHARES}\` | \`${SH}/entity-types.ts\` | EXTRACTED (VLT-GAP-10); bodies unchanged |`,
    `| Vault share field permissions | \`${SHARES}\` | \`${SH}/field-permissions.ts\` | EXTRACTED (VLT-GAP-10); bodies unchanged |`,
    `| Vault share ownership gate and bulk audit | \`${SHARES}\` | \`${SHARE_OWN}\` | EXTRACTED (VLT-GAP-10); bodies unchanged |`,
    `| Vault share route DB access | \`${SHARES}\` | \`${SHARE_REPO}\` | EXTRACTED (VLT-GAP-10) |`,
    `| Vault attachment route logic (vault-attachments) | \`${ATTACH}\` | \`${AT}/use-cases.ts\` | EXTRACTED (VLT-GAP-10); route is a thin adapter |`,
    `| Vault attachment entity ownership gate | \`${ATTACH}\` | \`${ATTACH_OWN}\` | EXTRACTED (VLT-GAP-10); bodies unchanged |`,
    `| Vault attachment route DB access | \`${ATTACH}\` | \`${ATTACH_REPO}\` | EXTRACTED (VLT-GAP-10) |`,
  ],
};
