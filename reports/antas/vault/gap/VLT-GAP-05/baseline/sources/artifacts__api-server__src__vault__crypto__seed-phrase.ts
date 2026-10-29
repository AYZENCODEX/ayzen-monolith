import crypto from "crypto";

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
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY_BUF, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

export function decryptSeedPhrase(stored: string): string | null {
  try {
    const [ivHex, tagHex, encHex] = stored.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const enc = Buffer.from(encHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY_BUF, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}
