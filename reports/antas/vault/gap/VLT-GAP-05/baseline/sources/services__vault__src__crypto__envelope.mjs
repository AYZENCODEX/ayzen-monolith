import crypto from "node:crypto";

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
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64url"),
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      };
    },

    decrypt(record) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, Buffer.from(record.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
