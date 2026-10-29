import crypto from "crypto";
import { decryptAes256Gcm, encryptAes256Gcm } from "../../../../../../packages/vault-crypto/src/aes-gcm.mjs";

/** Extracted verbatim from routes/vault-snapshot.ts (VLT-GAP-09); bodies unchanged. */

// v1 (legacy, read-only): scrypt at Node's default cost (N=16384, r=8, p=1).
// v2 (current): scrypt at a much higher cost, matching current OWASP
// guidance for password-derived encryption keys — an offline attacker who
// steals a .ayzenbak file or a vault_snapshots row now has to spend ~8x the
// memory-hard work per password guess than under v1. The cost parameters
// aren't recoverable from the blob itself (scryptSync needs them to match
// exactly), so this is versioned by prefix rather than silently swapped:
// old "AYZENBAK1" backups keep decrypting at the v1 cost forever, every new
// export is written as "AYZENBAK2" at the v2 cost. There's no in-place
// upgrade path for existing exported files (nothing server-side to touch —
// they're already out in users' downloads folders / cloud storage); anyone
// wanting the stronger KDF on an old backup just re-exports.
export const BLOB_PREFIX_V1 = "AYZENBAK1";
export const BLOB_PREFIX_V2 = "AYZENBAK2";
export const MIN_SNAPSHOT_PASSWORD_LENGTH = 10;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_V2_COST = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
export function deriveKey(password: string, salt: Buffer, version: 1 | 2): Buffer {
  if (version === 1) return crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_V2_COST);
}
export function encryptBlob(password: string, plaintext: string): string {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt, 2);
  const { iv, encrypted: enc, authTag: tag } = encryptAes256Gcm(key, plaintext);
  return [BLOB_PREFIX_V2, salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}
export function decryptBlob(password: string, blob: string): string {
  const parts = blob.trim().split(":");
  const prefix = parts[0];
  if (parts.length !== 5 || (prefix !== BLOB_PREFIX_V1 && prefix !== BLOB_PREFIX_V2)) {
    throw new Error("Not a valid AYZEN vault snapshot file");
  }
  const version: 1 | 2 = prefix === BLOB_PREFIX_V2 ? 2 : 1;
  const [, saltB64, ivB64, tagB64, dataB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const key = deriveKey(password, salt, version);
  try {
    return decryptAes256Gcm(key, iv, data, tag).toString("utf8");
  } catch {
    throw new Error("Incorrect password, or the snapshot file is corrupted");
  }
}