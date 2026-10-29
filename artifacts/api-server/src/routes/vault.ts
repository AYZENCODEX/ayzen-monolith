import { Router } from "express";
import { requireAuth, requireAdmin, pepDecisionObserver } from "../middlewares/auth";
import { requireCreditBalance } from "../services/credit-meter";
import { getHealthReport, runHealthCheck, runHealthCheckForAll } from "../vault/application/entity/health-check";
// Phase 15B — team Activity Log sub-view sources everything from the shared
// Phase 4 activity_log table (subject_type="team"), including vault-usage
// events, instead of a second logging system. logVaultActivity below mirrors
// into it whenever the entry belongs to a team.
import { consumeRevealToken, hasNoEntityPin } from "../vault/security/reveal-token";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { requirePublicAudit } from "../lib/policy/pep/middleware";
import { autoCreateLocalAccountsForEntity } from "../vault/application/local-account/bridge";
import { requireVaultEntryOwnership, auditVaultBulkOwnership } from "../vault/security/entity-ownership";
import {
  listEntities, listEntityTags, listTrashedEntities, getEntity, emptyTrash, trashEntity, restoreEntity, purgeTrashedEntity,
  type EntityLifecycleDeps,
} from "../vault/application/entity/lifecycle";
import { createEntity } from "../vault/application/entity/create";
import { revealSeedPhrase, type SecretRevealDeps } from "../vault/application/secret/reveal";
import { setDriveWallet, validateSecretKey, refreshWalletWorth } from "../vault/application/secret/wallet";
import { updateEntity, updateEntityField, listEntityFieldHistory, type EntityUpdateDeps } from "../vault/application/entity/update";
import { bulkTagEntities, bulkActionEntities } from "../vault/application/entity/bulk";
import { getGasOverviewForUser, getEntityGas, getEntityAnalytics, getEntityValueHistory } from "../vault/application/entity/analytics";
import { listMyVaultActivity, listEntityActivity } from "../vault/application/entity/activity-feed";
import { adminListEntities, adminFullVault, adminListLocalAccounts, adminListVaultUsers, adminGetUserVault, adminVaultActivityFeed } from "../vault/application/entity/admin";
import { createReceiptLink, revokeReceiptLink, resolvePublicReceipt, buildReceiptPdfSpec } from "../vault/application/entity/receipt";
import { broadcastEvent } from "../lib/event-hub";

const router = Router();

// VLT-GAP-01-B: entity lifecycle use-cases live in vault/application/entity/lifecycle.ts;
// the SSE broadcaster (owned by the API layer) is injected as a port.
const lifecycleDeps: EntityLifecycleDeps = { broadcastEvent };
// VLT-GAP-01-D: remaining entity use-cases (create/update/bulk/analytics/activity/admin/receipt) live in
// vault/application/entity/*. The local-account bridge (GAP-02) and health runner (GAP-11) are still
// owned by this file and are injected into the use-cases as ports until their own phases move them.
const updateDeps: EntityUpdateDeps = { broadcastEvent, autoCreateLocalAccounts: autoCreateLocalAccountsForEntity, runHealthCheck };
// VLT-GAP-05-B: seed reveal / drive wallet / key validation / wallet worth live in vault/application/secret/*.
// The reveal-token owner (vault/security/reveal-token, GAP-06) is injected as a port.
const secretDeps: SecretRevealDeps = { consumeRevealToken, hasNoEntityPin };

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
// Entity ↔ Local bridge (VLT-GAP-02-C): owned by vault/application/local-account/bridge.

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
  const r = await createEntity(req.user!.userId, req.body, { broadcastEvent, autoCreateLocalAccounts: autoCreateLocalAccountsForEntity }, req.header("idempotency-key") || undefined);
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
  const r = await getHealthReport(req.user!.userId);
  res.status(r.status).json(r.body);
});

// ─── POST /vault/health-check — run the rules engine across all of the ──────
// user's entries now (in addition to the automatic check on every PATCH),
// auto-recalculating scores and firing notifications for newly-flagged issues.
router.post("/vault/health-check", requireAuth, async (req, res): Promise<void> => {
  const r = await runHealthCheckForAll(req.user!.userId);
  res.status(r.status).json(r.body);
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
  const out = await revealSeedPhrase(req.user!.userId, req.params.id, req.header("x-reveal-token"), req.query.revealToken, secretDeps);
  res.status(out.status).json(out.body);
});

// ─── PATCH /vault/:id/drive-wallet — set the fixed Drive wallet record ───────
// Wallet → Drive is a one-time, unedited fixed record (per spec): once set,
// it can never be changed or cleared through this endpoint.
router.patch("/vault/:id/drive-wallet", requireAuth, requireVaultEntryOwnership("vault_entry.drive_wallet.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const out = await setDriveWallet(req.user!.userId, req.params.id, req.body);
  res.status(out.status).json(out.body);
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
  const out = await validateSecretKey(req.body);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/:id/refresh-wallet-worth — live multi-chain balance pull ────
// Reads every address in walletAddresses + driveWalletAddress, checks each one
// against ETH/BASE/MATIC/BSC/ARB/OP via read-only RPC (ethers v6, same pattern
// as routes/wallets.ts), sums native-coin USD value, and stores it on
// walletWorthUsd — no manual worth entry needed for the wallet portion.
router.post("/vault/:id/refresh-wallet-worth", requireAuth, requireVaultEntryOwnership("vault_entry.wallet_worth.update", (_req, res) => { res.status(404).json({ error: "Vault entry not found" }); }), async (req, res): Promise<void> => {
  const out = await refreshWalletWorth(req.user!.userId, req.params.id);
  res.status(out.status).json(out.body);
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
