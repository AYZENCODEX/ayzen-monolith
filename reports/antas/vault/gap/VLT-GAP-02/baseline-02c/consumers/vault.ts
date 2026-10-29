import { Router } from "express";
import { db, vaultEntriesTable, usersTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { broadcastEvent } from "./events";
import { requireAuth, requireAdmin, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";
import { encryptField } from "../lib/vault-crypto";
import { computeAutoScore, evalHealthRules, severityEmoji, type VaultHealthInput } from "../vault/application/health";
import { createNotification } from "./notifications";
import { sendToUser } from "../lib/telegram";
// Phase 15B — team Activity Log sub-view sources everything from the shared
// Phase 4 activity_log table (subject_type="team"), including vault-usage
// events, instead of a second logging system. logVaultActivity below mirrors
// into it whenever the entry belongs to a team.
import { consumeRevealToken, hasNoEntityPin } from "./vault-security";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { requirePublicAudit } from "../lib/policy/pep/middleware";
import { decryptSeedPhrase } from "../vault/crypto/seed-phrase";
import { formatVaultEntry as formatRow } from "../vault/application/entity/representation";
import { logVaultActivity } from "../vault/application/entity/activity";
import { requireVaultEntryOwnership, auditVaultBulkOwnership } from "../vault/security/entity-ownership";
import { selectVault, selectVaultOne } from "../vault/infrastructure/repositories/entity-repository";
import {
  listEntities, listEntityTags, listTrashedEntities, getEntity, emptyTrash, trashEntity, restoreEntity, purgeTrashedEntity,
  type EntityLifecycleDeps,
} from "../vault/application/entity/lifecycle";
import { createEntity } from "../vault/application/entity/create";
import { updateEntity, updateEntityField, listEntityFieldHistory, type EntityUpdateDeps } from "../vault/application/entity/update";
import { bulkTagEntities, bulkActionEntities } from "../vault/application/entity/bulk";
import { getGasOverviewForUser, getEntityGas, getEntityAnalytics, getEntityValueHistory } from "../vault/application/entity/analytics";
import { listMyVaultActivity, listEntityActivity } from "../vault/application/entity/activity-feed";
import { adminListEntities, adminFullVault, adminListLocalAccounts, adminListVaultUsers, adminGetUserVault, adminVaultActivityFeed } from "../vault/application/entity/admin";
import { createReceiptLink, revokeReceiptLink, resolvePublicReceipt, buildReceiptPdfSpec } from "../vault/application/entity/receipt";

const router = Router();

// VLT-GAP-01-B: entity lifecycle use-cases live in vault/application/entity/lifecycle.ts;
// the SSE broadcaster (owned by the API layer) is injected as a port.
const lifecycleDeps: EntityLifecycleDeps = { broadcastEvent };
// VLT-GAP-01-D: remaining entity use-cases (create/update/bulk/analytics/activity/admin/receipt) live in
// vault/application/entity/*. The local-account bridge (GAP-02) and health runner (GAP-11) are still
// owned by this file and are injected into the use-cases as ports until their own phases move them.
const updateDeps: EntityUpdateDeps = { broadcastEvent, autoCreateLocalAccounts: autoCreateLocalAccountsForEntity, runHealthCheck };

// ─── Route Integration Roadmap — Season C, Phase C30 (vault.ts core CRUD,
// Season B/Phase B2) ──────────────────────────────────────────────────────
// `GET/PATCH/DELETE /vault/:id` were already correctly scoped —
// `selectVaultOne()`/the `db.update()`/`db.delete()` calls below all filter
// by `and(eq(id), eq(userId, req.user!.userId))` — but that check lived
// only in each handler's own SQL, outside the PDP/audit trail every other
// migrated `:id` route in this series goes through. This reuses C21's
// exported `vaultEntryResource` (`vault-entity-links.ts`) — same
// `vault_entries.user_id` shape entities.ts/value-history.ts already reuse
// — rather than a third copy of the ref-builder. Following entities.ts's
// thin local wrapper (not vault-entity-links.ts's own fixed-404 helper),
// so each route keeps its own pre-existing deny body verbatim: GET/PATCH
// both already return `{ error: "Vault entry not found" }`, DELETE already
// returns `{ message: "Vault entry not found" }` — none of that changes.
// `POST /vault` is a create with no `:id`, nothing exists yet to own, so
// it's out of scope here for the same reason `POST /vault/bulk` and every
// other body-only create route in this series is (see C27/roadmap).

// ── Encrypted column list — single source of truth ─────────────────────────
// Every DB column (snake_case, matching raw SQL row shape) that formatRow()
// below runs through decryptField(). Exported so other modules that need to
// decrypt a raw vault_entries row without going through formatRow() — e.g.
// routes/vault-shares.ts building the "shared with me" view — read the exact
// same list instead of hand-maintaining a second copy that silently drifts
// out of sync with this one. Does NOT include encrypted_seed_phrase, which
// uses its own decryptSeedPhrase()/reveal-token flow, not decryptField().
// Entity ↔ Local bridge — platforms whose tab data can also live as a
// standalone local_accounts row (Twitter/Discord/Telegram; Wallet/Other don't
// have a matching local-account shape).
const BRIDGE_PLATFORMS = ["twitter", "discord", "telegram"] as const;

// When a vault entity (Entity) is created or edited and a platform tab was
// filled in directly (not via LocalEntityPicker's import-from-local flow),
// mirror that platform slot into its own local_accounts row so it also shows
// up under Local — same data, same account, just visible in both places.
// Rows created this way are tagged origin='entity' (vs the 'standalone'
// default) so the Local UI can badge them as auto-created. Best-effort: never
// blocks or fails the calling entity create/edit request.
async function autoCreateLocalAccountsForEntity(
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
      const existing = await db.execute(sql`
        SELECT id FROM local_accounts
        WHERE user_id = ${userId} AND vault_entry_id = ${vaultEntryId} AND category = ${platform}
        LIMIT 1
      `);
      if (existing.rows.length > 0) continue;

      const password = body[`${platform}Password`];
      const email = platform === "telegram" ? body.telegramLinkedEmail : body[`${platform}Email`];
      const twofa = body[`${platform}2fa`];
      const followers = body[`${platform}Followers`];
      const label = `${platform.charAt(0).toUpperCase()}${platform.slice(1)} (from entity)`;

      await db.execute(sql`
        INSERT INTO local_accounts
          (user_id, category, label, username, email, password, twofa, followers, vault_entry_id, origin)
        VALUES
          (${userId}, ${platform}, ${label}, ${username},
           ${(email as string) || null}, ${encryptField((password as string) || null)},
           ${encryptField((twofa as string) || null)}, ${(followers as string) || null},
           ${vaultEntryId}, 'entity')
      `);
    } catch (err) {
      console.error(`auto-create local account (${platform}) failed:`, err);
      // best-effort — never block entity create/update
    }
  }
}

