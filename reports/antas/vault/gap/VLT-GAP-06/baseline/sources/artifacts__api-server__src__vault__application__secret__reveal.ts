import { chargeCredits } from "../../../services/credit-meter";
import { decryptSeedPhrase } from "../../crypto/seed-phrase";
import { logVaultActivity } from "../entity/activity";
import { selectVaultOne } from "../../infrastructure/repositories/entity-repository";
import { selectOrgSeedRevealBlock } from "../../infrastructure/repositories/secret-repository";

/**
 * Seed-phrase reveal use-case (VLT-GAP-05-B). Body moved unchanged from
 * GET /vault/:id/seed in routes/vault.ts: same gate order (org extension policy →
 * entity-PIN reveal token → entry lookup → seed presence → decrypt), same status codes and
 * bodies, same best-effort audit entry, same charge-on-success credit semantics.
 * The reveal-token store (routes/vault-security, owned by GAP-06) is injected as a port because the
 * application layer must not import the API layer.
 */

export interface SecretResult { status: number; body: unknown }
export interface SecretRevealDeps {
  hasNoEntityPin: (userId: number) => Promise<boolean>;
  consumeRevealToken: (userId: number, token: string | undefined | null) => boolean;
}

export async function revealSeedPhrase(
  userId: number,
  idParam: string | string[],
  headerToken: string | undefined,
  queryToken: unknown,
  deps: SecretRevealDeps,
): Promise<SecretResult> {
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);

  // Phase 8 — managed extension policy (master plan §2/§9). An org
  // owner/admin can set organization_extension_policies.disable_seed_reveal
  // to block this endpoint for every ACTIVE member of that org, regardless
  // of which entity they're revealing — enforced server-side (not
  // just an Astra UI toggle) since this is the actual seed-reveal
  // choke point every other read/autofill path already goes through. Any
  // one org membership with the flag set is enough to block; a user who
  // wants seed reveal back has to leave that org or ask an admin to relax
  // the policy, not bypass it entity-by-entity.
  const orgBlock = await selectOrgSeedRevealBlock(userId);
  if (orgBlock.length) {
    return {
      status: 403,
      body: {
        error: "Seed phrase reveal is disabled by your organization's extension policy",
        code: "ORG_SEED_REVEAL_DISABLED",
      },
    };
  }

  const pinless = await deps.hasNoEntityPin(userId);
  if (!pinless) {
    const token = (headerToken ?? queryToken) as string | undefined;
    if (!deps.consumeRevealToken(userId, token)) {
      return {
        status: 403,
        body: {
          error: "Reveal token missing or expired",
          code: "REVEAL_TOKEN_REQUIRED",
          solution: "Verify your entity PIN again — the reveal token is single-use and expires quickly.",
        },
      };
    }
  }

  const entry = await selectVaultOne(id, userId);
  if (!entry) return { status: 404, body: { error: "Vault entry not found" } };
  const encSeed = entry.encrypted_seed_phrase ?? entry.encryptedSeedPhrase ?? null;
  if (!encSeed) return { status: 404, body: { error: "No seed phrase stored for this entity" } };
  const plaintext = decryptSeedPhrase(encSeed as string);
  if (!plaintext) return { status: 500, body: { error: "Failed to decrypt seed phrase" } };
  logVaultActivity(id, userId, "seed_revealed");
  // Charge-on-success: only after the seed was actually decrypted and is
  // about to be returned — a missing seed / decrypt failure above never
  // costs the user credits.
  const charge = await chargeCredits(userId, "sylo.credential_access");
  return { status: 200, body: { seedPhrase: plaintext, _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null } };
}
