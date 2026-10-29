/**
 * API compatibility boundary. Route files remain the public adapters while
 * domain, application, and infrastructure ownership moves behind this tree.
 */
export { default as vaultRoutes } from "../../routes/vault";
export { default as vaultSecurityRoutes } from "../../routes/vault-security";
export { default as vaultSnapshotRoutes } from "../../routes/vault-snapshot";
export { default as vaultBackupCloudRoutes } from "../../routes/vault-backup-cloud";
