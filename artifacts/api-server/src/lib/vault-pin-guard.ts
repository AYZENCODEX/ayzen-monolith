/**
 * Compatibility exports for callers not yet moved to the Vault security
 * owner. New consumers must import from ../vault/security/pin-guard.
 */
export {
  clearVaultPinFailures,
  isVaultPinLockedOut,
  requireVaultPin,
  type VaultPinCheckResult,
  hasVaultPin,
} from "../vault/security/pin-guard";
