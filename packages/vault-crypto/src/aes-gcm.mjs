import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export function deriveKekHkdf(raw, salt, info, length = 32) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.from(salt), Buffer.from(info), length));
}

export function deriveLegacyAesKey(raw, length = 32) {
  return Buffer.from(raw.slice(0, length).padEnd(length, "0"));
}

export function encryptAes256Gcm(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    typeof plaintext === "string" ? cipher.update(plaintext, "utf8") : cipher.update(plaintext),
    cipher.final(),
  ]);
  return { iv, encrypted, authTag: cipher.getAuthTag() };
}

export function decryptAes256Gcm(key, iv, encrypted, authTag, aad) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(authTag));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function packAesGcmHex(payload) {
  return `${payload.iv.toString("hex")}:${payload.encrypted.toString("hex")}:${payload.authTag.toString("hex")}`;
}

export function unpackAesGcmHex(packed, malformedMessage = "Malformed ciphertext (expected iv:ct:tag)") {
  const [ivHex, encryptedHex, tagHex] = packed.split(":");
  if (!ivHex || !encryptedHex || !tagHex) throw new Error(malformedMessage);
  return {
    iv: Buffer.from(ivHex, "hex"),
    encrypted: Buffer.from(encryptedHex, "hex"),
    authTag: Buffer.from(tagHex, "hex"),
  };
}