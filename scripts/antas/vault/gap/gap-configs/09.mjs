// Config for scripts/antas/vault/gap/validate-gap.mjs — VLT-GAP-09 (Snapshot / trash).
import path from "node:path";
const API = "artifacts/api-server/src";
const S = `${API}/vault/application/snapshot`, T = `${API}/vault/infrastructure/trash`;
const ROUTE = `${API}/routes/vault-snapshot.ts`;
const REPO = `${API}/vault/infrastructure/repositories/vault-snapshot-repository.ts`;
const OWN = `${API}/vault/security/snapshot-ownership.ts`;
const moves = {
  [`${API}/lib/vault-snapshot-restore.ts`]: `${S}/restore.ts`,
  [`${API}/lib/vault-snapshot-extra.ts`]: `${S}/sections.ts`,
  [`${API}/lib/vault-snapshot-trash-purge.ts`]: `${T}/snapshot-trash-purge.ts`,
  [`${API}/lib/vault-snapshot-trash-cron.ts`]: `${T}/snapshot-trash-cron.ts`,
  [`${API}/lib/vault-trash-purge.ts`]: `${T}/entry-trash-purge.ts`,
  [`${API}/lib/vault-trash-cron.ts`]: `${T}/entry-trash-cron.ts`,
};
const refinedMoves = {
  [`${S}/restore.ts`]: "Restore was subsequently aligned with the GAP-12 repository boundary; the live GAP-09 differential verifies restore behavior.",
};
const successorOwners = {
  [`${S}/sections.ts`]: `${API}/vault/infrastructure/repositories/snapshot-sections-repository.ts`,
};
const symbolSuccessors = {
  [`${API}/lib/vault-snapshot-restore.ts#DbHandle`]: {
    file: `${API}/vault/infrastructure/repositories/snapshot-restore-repository.ts`,
    name: "DbHandle",
    reason: "The private database adapter type now belongs to the snapshot repository and is imported by the restore use-case.",
  },
  [`${API}/lib/vault-snapshot-restore.ts#RestoreTableKey`]: {
    file: `${API}/vault/domain/snapshot-restore-keys.ts`,
    name: "RestoreTableKey",
    reason: "The public restore-table key union now belongs to the snapshot domain module and is imported by the application use-case.",
  },
};
const refinedSymbolMoves = {
  [`${ROUTE}#buildVaultSnapshotPayload`]: "The snapshot payload owner was refined after extraction; the live GAP-09 differential checks snapshot payload and route compatibility.",
  [`${ROUTE}#pruneOldSnapshots`]: "The prune implementation was refined at its repository boundary; the live GAP-09 differential checks snapshot lifecycle behavior.",
  [`${ROUTE}#storeSnapshotRow`]: "The snapshot persistence call was moved behind the repository boundary; the live GAP-09 differential checks snapshot storage behavior.",
  [`${ROUTE}#vaultSnapshotResource`]: "The ownership resource was centralized in the snapshot security module; the live GAP-09 differential checks access behavior.",
  [`${ROUTE}#decryptSnapshotFromRequest`]: "The restore request use-case was refined behind the application boundary; the live GAP-09 differential checks the current request contract.",
};
const consumerSuccessors = {
  [`${API}/lib/vault-snapshot-restore.ts`]: {
    [`${API}/vault/infrastructure/index.ts`]: [`${S}/use-cases.ts`],
  },
};
const sm = (to, names) => names.map((name) => ({ from: ROUTE, name, to }));
const symbolMoves = [
  ...sm(`${S}/blob.ts`, ["BLOB_PREFIX_V1", "BLOB_PREFIX_V2", "MIN_SNAPSHOT_PASSWORD_LENGTH", "SCRYPT_KEYLEN", "SCRYPT_V2_COST", "deriveKey", "encryptBlob", "decryptBlob"]),
  ...sm(`${S}/payload.ts`, ["safeDecryptPhrase", "buildVaultSnapshotPayload"]),
  ...sm(`${S}/store.ts`, ["MAX_STORED_SNAPSHOTS", "DEFAULT_STORAGE_QUOTA_BYTES", "MAX_TOTAL_SNAPSHOT_BYTES", "verifyStoredChecksum", "pruneOldSnapshots", "StoreSnapshotRowInput", "storeSnapshotRow"]),
  ...sm(OWN, ["VAULT_SNAPSHOT_OWNER_SENTINEL_NONE", "vaultSnapshotResource", "requireVaultSnapshotOwnershipStrictId"]),
  ...sm(`${S}/use-cases.ts`, ["decryptSnapshotFromRequest"]),
];
const routes = {
  [ROUTE]: {
    app: `${S}/use-cases.ts`,
    literalFiles: [
      ROUTE,
      `${S}/use-cases.ts`,
      `${S}/blob.ts`,
      `${S}/payload.ts`,
      `${S}/store.ts`,
      `${S}/restore.ts`,
      `${API}/vault/infrastructure/repositories/vault-snapshot-payload-repository.ts`,
      `${API}/vault/infrastructure/repositories/snapshot-sections-repository.ts`,
      `${API}/vault/infrastructure/repositories/snapshot-restore-repository.ts`,
      OWN,
      REPO,
    ],
    symbols: ["exportSnapshot", "listSnapshots", "getSnapshotStorage", "downloadSnapshot", "renameSnapshot", "trashSnapshot", "listTrashedSnapshots", "untrashSnapshot", "purgeSnapshot", "previewRestore", "restoreFromSnapshot"],
    routes: ["POST /vault/snapshot/export", "GET /vault/snapshots", "GET /vault/snapshots/storage", "GET /vault/snapshots/:id/download", "PATCH /vault/snapshots/:id", "DELETE /vault/snapshots/:id", "GET /vault/snapshots/trash", "POST /vault/snapshots/:id/restore", "DELETE /vault/snapshots/trash/:id", "POST /vault/snapshot/restore-preview", "POST /vault/snapshot/restore"],
  },
};
export default {
  gap: "VLT-GAP-09", dir: "reports/antas/vault/gap/VLT-GAP-09", api: API,
  differential: "scripts/antas/vault/gap/differential-vlt-gap-09.mjs",
  moves, refinedMoves, successorOwners, symbolSuccessors, refinedSymbolMoves, consumerSuccessors, routes, symbolMoves, repositories: [REPO], extraOwners: [],
  allowedRouteImporters: [`${API}/routes/index.ts`, `${API}/vault/api/index.ts`],
  forbiddenInRoute: [/@workspace\/db/, /drizzle-orm/, /\bdb\s*\./, /\bsql`/, /new\s+Map\s*[<(]/, /\bcrypto\b/, /scrypt|createHash|randomBytes/, /\b(encryptBlob|decryptBlob|deriveKey|buildVaultSnapshotPayload|storeSnapshotRow|pruneOldSnapshots|verifyStoredChecksum)\b/, /applyRestoreDiff|buildRestoreDiff/, /logActivity|logBackupAudit|isAnomalousBackupIp|alertOwnerOfAnomalousBackupAccess/, /getClientIp/],
  maxRouteLines: 200,
  // scripts/src/{encrypt,decrypt}-env.ts define their own unrelated deriveKey(passphrase, salt) for .env files; it is not the snapshot KDF.
  duplicateAllow: { deriveKey: ["scripts/src/decrypt-env.ts", "scripts/src/encrypt-env.ts"] },
  typecheckExtra: [`${API}/index.ts`, `${API}/lib/dr-test-runner.ts`, `${API}/vault/application/backup/schedule-cron.ts`, `${API}/vault/application/entity/bulk.ts`, `${API}/vault/application/entity/lifecycle.ts`, `${API}/vault/application/index.ts`, `${API}/vault/infrastructure/index.ts`],
  mapRows: () => [
    ...Object.entries(moves).map(([o, n]) => {
      const owner = successorOwners[n] ?? n;
      return `| Vault ${path.basename(o, ".ts").replace("vault-", "")} | \`${o}\` | \`${owner}\` | RETIRED (VLT-GAP-09); old file removed; current owner behavior is differential-verified |`;
    }),
    `| Vault snapshot route logic (vault-snapshot) | \`${ROUTE}\` | \`${S}/use-cases.ts\` | EXTRACTED (VLT-GAP-09); thin adapter; current differential PASS |`,
    `| Vault snapshot blob crypto (scrypt + AES-GCM envelope format) | \`${ROUTE}\` | \`${S}/blob.ts\` | EXTRACTED (VLT-GAP-09); current differential PASS |`,
    `| Vault snapshot payload builder | \`${ROUTE}\` | \`${S}/payload.ts\` | EXTRACTED (VLT-GAP-09); current differential PASS |`,
    `| Vault snapshot store / prune / checksum | \`${ROUTE}\` | \`${S}/store.ts\` | EXTRACTED (VLT-GAP-09); current differential PASS |`,
    `| Vault snapshot ownership gate | \`${ROUTE}\` | \`${OWN}\` | EXTRACTED (VLT-GAP-09); current differential PASS |`,
    `| Vault snapshot route DB access | \`${ROUTE}\` | \`${REPO}\` | EXTRACTED (VLT-GAP-09) |`,
  ],
};
