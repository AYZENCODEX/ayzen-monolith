/**
 * routes/vault-reauth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault re-authentication — the gate in front of every /vault/* page (see
 * components/vault/vault-unlock-gate.tsx + pages/user/vault-auth.tsx on the
 * frontend). Methods: passkey (/vault/reauth/passkey/{options,verify}), Vault
 * PIN/password + Vault 2FA (/vault/reauth/verify), and the email code + Vault
 * PIN fail-over (/vault/reauth/email-code/send + /vault/reauth/verify-step3).
 * Whether one step or several are required is vault_security.auth_step_policy.
 *
 * VLT-GAP-06-D: every handler below is a thin delegating adapter. Request
 * parsing, the 401 for a missing session and response mapping stay here; all
 * credential checks, lockout state (vault/security/lockout.ts, kind "reauth"),
 * passkey ownership (vault/security/reauth-ownership.ts), DB access
 * (vault/infrastructure/repositories/vault-reauth-repository.ts) and the email
 * template live in vault/application/security/reauth.ts, with bodies, status
 * codes and error codes unchanged from the pre-extraction route. See that file
 * for the full behavior description (the original header is preserved in the
 * frozen 06-A baseline).
 */
import { Router } from "express";
import { requireAuth, getRequestUserId } from "../middlewares/auth";
import { otpLimiter } from "../middlewares/security";
import {
  getReauthStatus, sendReauthEmailCode, verifyStep3, passkeyOptions, verifyPasskey, verifyVaultCredentials,
} from "../vault/application/security/reauth";

const router = Router();

router.get("/vault/reauth/status", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await getReauthStatus(userId);
  res.status(out.status).json(out.body);
});

router.post("/vault/reauth/email-code/send", requireAuth, otpLimiter, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await sendReauthEmailCode(userId);
  res.status(out.status).json(out.body);
});

router.post("/vault/reauth/verify-step3", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await verifyStep3(userId, req.body);
  res.status(out.status).json(out.body);
});

router.post("/vault/reauth/passkey/options", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await passkeyOptions(req, userId);
  res.status(out.status).json(out.body);
});

router.post("/vault/reauth/passkey/verify", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await verifyPasskey(req, userId, req.body);
  res.status(out.status).json(out.body);
});

router.post("/vault/reauth/verify", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const out = await verifyVaultCredentials(userId, req.body);
  res.status(out.status).json(out.body);
});

export default router;
