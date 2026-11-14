import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRoles, getRequestUser } from "../middlewares/auth";
import { listModuleAccounts, findByModuleUid } from "../lib/module-accounts";
import { parseModuleUid } from "@ayzen/identity-context";

/**
 * W1-P1 (req 1) — per-module user ids.
 *   GET /me/modules                                  the caller's id in each module (null = no account yet)
 *   GET /admin/module-accounts/lookup?uid=SYL-000001  admin: resolve a module uid to its account + user
 *   GET /admin/module-accounts/lookup?userId=42       admin: every module account of one user
 * Read-only: accounts are created by signup/backfill/W1-P4, never by a GET.
 */
const router = Router();

router.get("/me/modules", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.json({ modules: await listModuleAccounts(user.userId) });
});

router.get("/admin/module-accounts/lookup", requireAuth, requireRoles("admin"), async (req, res): Promise<void> => {
  const uid = typeof req.query.uid === "string" ? req.query.uid : undefined;
  const userIdRaw = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if ((uid === undefined) === (userIdRaw === undefined)) {
    res.status(400).json({ error: "Pass exactly one of uid or userId", code: "BAD_LOOKUP" });
    return;
  }
  if (uid !== undefined) {
    if (!parseModuleUid(uid.trim().toUpperCase())) {
      res.status(400).json({ error: "uid must look like SYL-000001", code: "BAD_MODULE_UID" });
      return;
    }
    const found = await findByModuleUid(uid);
    if (!found) { res.status(404).json({ error: "Not found", code: "MODULE_UID_NOT_FOUND" }); return; }
    res.json({ account: found.account, user: found.user });
    return;
  }
  const userId = Number(userIdRaw);
  if (!Number.isInteger(userId) || userId < 1) { res.status(400).json({ error: "userId must be a positive integer", code: "BAD_USER_ID" }); return; }
  const [user] = await db.select({ id: usersTable.id, username: usersTable.username, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "Not found", code: "USER_NOT_FOUND" }); return; }
  res.json({ user, modules: (await listModuleAccounts(userId)).filter((m) => m.moduleUid !== null) });
});

export default router;