// ─── Health Monitor runner ────────────────────────────────────────────────────
// Best-effort, fire-and-forget (same pattern as logVaultActivity/syncOnVaultUpdate
// below) — never blocks or fails the calling request.
export function toHealthInput(formatted: ReturnType<typeof formatRow>): VaultHealthInput {
  return {
    score: Number((formatted as any).score ?? 5),
    lastLoginAt: (formatted as any).lastLoginAt ?? null,
    hasTwitter2fa: (formatted as any).twitterUsername ? !!(formatted as any).twitter2fa : undefined,
    hasDiscord2fa: (formatted as any).discordUsername ? !!(formatted as any).discord2fa : undefined,
    hasTelegram2fa: (formatted as any).telegramUsername ? !!(formatted as any).telegram2fa : undefined,
    hasEmail2fa: (formatted as any).email ? !!(formatted as any).email2fa : undefined,
    hasAccountPassword: !!(formatted as any).accountPassword,
    email: (formatted as any).email ?? null,
    status: (formatted as any).status ?? "active",
    hasRecoveryEmail: !!(formatted as any).emailRecovery,
  };
}

async function runHealthCheck(id: number, userId: number, recalcScore: boolean): Promise<void> {
  const raw = await selectVaultOne(id, userId);
  if (!raw) return;
  const formatted = formatRow(raw);
  const input = toHealthInput(formatted);

  const dbUpdates: Record<string, unknown> = {};

  if (recalcScore) {
    const auto = computeAutoScore(input);
    if (auto !== input.score) {
      dbUpdates.score = auto;
      input.score = auto;
    }
  }

  const hits = evalHealthRules(input);
  const prevFlags: string[] = Array.isArray((formatted as any).lastHealthFlags) ? (formatted as any).lastHealthFlags : [];
  const currentIds = hits.map(h => h.id);
  const newHits = hits.filter(h => !prevFlags.includes(h.id));

  if (currentIds.join(",") !== prevFlags.join(",")) {
    dbUpdates.lastHealthFlags = JSON.stringify(currentIds);
  }
  if (newHits.length > 0) {
    dbUpdates.lastHealthAlertAt = new Date();
  }

  if (Object.keys(dbUpdates).length > 0) {
    try {
      await db.update(vaultEntriesTable).set(dbUpdates as Partial<typeof vaultEntriesTable.$inferInsert>)
        .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)));
    } catch (err) {
      console.error("vault health-check update failed:", err);
    }
  }

  if (newHits.length === 0) return;

  const label = formatted.projectName;
  const worst = newHits.find(h => h.severity === "alert") ?? newHits[0];
  const summary = newHits.map(h => `${severityEmoji(h.severity)} ${h.message}`).join("\n");

  createNotification(
    userId,
    "vault_health",
    `Vault Health: ${worst.severity === "alert" ? "Alert" : worst.severity === "warn" ? "Warning" : "Flag"} — ${label}`,
    summary,
    { vaultEntryId: id, ruleIds: currentIds },
  ).catch(() => {});

  db.select({ telegramChatId: usersTable.telegramChatId }).from(usersTable)
    .where(eq(usersTable.id, userId)).limit(1)
    .then(rows => {
      const chatId = rows[0]?.telegramChatId;
      if (!chatId) return;
      return sendToUser(chatId, `${severityEmoji(worst.severity)} *Vault Health*\n\n${label}\n\n${summary}`);
    })
    .catch(() => {});
}

