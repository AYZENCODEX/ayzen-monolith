import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { readClerkConfig } from "../lib/clerk-config";
import { verifySvixSignature } from "../lib/svix-verify";
import { isKnownModuleId } from "../lib/module-session-policy";
import { poolAuthDb } from "../lib/module-auth-service";
import { clerkUserCreated, clerkUserDeleted } from "../lib/module-clerk-service";

/**
 * W1-P5 (req 8) — POST /api/webhooks/clerk/:module. One endpoint per module, each verified with THAT module's Svix secret
 * (CLERK_<M>_WEBHOOK_SECRET), so an event signed by one module's Clerk application cannot touch another module's accounts.
 * The raw body is needed for the signature, so app.ts carves this prefix out before the JSON parser.
 *   user.created -> provision module account (idempotent)      user.deleted -> close account, revoke sessions
 * Any other event type is acknowledged and ignored. Unknown/unconfigured module: 404. Bad signature: 400.
 */
export const CLERK_WEBHOOK_PREFIX = "/api/webhooks/clerk";
const router = Router();
const authDb = poolAuthDb(pool);

function primaryEmail(data: any): { email?: string; verified: boolean } {
  const list: any[] = Array.isArray(data?.email_addresses) ? data.email_addresses : [];
  const e = list.find((x) => x?.id === data?.primary_email_address_id) ?? list[0];
  if (!e || typeof e.email_address !== "string") return { verified: false };
  return { email: e.email_address, verified: e.verification?.status === "verified" };
}

router.post(`${CLERK_WEBHOOK_PREFIX}/:module`, async (req: Request, res: Response): Promise<void> => {
  const module = req.params.module;
  const cfg = isKnownModuleId(module) ? readClerkConfig(module) : null;
  if (!cfg) { res.status(404).json({ error: "Not found" }); return; }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const v = verifySvixSignature({
    secret: cfg.webhookSecret, body: raw,
    id: req.header("svix-id") ?? "", timestamp: req.header("svix-timestamp") ?? "", signature: req.header("svix-signature") ?? "",
  });
  if (!v.ok) { logger.warn({ module, reason: v.reason }, "clerk.webhook.rejected"); res.status(400).json({ error: "Invalid signature" }); return; }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { res.status(400).json({ error: "Invalid body" }); return; }
  try {
    if (evt?.type === "user.created" && typeof evt.data?.id === "string") {
      const { email, verified } = primaryEmail(evt.data);
      const r = await clerkUserCreated(authDb, { module, clerkUserId: evt.data.id, email, emailVerified: verified });
      if (!r.ok) { res.status(400).json({ error: "Rejected", code: r.code }); return; }
    } else if (evt?.type === "user.deleted" && typeof evt.data?.id === "string") {
      const r = await clerkUserDeleted(authDb, { module, clerkUserId: evt.data.id });
      if (!r.ok) { res.status(400).json({ error: "Rejected", code: r.code }); return; }
    }
  } catch (err) {
    // 500 makes Clerk/Svix retry; both handlers are idempotent.
    logger.error({ err, module }, "clerk.webhook.failed");
    res.status(500).json({ error: "Internal error" });
    return;
  }
  res.json({ received: true });
});

export default router;
