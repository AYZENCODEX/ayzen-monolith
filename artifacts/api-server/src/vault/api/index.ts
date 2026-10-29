/**
 * API boundary marker. Route files (artifacts/api-server/src/routes/vault*.ts)
 * are the thin HTTP adapters and are mounted by routes/index.ts; they depend on
 * Vault application/security/domain code, never the reverse. VLT-GAP-14-B removed
 * the former re-exports of those route modules from here because a Vault layer
 * must not import the route layer it is called by (rule A5). Nothing imported
 * these re-exports.
 */
export {};
