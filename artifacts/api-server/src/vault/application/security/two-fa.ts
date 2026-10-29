import QRCode from "qrcode";
import { generateBase32Secret, totpVerify, totpUri } from "../../../lib/totp";
import { requireVaultPin } from "../../security/pin-guard";
import { getRow, upsertVaultTwoFaSecret, setVaultTwoFaEnabled, disableVaultTwoFa } from "../../infrastructure/repositories/vault-security-repository";
import { selectUsersForSendVaultPinSetupCode } from "../../infrastructure/repositories/vault-security-repository";

export interface VaultSecurityResult { status: number; body: unknown }

/**
 * Vault 2FA — Vault's OWN TOTP, separate from account login 2FA. Same RFC
 * 6238 TOTP flow as routes/security.ts's /security/2fa/*, but reads and
 * writes vault_security.vault_two_fa_secret / vault_two_fa_enabled instead
 * of users.two_fa_secret / two_fa_enabled — so enabling, disabling, or
 * resetting one never touches the other. Moved unchanged from
 * routes/vault-security.ts (VLT-GAP-06-B).
 */

/** GET /vault/security/2fa/status. */
export async function getVaultTwoFaStatus(userId: number): Promise<VaultSecurityResult> {
  const row = await getRow(userId);
  return { status: 200, body: { enabled: !!row?.vaultTwoFaEnabled } };
}

/** POST /vault/security/2fa/setup — generate a new secret + QR (not yet enabled). */
export async function setupVaultTwoFa(userId: number): Promise<VaultSecurityResult> {
  const [user] = await selectUsersForSendVaultPinSetupCode(userId);
  if (!user) return { status: 404, body: { error: "User not found" } };

  const secret = generateBase32Secret();
  const existing = await getRow(userId);
  await upsertVaultTwoFaSecret(userId, secret, !!existing);

  // Distinct label from the account's own 2FA entry so both can coexist in
  // the same authenticator app without overwriting one another.
  const otpauth = totpUri(secret, `${user.email} (Vault)`);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { status: 200, body: { secret, qrDataUrl, otpauth } };
}

/** POST /vault/security/2fa/verify — confirm a 6-digit code to enable. */
export async function verifyVaultTwoFa(userId: number, token: unknown, vaultPin: unknown): Promise<VaultSecurityResult> {
  if (typeof token !== "string" || !token) return { status: 400, body: { error: "token is required" } };

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) return { status: pinCheck.status, body: pinCheck.body };

  const row = await getRow(userId);
  if (!row?.vaultTwoFaSecret) return { status: 400, body: { error: "Run Vault 2FA setup first" } };
  if (!totpVerify(token, row.vaultTwoFaSecret)) return { status: 400, body: { error: "Invalid or expired code" } };

  await setVaultTwoFaEnabled(userId);
  return { status: 200, body: { enabled: true } };
}

/** POST /vault/security/2fa/disable. */
export async function disableVaultTwoFaRoute(userId: number, vaultPin: unknown): Promise<VaultSecurityResult> {
  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) return { status: pinCheck.status, body: pinCheck.body };

  await disableVaultTwoFa(userId);
  return { status: 200, body: { enabled: false } };
}
