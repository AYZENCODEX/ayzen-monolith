import crypto from "node:crypto";
import { decryptAes256Gcm, encryptAes256Gcm } from "../../../../packages/vault-crypto/src/aes-gcm.mjs";

/**
 * Compatibility-preserving AES-256-GCM envelope.
 * The serialized shape is intentionally { ciphertext, iv, tag }.
 */
export function createVaultCrypto(configuredMasterKey) {
  if (!configuredMasterKey) {
    throw new Error("SYLO_MASTER_KEY is required; vault refuses to start with an ephemeral encryption key");
  }

  const masterKey = crypto.createHash("sha256").update(configuredMasterKey).digest();

  return {
    encrypt(plaintext) {
      const { iv, encrypted, authTag } = encryptAes256Gcm(masterKey, String(plaintext));
      return {
        ciphertext: encrypted.toString("base64url"),
        iv: iv.toString("base64url"),
        tag: authTag.toString("base64url"),
      };
    },

    decrypt(record) {
      return decryptAes256Gcm(
        masterKey,
        Buffer.from(record.iv, "base64url"),
        Buffer.from(record.ciphertext, "base64url"),
        Buffer.from(record.tag, "base64url"),
      ).toString("utf8");
    },
  };
}
