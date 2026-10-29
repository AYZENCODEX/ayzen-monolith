/**
 * Vault field-level encryption boundary.
 *
 * This module owns the KMS-style envelope format used by Vault credentials.
 * The legacy lib/vault-crypto.ts path remains a compatibility adapter for
 * consumers that have not moved yet.
 */
import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const NAMESPACE = "vault";
const PREFIX = "enc:";
const LEGACY_KEY_RAW = process.env["VAULT_FIELD_ENCRYPTION_KEY"];
if (!LEGACY_KEY_RAW || LEGACY_KEY_RAW.length < 32) {
  throw new Error(
    "VAULT_FIELD_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it as a strong " +
    "random secret in your environment before starting the API server."
  );
}
const LEGACY_KEY = Buffer.from(LEGACY_KEY_RAW.slice(0, 32).padEnd(32, "0"));
const KEK_RAW = process.env["VAULT_MASTER_KEY"] || LEGACY_KEY_RAW;
const KEK_HKDF_SALT = Buffer.from("ayzen:vault-crypto:kek-v2", "utf8");
const KEK_HKDF_INFO = Buffer.from("kek", "utf8");

function deriveKekStrong(raw: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), KEK_HKDF_SALT, KEK_HKDF_INFO, 32));
}
function deriveKekLegacy(raw: string): Buffer {
  return Buffer.from(raw.slice(0, 32).padEnd(32, "0"));
}
const KEK = deriveKekStrong(KEK_RAW);
const KEK_LEGACY = deriveKekLegacy(KEK_RAW);

function aesEncrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
}

function aesDecrypt(key: Buffer, packed: string): string {
  const [ivHex, encHex, tagHex] = packed.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext (expected iv:ct:tag)");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

function wrapDek(dek: Buffer): string {
  return aesEncrypt(KEK, dek.toString("hex"));
}
function unwrapDek(wrapped: string): Buffer {
  try {
    return Buffer.from(aesDecrypt(KEK, wrapped), "hex");
  } catch {
    return Buffer.from(aesDecrypt(KEK_LEGACY, wrapped), "hex");
  }
}

const dekCache = new Map<number, Buffer>();
let activeVersion: number | null = null;
let ready = false;

async function bootstrapFirstKey(): Promise<void> {
  const dek = crypto.randomBytes(32);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, 1, ${wrapDek(dek)}, TRUE)
    ON CONFLICT (namespace, version) DO NOTHING
  `);
}

export async function loadKeyManager(): Promise<void> {
  const result: any = await db.execute(
    sql`SELECT version, wrapped_dek, active FROM encryption_keys WHERE namespace = ${NAMESPACE} ORDER BY version ASC`
  );
  const rows: any[] = result.rows ?? result;
  if (rows.length === 0) {
    await bootstrapFirstKey();
    return loadKeyManager();
  }
  dekCache.clear();
  activeVersion = null;
  for (const row of rows) {
    dekCache.set(Number(row.version), unwrapDek(row.wrapped_dek));
    if (row.active) activeVersion = Number(row.version);
  }
  if (activeVersion === null) activeVersion = Number(rows[rows.length - 1].version);
  ready = true;
}

export async function rotateKey(): Promise<number> {
  if (!ready) await loadKeyManager();
  const newVersion = (activeVersion ?? 0) + 1;
  await db.execute(sql`UPDATE encryption_keys SET active = FALSE WHERE namespace = ${NAMESPACE}`);
  await db.execute(sql`
    INSERT INTO encryption_keys (namespace, version, wrapped_dek, active)
    VALUES (${NAMESPACE}, ${newVersion}, ${wrapDek(crypto.randomBytes(32))}, TRUE)
  `);
  await loadKeyManager();
  return newVersion;
}

export function getActiveVersion(): number | null {
  return activeVersion;
}

export function encryptField<T extends string | null | undefined>(value: T): T {
  if (value === null || value === undefined || value === "") return value;
  if (!ready || activeVersion === null) return (PREFIX + aesEncrypt(LEGACY_KEY, String(value))) as T;
  return (PREFIX + "v" + activeVersion + ":" + aesEncrypt(dekCache.get(activeVersion)!, String(value))) as T;
}

export function decryptField<T extends string | null | undefined>(value: T): T {
  if (value === null || value === undefined || value === "") return value;
  const stored = String(value);
  if (!stored.startsWith(PREFIX)) return value;
  try {
    const rest = stored.slice(PREFIX.length);
    const versioned = rest.match(/^v(\d+):(.+)$/);
    if (versioned) {
      const dek = dekCache.get(Number(versioned[1]));
      return (dek ? aesDecrypt(dek, versioned[2]) : "[decryption failed: unknown key version]") as T;
    }
    return aesDecrypt(LEGACY_KEY, rest) as T;
  } catch {
    return "[decryption failed]" as T;
  }
}

export function decryptRow<T extends Record<string, any>>(row: T, fields: readonly (keyof T)[]): T {
  const out = { ...row };
  for (const field of fields) out[field] = decryptField(out[field] as any);
  return out;
}

export function decryptRows<T extends Record<string, any>>(rows: T[], fields: readonly (keyof T)[]): T[] {
  return rows.map((row) => decryptRow(row, fields));
}
