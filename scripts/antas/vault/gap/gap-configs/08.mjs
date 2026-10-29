// Config for scripts/antas/vault/gap/validate-gap.mjs — VLT-GAP-08 (Backup/restore).
import path from "node:path";
const API = "artifacts/api-server/src";
const REPOSITORY = `${API}/vault/infrastructure/repositories/vault-backup-repository.ts`;
const moves = {
  [`${API}/lib/vault-backup-envelope.ts`]: `${API}/vault/crypto/backup-envelope.ts`,
  [`${API}/lib/vault-backup-audit.ts`]: `${API}/vault/infrastructure/backup/audit.ts`,
  [`${API}/lib/vault-backup-cloud.ts`]: `${API}/vault/infrastructure/backup/cloud.ts`,
  [`${API}/lib/vault-backup-delivery.ts`]: `${API}/vault/infrastructure/backup/delivery.ts`,
  [`${API}/lib/vault-backup-alerts.ts`]: `${API}/vault/infrastructure/backup/alerts.ts`,
  [`${API}/lib/vault-backup-key-rotation-cron.ts`]: `${API}/vault/infrastructure/backup/key-rotation-cron.ts`,
  [`${API}/lib/vault-backup-schedule-cron.ts`]: `${API}/vault/application/backup/schedule-cron.ts`,
};
const refinedMoves = {
  [`${API}/vault/crypto/backup-envelope.ts`]: "The AES-GCM implementation now uses the shared vault-crypto owner; the live GAP-08 differential verifies the backup-envelope contract.",
  [`${API}/vault/infrastructure/backup/audit.ts`]: "The owner was subsequently aligned with the GAP-12 repository boundary; the live GAP-08 differential verifies its current behavior.",
  [`${API}/vault/infrastructure/backup/cloud.ts`]: "The owner was subsequently aligned with the GAP-12 infrastructure boundary; the live GAP-08 differential verifies its current behavior.",
  [`${API}/vault/infrastructure/backup/delivery.ts`]: "The owner was subsequently aligned with the GAP-12 infrastructure boundary; the live GAP-08 differential verifies its current behavior.",
  [`${API}/vault/infrastructure/backup/key-rotation-cron.ts`]: "The owner was subsequently aligned with the GAP-12 repository boundary; the live GAP-08 differential verifies its current behavior.",
  [`${API}/vault/application/backup/schedule-cron.ts`]: "The owner was subsequently aligned with the GAP-12 repository boundary; the live GAP-08 differential verifies its current behavior.",
};
const symbolSuccessors = {
  [`${API}/lib/vault-backup-envelope.ts#deriveKekLegacy`]: {
    file: "packages/vault-crypto/src/aes-gcm.mjs",
    name: "deriveLegacyAesKey",
    reason: "Private KEK derivation now uses the shared crypto package's exported legacy-compatible derivation helper.",
  },
};
const consumerSuccessors = {
  [`${API}/lib/vault-backup-envelope.ts`]: {
    [`${API}/routes/vault-snapshot.ts`]: [`${API}/vault/application/snapshot/use-cases.ts`],
  },
};
const rk = `${API}/routes/vault-backup-key.ts`, rc = `${API}/routes/vault-backup-cloud.ts`, rs = `${API}/routes/vault-backup-schedule.ts`;
const A = `${API}/vault/application/backup`;
const routes = {
  [rk]: { app: `${A}/key.ts`, literalFiles: [rk, `${A}/key.ts`, REPOSITORY], symbols: ["getBackupKeyStatus", "rotateBackupKey", "getAdminBackupAuditLog"], routes: ["GET /admin/vault-backup/key-status", "POST /admin/vault-backup/rotate-key", "GET /admin/vault-backup/audit-log"] },
  [rc]: { app: `${A}/cloud-connection.ts`, literalFiles: [rc, `${A}/cloud-connection.ts`], symbols: ["listOwnCloudConnections", "startCloudConnect", "handleCloudCallback", "disconnectCloud"], routes: ["GET /vault/backup/cloud", "GET /vault/backup/cloud/:provider/connect", "GET /vault/backup/cloud/:provider/callback", "DELETE /vault/backup/cloud/:provider"] },
  [rs]: { app: `${A}/schedule.ts`, literalFiles: [rs, `${A}/schedule.ts`, REPOSITORY], symbols: ["getSchedule", "saveSchedule", "runScheduleNow", "listDeliveries", "getOwnAuditLog"], routes: ["GET /vault/backup/schedule", "PUT /vault/backup/schedule", "POST /vault/backup/schedule/run-now", "GET /vault/backup/deliveries", "GET /vault/backup/audit-log"] },
};
export default {
  gap: "VLT-GAP-08", dir: "reports/antas/vault/gap/VLT-GAP-08", api: API,
  differential: "scripts/antas/vault/gap/differential-vlt-gap-08.mjs",
  moves, refinedMoves, symbolSuccessors, consumerSuccessors, routes, symbolMoves: [], repositories: [REPOSITORY], extraOwners: [],
  allowedRouteImporters: [`${API}/routes/index.ts`, `${API}/vault/api/index.ts`],
  forbiddenInRoute: [/@workspace\/db/, /drizzle-orm/, /\bdb\s*\./, /\bsql`/, /new\s+Map\s*[<(]/, /\bcrypto\./, /assertPublicHttpsUrl|computeNextRunAt|runVaultBackupSchedule/, /logBackupAudit|listBackupAudit|listOwnBackupAuditLog|redactUrl/, /rotateBackupEnvelopeKey|getActiveBackupEnvelopeVersion/, /buildAuthorizeUrl|completeCloudConnect|verifyAuthorizeState|listCloudConnections|disconnectCloudProvider/, /logActivity/],
  maxRouteLines: 160,
  typecheckExtra: [`${API}/index.ts`, `${API}/lib/dr-test-runner.ts`],
  mapRows: () => [
    ...Object.entries(moves).map(([o, n]) => `| Vault backup ${path.basename(o, ".ts").replace("vault-backup-", "")} | \`${o}\` | \`${n}\` | RETIRED (VLT-GAP-08); old file removed; current owner behavior is differential-verified |`),
    ...Object.entries(routes).map(([o, r]) => `| Vault backup route logic (${path.basename(o, ".ts")}) | \`${o}\` | \`${r.app}\` | EXTRACTED (VLT-GAP-08); thin adapter; current differential PASS |`),
    `| Vault backup route DB access | \`${rs}\`, \`${rk}\` | \`${REPOSITORY}\` | EXTRACTED (VLT-GAP-08) |`,
  ],
};
