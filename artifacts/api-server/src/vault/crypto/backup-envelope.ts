/**
 * lib/vault-backup-envelope.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15c — Automatic Vault Backups.
 *
 * A manual export (routes/vault-snapshot.ts's POST /vault/snapshot/export)
 * is encrypted under a password the user types at that moment. A *scheduled*
 * backup has nobody present to type anything, so it can't use that scheme —
 * this module gives it a server-managed alternative using the same
 * KMS-style envelope pattern vault/crypto/field-encryption.ts established:
 *
 *   KEK  — VAULT_MASTER_KEY (or VAULT_FIELD_ENCRYPTION_KEY as a fallback),
 *          same environment secret vault/crypto/field-encryption.ts uses. Never stored.
 *          Derived via HKDF-SHA256 over the full secret (see the
 *          "Hardened KEK derivation" comment below) — not used raw.
 *   DEK  — a random 32-byte key, wrapped with the KEK and stored in
 *          encryption_keys under namespace "vault-backup" (a distinct chain
 *          from the field owner's "vault" namespace, so rotating one never
 *          touches the other).
 *
 * Blob format: "ENV1:<version>:<iv>:<authTag>:<ciphertext>" (iv/tag/ciphertext
 * base64) — deliberately different from the password-mode "AYZENBAK1:..."
 * prefix so routes/vault-snapshot.ts can tell at a glance which decrypt path
 * a stored row needs (see encryptionMode column).
 *
 * Rotating (rotateBackupEnvelopeKey()) is intentionally a separate call from
 * field-encryption.ts's rotateKey() — the two key chains are independent.
 *
 * Vault Backup hardening, Round 4 — per-owner AAD binding.
 * ─────────────────────────────────────────────────────────────────────────
 * The envelope DEK is ONE shared key per version, used for every user's
 * scheduled backup — unlike password mode, there's no per-user secret in
 * the mix at all. That's fine as long as decryption is only ever reached
 * through a path that already checked the caller owns the row (which is
 * how routes/vault-snapshot.ts's stored-snapshot download/restore worked).
 * But GET /vault/snapshots/:id/download intentionally hands the raw
 * "ENV1:..." blob back to its owner (§ that route's own doc comment: "an
 * automatic backup can still be moved off-vault by hand"), and
 * decryptSnapshotFromRequest() accepted a client-supplied `blob` directly
 * for restore-preview/restore. Put together: anyone who obtained ANY
 * user's envelope blob by any means (a support ticket, a misdirected
 * webhook/cloud delivery, a DB export, a paste into a shared doc) could
 * decrypt it themselves by POSTing it as `{ blob }` under their OWN
 * account — no password, because envelope mode never has one, and the
 * shared DEK doesn't care whose row it came from.
 *
 * Fixed in two independent layers (routes/vault-snapshot.ts carries the
 * first; this file carries the second):
 *   1. routes/vault-snapshot.ts no longer accepts a client-supplied `blob`
 *      for envelope-mode restore at all — only a snapshotId already
 *      filtered by the caller's own userId.
 *   2. Every NEW envelope blob (format bumped to "ENV2") now authenticates
 *      an AAD tag of `vault-backup:v<version>:user:<ownerUserId>` via
 *      AES-256-GCM's associated-data mechanism. Even if (1) were ever
 *      bypassed by a future bug — or a row's owner were altered by some
 *      other means, e.g. a SQL injection elsewhere in the app — decrypting
 *      under the wrong userId now fails the GCM auth tag exactly like
 *      decrypting under the wrong key, instead of happily returning
 *      someone else's snapshot. Legacy "ENV1:..." blobs (written before
 *      this round) have no AAD to check — those are handled by layer 1
 *      only, which is why layer 1 alone is not optional.
 */
import crypto from "crypto";
import {
  decryptAes256Gcm,
  deriveKekHkdf,
  deriveLegacyAesKey,
  encryptAes256Gcm,
  packAesGcmHex,
  unpackAesGcmHex,
} from "../../../../../packages/vault-crypto/src/aes-gcm.mjs";
import { getBackupEnvelopeKeyStore } from "./key-store-port";

const NAMESPACE = "vault-backup";
const PREFIX = "ENV1"; // legacy, no AAD — decrypt-only, see Round 4 comment above
const PREFIX_V2 = "ENV2"; // current — AAD-bound to the owning userId
const KEYLEN = 32;

function backupAad(version: number, ownerUserId: number): Buffer {
  return Buffer.from(`${NAMESPACE}:v${version}:user:${ownerUserId}`, "utf8");
}

function getRawKekSecret(): string {
  const raw = process.env["VAULT_MASTER_KEY"] || process.env["VAULT_FIELD_ENCRYPTION_KEY"];
  if (!raw || raw.length < 32) {
    throw new Error(
      "VAULT_MASTER_KEY (or VAULT_FIELD_ENCRYPTION_KEY) must be set (>= 32 chars) before " +
      "automatic vault backups can run — this key wraps the envelope key scheduled backups are encrypted under."
    );
  }
  return raw;
}

