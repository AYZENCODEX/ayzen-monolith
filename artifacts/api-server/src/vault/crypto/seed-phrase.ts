import crypto from "crypto";
import { decryptAes256Gcm, encryptAes256Gcm } from "../../../../../packages/vault-crypto/src/aes-gcm.mjs";

const SEED_KEY_RAW = process.env["VAULT_SEED_ENCRYPTION_KEY"];
if (!SEED_KEY_RAW || SEED_KEY_RAW.length < 32) {
  throw new Error(
    "VAULT_SEED_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it as a strong " +
    "random secret (e.g. `openssl rand -hex 32`), distinct from SESSION_SECRET and " +
    "VAULT_FIELD_ENCRYPTION_KEY, before starting the API server — this key protects every " +
    "crypto wallet seed phrase stored in Vault."
  );
}

const KEY_BUF = crypto.scryptSync(SEED_KEY_RAW, "ayzen_seed_salt", 32);

export function encryptSeedPhrase(plaintext: string): string {
  const { iv, encrypted, authTag } = encryptAes256Gcm(KEY_BUF, plaintext);
  return iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptSeedPhrase(stored: string): string | null {
  try {
    const [ivHex, tagHex, encHex] = stored.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    return decryptAes256Gcm(KEY_BUF, iv, enc, tag).toString("utf8");
  } catch {
    return null;
  }
}
