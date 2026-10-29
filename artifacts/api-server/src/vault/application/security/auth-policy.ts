import { requireVaultPin } from "../../security/pin-guard";
import { AUTH_STEP_POLICIES, type AuthStepPolicy, getRow, upsertAuthStepPolicy } from "../../infrastructure/repositories/vault-security-repository";

export interface VaultSecurityResult { status: number; body: unknown }

/**
 * PUT /vault/security/auth-policy. Moved unchanged from
 * routes/vault-security.ts (VLT-GAP-06-B) — gated by the Vault PIN like
 * every other Vault-security mutation (requireVaultPin no-ops until a PIN
 * is set).
 */
export async function setAuthStepPolicy(userId: number, policy: unknown, vaultPin: unknown): Promise<VaultSecurityResult> {
  if (typeof policy !== "string" || !AUTH_STEP_POLICIES.includes(policy as AuthStepPolicy)) {
    return { status: 400, body: { error: "Invalid policy", solution: `policy must be one of: ${AUTH_STEP_POLICIES.join(", ")}` } };
  }

  const pinCheck = await requireVaultPin(userId, vaultPin);
  if (!pinCheck.ok) return { status: pinCheck.status, body: pinCheck.body };

  const existing = await getRow(userId);
  await upsertAuthStepPolicy(userId, policy as AuthStepPolicy, !!existing);
  return { status: 200, body: { ok: true, policy } };
}
