/**
 * routes/vault-security.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5 — Vault Security: PINs & Session.
 *
 * Two independent 4-digit PINs per user, both hashed with bcrypt (lib/password.ts
 * — the same helper used for account passwords) and never stored or returned
 * in plaintext:
 *
 *   vaultPin  — unlocks Vault itself. Gated on the frontend by every /vault/*
 *               route (see components/vault/vault-unlock-gate.tsx). "Keep me
 *               signed in" is a purely client-side session length choice (see
 *               lib/vault-lock.ts) — the server only ever verifies a PIN, it
 *               never issues or tracks a separate vault session token.
 *   entityPin — required to view any entity's details. One shared PIN across
 *               every entity (not per-entity) — see components/vault/entity-pin-gate.tsx.
 *
 * Changing one PIN never reads or writes the other column.
 *
 * A NULL hash means that PIN has never been set. GET /vault/security/status
 * reports this so the frontend gates can skip locking on it (letting a new
 * user reach /vault/security to set their first PIN without being locked out
 * of the very page that sets it).
 *
 * Brute-force protection on the two /verify endpoints is a simple in-memory
 * lockout (5 wrong attempts → 60s cooldown per user+kind, owned by
 * vault/security/lockout.ts), on top of the global API rate limiter already
 * applied at the /api level in app.ts. This is intentionally lightweight —
 * good enough for a 4-digit PIN behind a logged-in session, not a
 * replacement for the account password.
 *
 * A successful entity-PIN verify also mints a short-lived, single-use reveal
 * token (owned by vault/security/reveal-token.ts), which
 * GET /vault/:id/seed (routes/vault.ts) now requires. Without this, a leaked
 * session cookie/token alone was enough to call that route directly and get
 * a plaintext seed phrase — the PIN gate only ever lived in the frontend UI.
 *
 * VLT-GAP-06-B: every handler below is a thin delegating adapter. Request
 * parsing, auth-context construction and response mapping stay here; every
 * business decision, DB access and lockout/reveal-token state now lives in
 * vault/security/* and vault/application/security/* (see those files for the
 * moved implementations — bodies are unchanged from the pre-extraction
 * version, including the lockout limits, PIN rules and email template).
 */
import { Router } from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { otpLimiter } from "../middlewares/security";
import { getVaultSecurityStatus } from "../vault/application/security/status";
import { setAuthStepPolicy } from "../vault/application/security/auth-policy";
import { sendVaultPinSetupCode } from "../vault/application/security/pin-setup-code";
import { setPin } from "../vault/application/security/pin";
import { verifyPin } from "../vault/application/security/verify";
import { setVaultPassword, disableVaultPassword } from "../vault/application/security/password";
import { getVaultTwoFaStatus, setupVaultTwoFa, verifyVaultTwoFa, disableVaultTwoFaRoute } from "../vault/application/security/two-fa";

const router = Router();

// ─── GET /vault/security/status ────────────────────────────────────────────
router.get("/vault/security/status", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await getVaultSecurityStatus(userId);
  res.status(out.status).json(out.body);
});

// ─── PUT /vault/security/auth-policy — how many re-auth steps are required ──
// Body: { policy: "any" | "step12" | "step123", vaultPin? }. See
// schema/vault-security.ts's authStepPolicy comment and routes/vault-reauth
// .ts for what each value means.
router.put("/vault/security/auth-policy", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { policy, vaultPin } = req.body ?? {};
  const out = await setAuthStepPolicy(userId, policy, vaultPin);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/pin/request-code — step 1 of setting/changing the
// mandatory Vault Security PIN ───────────────────────────────────────────
// Sends a 6-digit email code to the account's own email. PUT
// /vault/security/pin (kind="vault") then requires both this code AND the
// account login password before accepting a new/changed PIN.
router.post("/vault/security/pin/request-code", requireAuth, otpLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await sendVaultPinSetupCode(userId);
  res.status(out.status).json(out.body);
});

// ─── PUT /vault/security/password — set or change the Vault Auth Password ──
// Body: { password, currentPassword? }. currentPassword is required only
// when a vault password is already set. This is intentionally NOT the
// account login password — see schema/vault-security.ts's vaultPasswordHash
// field comment for why.
router.put("/vault/security/password", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { password, currentPassword, vaultPin } = req.body ?? {};
  const out = await setVaultPassword(userId, password, currentPassword, vaultPin);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/password/disable — revert to the account password ─
router.post("/vault/security/password/disable", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await disableVaultPassword(userId, (req.body ?? {}).vaultPin);
  res.status(out.status).json(out.body);
});

// ─── PUT /vault/security/pin — set or change a PIN ─────────────────────────
// kind="entity": Body: { kind: "entity", pin: "1234", currentPin?: "0000" }
// kind="vault": Body: { kind: "vault", pin: "1234", accountPassword,
//   emailCode }. Deliberately heavier — this is the Vault Security PIN,
//   the most powerful credential in Vault (see vault/security/pin-guard.ts's
//   file header).
router.put("/vault/security/pin", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { kind, pin, currentPin, accountPassword, emailCode } = req.body ?? {};
  const out = await setPin(userId, kind, pin, currentPin, accountPassword, emailCode);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/verify — check a PIN without changing anything ──
// Body: { kind: "vault" | "entity", pin: "1234" }
router.post("/vault/security/verify", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { kind, pin } = req.body ?? {};
  const out = await verifyPin(userId, kind, pin);
  res.status(out.status).json(out.body);
});

// ─── Vault 2FA — Vault's OWN TOTP, separate from account login 2FA ──────────
// Same RFC 6238 TOTP flow as routes/security.ts's /security/2fa/*, but reads
// and writes vault_security.vault_two_fa_secret / vault_two_fa_enabled
// instead of users.two_fa_secret / two_fa_enabled.

// ─── GET /vault/security/2fa/status ────────────────────────────────────────
router.get("/vault/security/2fa/status", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const out = await getVaultTwoFaStatus(userId);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/2fa/setup — generate a new secret + QR (not yet enabled) ─
router.post("/vault/security/2fa/setup", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const out = await setupVaultTwoFa(userId);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/2fa/verify — confirm a 6-digit code to enable ───
router.post("/vault/security/2fa/verify", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { token, vaultPin } = req.body ?? {};
  const out = await verifyVaultTwoFa(userId, token, vaultPin);
  res.status(out.status).json(out.body);
});

// ─── POST /vault/security/2fa/disable ──────────────────────────────────────
router.post("/vault/security/2fa/disable", requireAuth, async (req, res) => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await disableVaultTwoFaRoute(userId, (req.body ?? {}).vaultPin);
  res.status(out.status).json(out.body);
});

export default router;
