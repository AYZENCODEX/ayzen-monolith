/**
 * Vault field-level encryption boundary.
 *
 * This module owns the Vault namespace key lifecycle and envelope format.
 * AES-256-GCM primitives are shared through aes-gcm.ts.
 * The former lib/vault-crypto.ts compatibility adapter was retired in
 * VLT-GAP-05-D after every consumer moved to this module.
 */
import crypto from "crypto";
import {
  decryptAes256Gcm,
  deriveKekHkdf,
  deriveLegacyAesKey,
  encryptAes256Gcm,
  unpackAesGcmHex,
} from "../../../../../packages/vault-crypto/src/aes-gcm.mjs";
import { getFieldKeyStore } from "./key-store-port";

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
  return deriveKekHkdf(raw, KEK_HKDF_SALT, KEK_HKDF_INFO, 32);
}
const KEK = deriveKekStrong(KEK_RAW);
const KEK_LEGACY = deriveLegacyAesKey(KEK_RAW, 32);

function aesEncrypt(key: Buffer, plain: string): string {
  const { iv, encrypted, authTag } = encryptAes256Gcm(key, plain);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${authTag.toString("hex")}`;
}

function aesDecrypt(key: Buffer, packed: string): string {
  const { iv, encrypted, authTag } = unpackAesGcmHex(packed);
  return decryptAes256Gcm(key, iv, encrypted, authTag).toString("utf8");
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
  await getFieldKeyStore().bootstrapFirstKey(NAMESPACE, wrapDek, dek);
}

export async function loadKeyManager(): Promise<void> {
  const result: any = await getFieldKeyStore().loadKeys(NAMESPACE);
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
  await getFieldKeyStore().deactivateKeys(NAMESPACE);
  await getFieldKeyStore().insertRotatedKey(NAMESPACE, newVersion, wrapDek);
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
