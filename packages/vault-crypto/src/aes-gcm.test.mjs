import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  packAesGcmHex,
  unpackAesGcmHex,
} from "./aes-gcm.mjs";
import { createVaultCrypto } from "../../../services/vault/src/crypto/envelope.mjs";

test("shared AES-GCM preserves the historical hex envelope order", () => {
  const key = Buffer.alloc(32, 0x5a);
  const payload = encryptAes256Gcm(key, "recovery phrase");
  const packed = packAesGcmHex(payload);
  const parts = unpackAesGcmHex(packed);

  assert.equal(parts.iv.length, 12);
  assert.equal(parts.authTag.length, 16);
  assert.equal(
    decryptAes256Gcm(key, parts.iv, parts.encrypted, parts.authTag).toString("utf8"),
    "recovery phrase",
  );
});

test("shared AES-GCM supports raw DEK bytes without text conversion", () => {
  const key = Buffer.alloc(32, 0x2c);
  const dek = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const payload = encryptAes256Gcm(key, dek);
  const packed = packAesGcmHex(payload);
  const parts = unpackAesGcmHex(packed);

  assert.deepEqual(decryptAes256Gcm(key, parts.iv, parts.encrypted, parts.authTag), dek);
});

test("AAD-bound blobs reject a different owner context", () => {
  const key = Buffer.alloc(32, 0x19);
  const payload = encryptAes256Gcm(key, "scheduled backup", Buffer.from("vault-backup:user:7"));

  assert.equal(
    decryptAes256Gcm(key, payload.iv, payload.encrypted, payload.authTag, Buffer.from("vault-backup:user:7")).toString("utf8"),
    "scheduled backup",
  );
  assert.throws(() =>
    decryptAes256Gcm(key, payload.iv, payload.encrypted, payload.authTag, Buffer.from("vault-backup:user:8")),
  );
});

test("vault-service keeps its existing ciphertext/iv/tag object shape", () => {
  const serviceCrypto = createVaultCrypto("test-only-master-key");
  const record = serviceCrypto.encrypt("service payload");

  assert.deepEqual(Object.keys(record), ["ciphertext", "iv", "tag"]);
  assert.equal(serviceCrypto.decrypt(record), "service payload");
});
test("shared AES-GCM is wire-compatible with raw node:crypto in both directions", async () => {
  const { createCipheriv, createDecipheriv, randomBytes } = await import("node:crypto");
  const key = randomBytes(32);
  const aad = Buffer.from("ctx");

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update("snapshot é", "utf8"), cipher.final()]);
  assert.equal(decryptAes256Gcm(key, iv, encrypted, cipher.getAuthTag(), aad).toString("utf8"), "snapshot é");

  const payload = encryptAes256Gcm(key, "snapshot é", aad);
  const decipher = createDecipheriv("aes-256-gcm", key, payload.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(payload.authTag);
  assert.equal(Buffer.concat([decipher.update(payload.encrypted), decipher.final()]).toString("utf8"), "snapshot é");
});

test("shared AES-GCM rejects tampered ciphertext and wrong AAD", () => {
  const key = Buffer.alloc(32, 7);
  const p = encryptAes256Gcm(key, "secret", Buffer.from("a"));
  assert.throws(() => decryptAes256Gcm(key, p.iv, p.encrypted, p.authTag, Buffer.from("b")));
  const bad = Buffer.from(p.encrypted); bad[0] ^= 1;
  assert.throws(() => decryptAes256Gcm(key, p.iv, bad, p.authTag, Buffer.from("a")));
});
