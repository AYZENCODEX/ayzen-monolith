/**
 * Compatibility adapter for the extracted Vault crypto boundary.
 * Keep this import path until all existing jobs and adapters have migrated.
 */
export {
  decryptField,
  decryptRow,
  decryptRows,
  encryptField,
  getActiveVersion,
  loadKeyManager,
  rotateKey,
} from "../vault/crypto/field-encryption";
