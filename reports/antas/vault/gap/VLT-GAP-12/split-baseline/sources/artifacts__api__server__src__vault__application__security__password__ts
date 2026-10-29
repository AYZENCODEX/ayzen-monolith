import { hashPassword, verifyPassword } from "../../../lib/password";
import { isLockedOut, recordFailure, clearFailures } from "../../security/lockout";
import { requireVaultPin } from "../../security/pin-guard";
import { getRow, upsertVaultPasswordHash, clearVaultPasswordHash } from "../../infrastructure/repositories/vault-security-repository";

export interface VaultSecurityResult { status: number; body: unknown }
const MIN_VAULT_PASSWORD_LENGTH = 8;

/**
 * PUT /vault/security/password — set or change the Vault Auth Password.
 * Moved unchanged from routes/vault-security.ts (VLT-GAP-06-B).
 * currentPassword is required only when a vault password is already set
 * (same "prove you know the existing one before overwriting it" rule as
 * setPin()). This is NOT the account login password.
 */
export async function setVaultPassword(userId: number, password: unknown, currentPassword: unknown, vaultPin: unknown): Promise<VaultSecurityResult> {
  const lockedMs = isLockedOut(userId, "password");
  if (lockedMs > 0) {
    return { status: 429, body: { error: "Too many attempts", code: "PASSWORD_LOCKED", solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`, retryAfterMs: lockedMs } };
  }

  if (typeof password !== "string" || password.length < MIN_VAULT_PASSWORD_LENGTH) {
    return { status: 400, body: { error: "Invalid password", solution: `Vault password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.` } };
  }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) return { status: pinCheck.status, body: pinCheck.body };

  const existing = await getRow(userId);

  if (existing?.vaultPasswordHash) {
    if (typeof currentPassword !== "string" || !currentPassword) {
      return { status: 400, body: { error: "Current vault password required", solution: "Provide currentPassword to change it." } };
    }
    const matches = await verifyPassword(currentPassword, existing.vaultPasswordHash);
    if (!matches) {
      recordFailure(userId, "password");
      return { status: 403, body: { error: "Incorrect current vault password", code: "WRONG_CURRENT_PASSWORD" } };
    }
  }

  const newHash = await hashPassword(password);
  await upsertVaultPasswordHash(userId, newHash, !!existing);

  clearFailures(userId, "password");
  return { status: 200, body: { ok: true } };
}

/**
 * POST /vault/security/password/disable — revert to the account password.
 * Moved unchanged from routes/vault-security.ts (VLT-GAP-06-B). Clears
 * vaultPasswordHash. If no Vault PIN is set either, this leaves the account
 * with no fallback credential — Vault re-auth then has only the passkey
 * path (or is entirely inaccessible without one); the frontend warns about
 * this before calling here.
 */
export async function disableVaultPassword(userId: number, vaultPin: unknown): Promise<VaultSecurityResult> {
  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) return { status: pinCheck.status, body: pinCheck.body };

  await clearVaultPasswordHash(userId);
  return { status: 200, body: { ok: true } };
}
