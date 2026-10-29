import { encryptField } from "../../../lib/vault-crypto";
import { findBridgedLocalAccount, insertBridgedLocalAccount } from "../../infrastructure/repositories/local-account-consumer-repository";

/**
 * Entity ↔ Local bridge (VLT-GAP-02-C). Moved VERBATIM from routes/vault.ts
 * `autoCreateLocalAccountsForEntity`; the two SQL statements now live in the
 * consumer repository. Same loop, same guards, same encryption, same
 * best-effort error swallowing.
 *
 * Platforms whose tab data can also live as a standalone local_accounts row
 * (Twitter/Discord/Telegram; Wallet/Other don't have a matching local-account shape).
 */
export const BRIDGE_PLATFORMS = ["twitter", "discord", "telegram"] as const;

// When a vault entity (Entity) is created or edited and a platform tab was
// filled in directly (not via LocalEntityPicker's import-from-local flow),
// mirror that platform slot into its own local_accounts row so it also shows
// up under Local — same data, same account, just visible in both places.
// Rows created this way are tagged origin='entity' (vs the 'standalone'
// default) so the Local UI can badge them as auto-created. Best-effort: never
// blocks or fails the calling entity create/edit request.
export async function autoCreateLocalAccountsForEntity(
  userId: number,
  vaultEntryId: number,
  body: Record<string, unknown>,
): Promise<void> {
  for (const platform of BRIDGE_PLATFORMS) {
    const username = body[`${platform}Username`];
    if (!username || typeof username !== "string" || !username.trim()) continue;

    try {
      // Already has a local account for this platform slot (either a prior
      // auto-create or an explicit import/link) — don't create a duplicate.
      const existing = await findBridgedLocalAccount(userId, vaultEntryId, platform);
      if (existing.rows.length > 0) continue;

      const password = body[`${platform}Password`];
      const email = platform === "telegram" ? body.telegramLinkedEmail : body[`${platform}Email`];
      const twofa = body[`${platform}2fa`];
      const followers = body[`${platform}Followers`];
      const label = `${platform.charAt(0).toUpperCase()}${platform.slice(1)} (from entity)`;

      await insertBridgedLocalAccount({
        userId, platform, label, username,
        email: (email as string) || null,
        password: encryptField((password as string) || null),
        twofa: encryptField((twofa as string) || null),
        followers: (followers as string) || null,
        vaultEntryId,
      });
    } catch (err) {
      console.error(`auto-create local account (${platform}) failed:`, err);
      // best-effort — never block entity create/update
    }
  }
}