// Exported for vault-migration.ts's bulk importer, which creates entries the
// same way this route does — one entitySerial generator, not two.

// ─── GET /vault — list user's vault entries ──────────────────────────────────
router.get("/vault", requireAuth, async (req, res): Promise<void> => {
  const r = await listEntities(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/gas-overview — gas health across every one of the user's ────
// vault entities in one call. Powers the "Gas" tab on the entities list page:
// total native-coin (gas) value on hand, the worst risk level seen anywhere
// (drives a banner/badge), and a per-entity risk summary so at-a-glance you
// can see which entities are running low before a farmed account gets stuck
// mid-transaction with no gas to finish it.
router.get("/vault/gas-overview", requireAuth, async (req, res): Promise<void> => {
  const r = await getGasOverviewForUser(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/:id/gas — gas health for one entity, per chain, with the ────
// same real-time simulation as the overview (live gas price + how many more
// native sends / ERC-20 transfers the current balance covers on each chain).
// This is what renders when an entity is clicked open onto its own Gas tab.
router.get("/vault/:id/gas", requireAuth, requireVaultEntryOwnership("vault_entry.gas.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await getEntityGas(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

// ─── POST /vault — create vault entry ────────────────────────────────────────
router.post("/vault", requireAuth, async (req, res): Promise<void> => {
  const r = await createEntity(req.user!.userId, req.body, { broadcastEvent, autoCreateLocalAccounts: autoCreateLocalAccountsForEntity });
  res.status(r.status).json(r.body);
});

// ─── GET /vault/tags — distinct tags used by this user, for filter UI ────────
router.get("/vault/tags", requireAuth, async (req, res): Promise<void> => {
  const r = await listEntityTags(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── Route Integration Roadmap — Season C, Phase C27 (bulk-family
// policy-engine consistency sweep) ────────────────────────────────────────
// `PATCH /vault/bulk-tag` and `PATCH /vault/bulk-action` were already
// correctly scoped — every per-id write below already goes through
// Drizzle's `and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId,
// userId))`, same posture as the raw-SQL `WHERE ... AND user_id = ...`
// routes in `bulk.ts`/`vault-shares.ts`. This phase does not change that —
// it adds the same `authorizeMany()`/`pepDecisionObserver` audit trail
// those files' bulk routes just got, using the vault_entries table's own
// `vault_entry` resource type (`vault-entity-links.ts`, C21) so decisions
// here correlate with every other vault_entry PEP check in the codebase.
// Both routes loop per-id already (never one batched UPDATE), so the audit
// step runs once up front over the full id list, then the existing per-id
// loop proceeds completely unchanged.
// ─── PATCH /vault/bulk-tag — add or remove a tag across multiple entries ─────
router.patch("/vault/bulk-tag", requireAuth, async (req, res): Promise<void> => {
  const r = await bulkTagEntities(req.user!.userId, req.body, { broadcastEvent, auditBulkOwnership: (ids, action) => auditVaultBulkOwnership(req, ids, action) });
  res.status(r.status).json(r.body);
});

// ─── PATCH /vault/bulk-action — generic multi-select action (tag/status/delete) ─
// Single entry point for the vault.tsx selection action-bar. `action: "tag"`
// mirrors /vault/bulk-tag above (kept separately for backward compat — nothing
// else calls it, so this just avoids duplicating that logic inline). Every
// path is per-id + best-effort, same pattern as bulk-tag: one bad/missing id
// doesn't abort the rest of the batch, and the response reports per-id results
// so the client can tell the user "8 of 10 succeeded" instead of a flat pass/fail.

router.patch("/vault/bulk-action", requireAuth, async (req, res): Promise<void> => {
  const r = await bulkActionEntities(req.user!.userId, req.body, { broadcastEvent, auditBulkOwnership: (ids, action) => auditVaultBulkOwnership(req, ids, action) });
  res.status(r.status).json(r.body);
});

// ─── GET /vault/health-report — dashboard panel: counts by health issue ─────
router.get("/vault/health-report", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = await selectVault(userId);
    const formatted = entries.map(e => formatRow(e));

    let lowScore = 0, missing2fa = 0, inactive30d = 0, bannedOrSuspended = 0;
    const flagged: Record<string, unknown>[] = [];

    for (const f of formatted) {
      const input = toHealthInput(f);
      const hits = evalHealthRules(input);
      if (hits.length > 0) {
        flagged.push({
          id: (f as any).id,
          entitySerial: (f as any).entitySerial,
          projectName: (f as any).projectName,
          score: input.score,
          hits,
        });
      }
      if (hits.some(h => h.id === "low_score")) lowScore++;
      if (hits.some(h => h.id === "missing_2fa")) missing2fa++;
      if (hits.some(h => h.id === "inactive_30d")) inactive30d++;
      if (hits.some(h => h.id.startsWith("status_"))) bannedOrSuspended++;
    }

    res.json({
      totalEntries: formatted.length,
      counts: { lowScore, missing2fa, inactive30d, bannedOrSuspended },
      flaggedEntries: flagged,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate health report", detail: err?.message });
  }
});

// ─── POST /vault/health-check — run the rules engine across all of the ──────
// user's entries now (in addition to the automatic check on every PATCH),
// auto-recalculating scores and firing notifications for newly-flagged issues.
router.post("/vault/health-check", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const entries = await selectVault(userId);
    await Promise.all(entries.map(e => runHealthCheck(Number((e as any).id), userId, true).catch(() => {})));
    res.json({ checked: entries.length });
  } catch (err: any) {
    res.status(500).json({ error: "Health check failed", detail: err?.message });
  }
});

// ─── GET /vault/analytics — portfolio overview, per-platform breakdown, ─────
// value trend, and best/worst performers by ROI.
router.get("/vault/analytics", requireAuth, async (req, res): Promise<void> => {
  const r = await getEntityAnalytics(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/analytics/value-history — value_history rows for charting ───
router.get("/vault/analytics/value-history", requireAuth, async (req, res): Promise<void> => {
  const r = await getEntityValueHistory(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/activity — my Vault activity feed (owner, paginated) ────────
// Powers the "Activity Log" item in the Vault sidebar (Other group) — every
// row is scoped to the current user's own vault_activity_log entries only
// (entity views + creates/updates/deletes/seed-reveals/status changes),
// distinct from GET /admin/vault/activity which is the admin-wide feed across
// every user. Joined with vault_entries so each row can show which entity
// ("page") was touched, not just an id.
// NOTE: must be registered before GET /vault/:id below — otherwise Express
// would match "activity" as the :id param and this route would never fire
// (same reason /vault/analytics/value-history above is also a static path
// registered ahead of the :id catch-all).
router.get("/vault/activity", requireAuth, async (req, res): Promise<void> => {
  const r = await listMyVaultActivity(req.user!.userId, req.query);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/trash — list this user's soft-deleted entries ───────────────
// Must be registered before GET /vault/:id below — both are 2 path segments
// ("/vault/trash" vs "/vault/:id"), and Express matches registration order
// within the same segment shape, so "trash" would otherwise be swallowed as
// an :id.
router.get("/vault/trash", requireAuth, async (req, res): Promise<void> => {
  const r = await listTrashedEntities(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/:id — get single entry ───────────────────────────────────────
// PHASE 5 (admin credit console request): entity view is now a metered
// action (sylo.vault_entity_view) — charge-on-success, same two-step
// pattern as every other integration point in services/credit-meter.ts.
router.get("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), requireCreditBalance("sylo.vault_entity_view"), async (req, res): Promise<void> => {
  const r = await getEntity(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/:id/seed — reveal decrypted seed phrase (explicit opt-in) ───
// Requires a fresh, single-use reveal token minted by a successful entity-PIN
// verify (POST /vault/security/verify, kind="entity") — see routes/
// vault-security.ts. Closes the gap where requireAuth alone (i.e. a merely
// valid session) was enough to pull a plaintext seed phrase with no PIN
// check at all, bypassing the frontend gate entirely. Users who haven't set
// an entity PIN keep the old "nothing to gate on" behavior.
//
// PHASE 5 (admin credit console request): revealing the credential/seed is
// the highest-stakes read in Sylo, so it's the pricier of the two new vault
// actions (sylo.credential_access vs. sylo.vault_entity_view above).
//
// PHASE 8 (Organization Accounts): also gated on the caller's org
// extension policy — see the org-membership check inside the handler.
router.get("/vault/:id/seed", requireAuth, requireVaultEntryOwnership("vault_entry.seed.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), requireCreditBalance("sylo.credential_access"), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  // Phase 8 — managed extension policy (master plan §2/§9). An org
  // owner/admin can set organization_extension_policies.disable_seed_reveal
  // to block this endpoint for every ACTIVE member of that org, regardless
  // of which entity they're revealing — enforced here server-side (not
  // just an Astra UI toggle) since this route is the actual seed-reveal
  // choke point every other read/autofill path already goes through. Any
  // one org membership with the flag set is enough to block; a user who
  // wants seed reveal back has to leave that org or ask an admin to relax
  // the policy, not bypass it entity-by-entity.
  const orgBlock = (await db.execute(sql`
    SELECT 1 FROM organization_members om
    JOIN organization_extension_policies oep ON oep.organization_id = om.organization_id
    WHERE om.user_id = ${userId} AND om.status = 'active' AND oep.disable_seed_reveal = TRUE
    LIMIT 1
  `)).rows;
  if (orgBlock.length) {
    res.status(403).json({
      error: "Seed phrase reveal is disabled by your organization's extension policy",
      code: "ORG_SEED_REVEAL_DISABLED",
    });
    return;
  }

  const pinless = await hasNoEntityPin(userId);
  if (!pinless) {
    const token = (req.header("x-reveal-token") ?? req.query.revealToken) as string | undefined;
    if (!consumeRevealToken(userId, token)) {
      res.status(403).json({
        error: "Reveal token missing or expired",
        code: "REVEAL_TOKEN_REQUIRED",
        solution: "Verify your entity PIN again — the reveal token is single-use and expires quickly.",
      });
      return;
    }
  }

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  const encSeed = entry.encrypted_seed_phrase ?? entry.encryptedSeedPhrase ?? null;
  if (!encSeed) { res.status(404).json({ error: "No seed phrase stored for this entity" }); return; }
  const plaintext = decryptSeedPhrase(encSeed as string);
  if (!plaintext) { res.status(500).json({ error: "Failed to decrypt seed phrase" }); return; }
  logVaultActivity(id, userId, "seed_revealed");
  // Charge-on-success: only after the seed was actually decrypted and is
  // about to be returned — a missing seed / decrypt failure above never
  // costs the user credits.
  const charge = await chargeCredits(userId, "sylo.credential_access");
  res.json({ seedPhrase: plaintext, _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
});

// ─── PATCH /vault/:id/drive-wallet — set the fixed Drive wallet record ───────
// Wallet → Drive is a one-time, unedited fixed record (per spec): once set,
// it can never be changed or cleared through this endpoint.
router.patch("/vault/:id/drive-wallet", requireAuth, requireVaultEntryOwnership("vault_entry.drive_wallet.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;
  const { label, address, note } = req.body;
  if (!address || !String(address).trim()) { res.status(400).json({ error: "Wallet address is required" }); return; }

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }
  const alreadySet = entry.drive_wallet_set_at ?? (entry as any).driveWalletSetAt ?? entry.drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (alreadySet) { res.status(409).json({ error: "Drive wallet is already set and cannot be edited" }); return; }

  try {
    const [row] = await db.update(vaultEntriesTable)
      .set({
        driveWalletLabel: label || null,
        driveWalletAddress: String(address).trim(),
        driveWalletNote: note || null,
        driveWalletSetAt: new Date(),
        updatedAt: new Date(),
      } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }
    logVaultActivity(id, userId, "drive_wallet_set");
    res.json(formatRow(row as unknown as Record<string, unknown>));
  } catch (err: any) {
    res.status(500).json({ error: "Unable to save drive wallet", detail: err?.message });
  }
});

// ─── POST /vault/validate-key — pre-save seed phrase / private key check ────
// Validates the credential entered in the entity form's "Add Private Key"
// field *before* it gets encrypted and saved, so the user finds out
// immediately if they mistyped a word or dropped a character, instead of
// discovering it later when something tries to derive an address from a
// silently-broken value. Pure offline BIP-39 / secp256k1 check — see
// lib/wallet-key-validation.ts. No entity id needed; this runs against
// whatever is currently typed into the create/edit form.
router.post("/vault/validate-key", requireAuth, async (req, res): Promise<void> => {
  const { value } = req.body as { value?: string };
  if (typeof value !== "string" || !value.trim()) {
    res.status(400).json({ error: "value is required" });
    return;
  }
  const { validateWalletKey } = await import("../lib/wallet-key-validation");
  res.json(validateWalletKey(value));
});

// ─── POST /vault/:id/refresh-wallet-worth — live multi-chain balance pull ────
// Reads every address in walletAddresses + driveWalletAddress, checks each one
// against ETH/BASE/MATIC/BSC/ARB/OP via read-only RPC (ethers v6, same pattern
// as routes/wallets.ts), sums native-coin USD value, and stores it on
// walletWorthUsd — no manual worth entry needed for the wallet portion.
router.post("/vault/:id/refresh-wallet-worth", requireAuth, requireVaultEntryOwnership("vault_entry.wallet_worth.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const userId = req.user!.userId;

  const entry = await selectVaultOne(id, userId);
  if (!entry) { res.status(404).json({ error: "Vault entry not found" }); return; }

  const rawWalletAddresses = (entry as any).wallet_addresses ?? (entry as any).walletAddresses;
  let addresses: string[] = [];
  try { addresses = rawWalletAddresses ? JSON.parse(rawWalletAddresses as string) : []; } catch { addresses = []; }
  const driveAddress = (entry as any).drive_wallet_address ?? (entry as any).driveWalletAddress;
  if (driveAddress) addresses = [...addresses, driveAddress];

  if (addresses.length === 0) {
    res.status(400).json({ error: "This entity has no wallet addresses to check" }); return;
  }

  try {
    const { getMultiChainWalletWorth } = await import("../lib/chain-balance");
    const summary = await getMultiChainWalletWorth(addresses);

    const [row] = await db.update(vaultEntriesTable)
      .set({
        walletWorthUsd: summary.totalUsd,
        walletWorthSyncedAt: new Date(),
        updatedAt: new Date(),
      } as Partial<typeof vaultEntriesTable.$inferInsert>)
      .where(and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Vault entry not found" }); return; }

    logVaultActivity(id, userId, "wallet_worth_refreshed");
    res.json({
      walletWorthUsd: summary.totalUsd,
      walletWorthSyncedAt: (row as any).walletWorthSyncedAt,
      breakdown: summary.results.filter((r) => r.balance > 0 || r.error),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Unable to refresh live wallet worth", detail: err?.message });
  }
});

// ─── PATCH /vault/:id — update vault entry ───────────────────────────────────
router.patch("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await updateEntity(req.user!.userId, req.params.id, req.body, updateDeps);
  res.status(r.status).json(r.body);
});

// ─── PATCH /vault/:id/field — update exactly one field, with commit history ──
// Powers the per-field "Change" button on the entity detail page (per
// platform tab, per field): edit one credential/value in place instead of
// the whole multi-tab form. Body: { field: string, value: unknown }. The
// old → new value is recorded in vault_field_history — see
// GET /vault/:id/field-history for the commit log this powers.
router.patch("/vault/:id/field", requireAuth, requireVaultEntryOwnership("vault_entry.field.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await updateEntityField(req.user!.userId, req.params.id, req.body, updateDeps);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/:id/field-history — per-field commit history (owner only) ───
// Query: ?field=twitterPassword to filter to one field's history, omit for
// the full per-field change feed on this entity. Newest first.
router.get("/vault/:id/field-history", requireAuth, requireVaultEntryOwnership("vault_entry.field_history.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await listEntityFieldHistory(req.user!.userId, req.params.id, req.query);
  res.status(r.status).json(r.body);
});

// ─── DELETE /vault/:id — delete vault entry ──────────────────────────────────
// ─── DELETE /vault/trash — empty the whole trash for this user ──────────────
// Must be registered before DELETE /vault/:id below — same segment-shadowing
// reasoning as GET /vault/trash above ("/vault/trash" vs "/vault/:id").
router.delete("/vault/trash", requireAuth, async (req, res): Promise<void> => {
  const r = await emptyTrash(req.user!.userId, lifecycleDeps);
  res.status(r.status).json(r.body);
});

// Soft-delete — moves the entry to the recycle bin (deleted_at = now) instead
// of removing the row. It disappears from every normal list/detail/health
// read immediately (selectVault* filters deleted_at IS NULL), but stays
// recoverable via POST /vault/:id/restore until the retention cron purges it.
router.delete("/vault/:id", requireAuth, requireVaultEntryOwnership("vault_entry.delete", (_req, res) => { res.status(404).json({ message: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await trashEntity(req.user!.userId, req.params.id, lifecycleDeps);
  res.status(r.status).json(r.body);
});

// ─── POST /vault/:id/restore — pull an entry back out of the trash ──────────
// 3 path segments, so registration order relative to "/vault/:id" (2
// segments) doesn't matter — Express only shadows routes with the same
// segment shape. Left here, right after the delete handler it undoes.
router.post("/vault/:id/restore", requireAuth, requireVaultEntryOwnership("vault_entry.restore", (_req, res) => { res.status(404).json({ message: "Trashed vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await restoreEntity(req.user!.userId, req.params.id, lifecycleDeps);
  res.status(r.status).json(r.body);
});

// ─── DELETE /vault/trash/:id — permanently purge one trashed entry ──────────
// Must be trashed first (deleted_at IS NOT NULL) — this is the only route
// that actually removes the row; DELETE /vault/:id above only soft-deletes.
// 3 segments — same non-shadowing reasoning as POST /vault/:id/restore above.
router.delete("/vault/trash/:id", requireAuth, requireVaultEntryOwnership("vault_entry.purge", (_req, res) => { res.status(404).json({ message: "Trashed vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await purgeTrashedEntity(req.user!.userId, req.params.id, lifecycleDeps);
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault — admin view of all entries ────────────────────────────
router.get("/admin/vault", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminListEntities();
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault/full — full unencrypted vault for admin ─────────────────
router.get("/admin/vault/full", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminFullVault();
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault/local-accounts — all users' local accounts ──────────────
router.get("/admin/vault/local-accounts", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminListLocalAccounts();
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault/users — list of users with vault data counts ────────────
router.get("/admin/vault/users", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminListVaultUsers();
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault/users/:userId — specific user's full vault data ──────────
router.get("/admin/vault/users/:userId", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminGetUserVault(req.params.userId);
  res.status(r.status).json(r.body);
});

// ─── GET /vault/:id/activity — audit trail for one vault entry (owner only) ──
router.get("/vault/:id/activity", requireAuth, requireVaultEntryOwnership("vault_entry.activity.read", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await listEntityActivity(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

// ─── GET /admin/vault/activity — vault-wide audit feed (admin, paginated) ───
router.get("/admin/vault/activity", requireAdmin, async (req, res): Promise<void> => {
  const r = await adminVaultActivityFeed(req.query);
  res.status(r.status).json(r.body);
});

// ─── Public receipt link ──────────────────────────────────────────────────────
// One shareable, unauthenticated "PnL card" per Vault Entity — same idea as
// the Local Entity receipt (routes/local-accounts.ts) and the Finance
// ledger receipt (routes/finance.ts), but sourced from computeEntityWorth's
// aggregate across the entity + all linked platforms. Only "worth showing
// off" fields are exposed — no credentials, 2FA, backup codes, wallet
// addresses, or seed phrase, even though those are already encrypted at rest.

// POST /vault/:id/receipt — mint (or fetch the existing) public link
router.post("/vault/:id/receipt", requireAuth, requireVaultEntryOwnership("vault_entry.receipt.create", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await createReceiptLink(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

// DELETE /vault/:id/receipt — revoke the public link
router.delete("/vault/:id/receipt", requireAuth, requireVaultEntryOwnership("vault_entry.receipt.delete", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const r = await revokeReceiptLink(req.user!.userId, req.params.id);
  res.status(r.status).json(r.body);
});

// GET /vault/receipt/:token — public, no auth
router.get("/vault/receipt/:token", requirePublicAudit("vault_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const r = await resolvePublicReceipt(req.params.token);
  res.status(r.status).json(r.body);
});

// GET /vault/receipt/:token/pdf — public, no auth
router.get("/vault/receipt/:token/pdf", requirePublicAudit("vault_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const r = await resolvePublicReceipt(req.params.token);
  if (!r.receipt) { res.status(r.status).json(r.body); return; }
  streamFantasticReceiptPdf(res, buildReceiptPdfSpec(r.receipt));
});

export default router;
