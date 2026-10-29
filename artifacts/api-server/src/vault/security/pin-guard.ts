import { verifyPassword } from "../../lib/password";
import { selectVaultSecurityForRequireVaultPin } from "../infrastructure/repositories/vault-security-repository";

// Public Vault-security surface for the legacy lib/vault-pin-guard compatibility shim (VLT-GAP-14-B).
export { hasVaultPin } from "../infrastructure/repositories/vault-security-repository";

const FAILED_ATTEMPT_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failedAttempts = new Map<number, { count: number; lockedUntil: number }>();

export function isVaultPinLockedOut(userId: number): number {
  const entry = failedAttempts.get(userId);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

function recordFailure(userId: number): void {
  const entry = failedAttempts.get(userId) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedAttempts.set(userId, entry);
}

export function clearVaultPinFailures(userId: number): void {
  failedAttempts.delete(userId);
}

export type VaultPinCheckResult =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Verifies `pin` against this user's Vault Security PIN. Returns { ok: true }
 * when either the PIN is correct OR no Vault PIN has been set yet (nothing
 * to gate on). Callers should short-circuit their response with
 * `res.status(result.status).json(result.body)` on failure.
 */
export async function requireVaultPin(userId: number, pin: unknown): Promise<VaultPinCheckResult> {
  const lockedMs = isVaultPinLockedOut(userId);
  if (lockedMs > 0) {
    return {
      ok: false,
      status: 429,
      body: {
        error: "Too many attempts",
        code: "VAULT_PIN_LOCKED",
        solution: `Wait ${Math.ceil(lockedMs / 1000)}s before trying again.`,
        retryAfterMs: lockedMs,
      },
    };
  }

  const [row] = await selectVaultSecurityForRequireVaultPin(userId);

  if (!row?.vaultPinHash) {
    // Nothing set yet — this is only reachable before the mandatory
    // first-time PIN setup completes. Nothing to check against.
    return { ok: true };
  }

  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Vault PIN is required", code: "VAULT_PIN_REQUIRED" },
    };
  }

  const matches = await verifyPassword(pin, row.vaultPinHash);
  if (!matches) {
    recordFailure(userId);
    return {
      ok: false,
      status: 401,
      body: { error: "Incorrect Vault PIN", code: "WRONG_VAULT_PIN" },
    };
  }

  clearVaultPinFailures(userId);
  return { ok: true };
}