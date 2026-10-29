import type { Request } from "express";
import { pepDecisionObserver } from "../../middlewares/auth";
import { PolicyEngine } from "../../lib/policy/policy-engine";
import { createResourceOwnershipRule } from "../../lib/policy/resource";
import { authorize } from "../../lib/policy/pep";

/**
 * Passkey-credential ownership check for Vault re-auth. Extracted verbatim from
 * routes/vault-reauth.ts (VLT-GAP-06-D), including its Route Integration
 * Roadmap Season C / Phase C2 rationale:
 *
 * A passkey credential belongs to exactly one account, so
 * `createResourceOwnershipRule()` alone is registered — no role-override rule,
 * same strict posture as routes/passkey.ts's PATCH/DELETE /passkey/:id.
 * `authorize()` is called inline (not via a route-level `requireOwnership()`
 * middleware) because the credential row is already fetched by the handler for
 * the WebAuthn verification step right after it — a middleware would re-run
 * that lookup. A missing credential is given the sentinel ownerId below, which
 * the ownership rule can never ALLOW (ALLOW requires ownerId === subject.userId),
 * so "not found" and "not yours" DENY identically.
 */
export const VAULT_REAUTH_OWNER_SENTINEL_NONE = -1;

const vaultReauthOwnershipEngine = new PolicyEngine({ onDecision: pepDecisionObserver });
vaultReauthOwnershipEngine.registerRule("resource-ownership", createResourceOwnershipRule());

export async function isPasskeyOwnedBySession(
  req: Request,
  cred: { id: number | string; userId: number } | undefined,
  credentialId: string,
): Promise<boolean> {
  const decision = await authorize({
    req,
    engine: vaultReauthOwnershipEngine,
    action: "vault.reauth.passkey_verify",
    resource: { type: "passkey.credential", id: cred?.id ?? credentialId, ownerId: cred?.userId ?? VAULT_REAUTH_OWNER_SENTINEL_NONE },
  });
  return decision.decision.effect === "ALLOW";
}