// Hardened KEK derivation — see the matching comment in vault/crypto/field-encryption.ts
// for the full rationale (the old `slice(0, 32).padEnd(32, "0")` truncated
// most of a properly-generated secret's entropy). Same fix here: HKDF-SHA256
// over the FULL raw secret, with a fallback to the legacy derivation on
// unwrap only, so already-wrapped envelope DEKs keep decrypting with no
// forced migration. Wrong-key attempts fail loudly via AES-GCM's auth tag,
// so trying the legacy key second is safe, never silently-wrong.
const ENV_KEK_HKDF_SALT = Buffer.from("ayzen:vault-backup-envelope:kek-v2", "utf8");
const ENV_KEK_HKDF_INFO = Buffer.from("kek", "utf8");
function deriveKekStrong(raw: string): Buffer {
  return deriveKekHkdf(raw, ENV_KEK_HKDF_SALT, ENV_KEK_HKDF_INFO, 32);
}
function getKek(): Buffer {
  return deriveKekStrong(getRawKekSecret());
}
function getLegacyKek(): Buffer {
  return deriveLegacyAesKey(getRawKekSecret(), 32);
}

function wrapDek(dek: Buffer): string {
  return packAesGcmHex(encryptAes256Gcm(getKek(), dek));
}
function unwrapDekWith(wrapped: string, kek: Buffer): Buffer {
  const { iv, encrypted, authTag } = unpackAesGcmHex(wrapped);
  return decryptAes256Gcm(kek, iv, encrypted, authTag);
}
function unwrapDek(wrapped: string): Buffer {
  try {
    return unwrapDekWith(wrapped, getKek());
  } catch {
    return unwrapDekWith(wrapped, getLegacyKek());
  }
}

const dekCache = new Map<number, Buffer>();
let activeVersion: number | null = null;
let ready = false;

async function bootstrapFirstKey(): Promise<void> {
  const dek = crypto.randomBytes(KEYLEN);
  await getBackupEnvelopeKeyStore().bootstrapFirstKey(NAMESPACE, wrapDek, dek);
}

/** Loads (or bootstraps) the vault-backup DEK chain. Call once at boot. */
export async function loadBackupEnvelopeKeyManager(): Promise<void> {
  const result: any = await getBackupEnvelopeKeyStore().loadKeys(NAMESPACE);
  const rows: any[] = result.rows ?? result;
  if (rows.length === 0) {
    await bootstrapFirstKey();
    return loadBackupEnvelopeKeyManager();
  }
  dekCache.clear();
  activeVersion = null;
  for (const r of rows) {
    dekCache.set(Number(r.version), unwrapDek(r.wrapped_dek));
    if (r.active) activeVersion = Number(r.version);
  }
  if (activeVersion === null) activeVersion = Number(rows[rows.length - 1].version);
  ready = true;
}

/** Generates a new DEK and makes it active for new scheduled backups. Old versions are kept. */
export async function rotateBackupEnvelopeKey(): Promise<number> {
  if (!ready) await loadBackupEnvelopeKeyManager();
  const newVersion = (activeVersion ?? 0) + 1;
  const dek = crypto.randomBytes(KEYLEN);
  await getBackupEnvelopeKeyStore().deactivateKeys(NAMESPACE);
  await getBackupEnvelopeKeyStore().insertRotatedKey(NAMESPACE, newVersion, wrapDek, dek);
  await loadBackupEnvelopeKeyManager();
  return newVersion;
}

export function getActiveBackupEnvelopeVersion(): number | null {
  return activeVersion;
}

/**
 * Encrypts a scheduled snapshot's plaintext JSON under the active envelope
 * DEK, AAD-bound to `ownerUserId` (see the Round 4 comment at the top of
 * this file) — always writes the current "ENV2:..." format.
 */
export async function envelopeEncryptBackup(plaintext: string, ownerUserId: number): Promise<{ blob: string; version: number }> {
  if (!ready) await loadBackupEnvelopeKeyManager();
  const version = activeVersion!;
  const dek = dekCache.get(version)!;
  const { iv, encrypted, authTag } = encryptAes256Gcm(dek, plaintext, backupAad(version, ownerUserId));
  const blob = [PREFIX_V2, version, iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
  return { blob, version };
}

/**
 * Decrypts an envelope-mode ("ENV1:..." or "ENV2:...") snapshot blob.
 * `ownerUserId` must be the userId of the vault_snapshots row this blob
 * came from (never a client-asserted value) — for "ENV2" blobs it's
 * cryptographically checked via AAD, so passing the wrong owner fails the
 * same way a wrong key would. "ENV1" (legacy, pre-Round-4) blobs carry no
 * AAD and decrypt regardless of `ownerUserId`; callers must not reach this
 * function with a blob whose row ownership hasn't already been verified by
 * a userId-scoped query — see routes/vault-snapshot.ts's Round 4 comment.
 * Throws on wrong format, a missing/rotated-out key, or an AAD mismatch.
 */
export async function envelopeDecryptBackup(blob: string, ownerUserId: number): Promise<string> {
  if (!ready) await loadBackupEnvelopeKeyManager();
  const parts = blob.trim().split(":");
  if (parts.length !== 5 || (parts[0] !== PREFIX && parts[0] !== PREFIX_V2)) {
    throw new Error("Not a valid envelope-encrypted vault backup");
  }
  const [prefix, versionStr, ivB64, tagB64, dataB64] = parts;
  const version = Number(versionStr);
  const dek = dekCache.get(version);
  if (!dek) throw new Error(`Envelope key v${version} is unavailable — cannot decrypt this backup`);
  const plaintext = decryptAes256Gcm(
    dek,
    Buffer.from(ivB64, "base64"),
    Buffer.from(dataB64, "base64"),
    Buffer.from(tagB64, "base64"),
    prefix === PREFIX_V2 ? backupAad(version, ownerUserId) : undefined,
  );
  return plaintext.toString("utf8");
}
