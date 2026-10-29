export interface AesGcmPayload {
  iv: Buffer;
  encrypted: Buffer;
  authTag: Buffer;
}

export function deriveKekHkdf(raw: string, salt: Uint8Array, info: Uint8Array, length?: number): Buffer;

export function deriveLegacyAesKey(raw: string, length?: number): Buffer;

export function encryptAes256Gcm(
  key: Uint8Array,
  plaintext: string | Uint8Array,
  aad?: Uint8Array,
): AesGcmPayload;

export function decryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  encrypted: Uint8Array,
  authTag: Uint8Array,
  aad?: Uint8Array,
): Buffer;

export function packAesGcmHex(payload: AesGcmPayload): string;

export function unpackAesGcmHex(
  packed: string,
  malformedMessage?: string,
): { iv: Buffer; encrypted: Buffer; authTag: Buffer };