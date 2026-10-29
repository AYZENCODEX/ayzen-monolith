// MKT-01b stub of middlewares/auth.ts: identity comes from the `x-test-user` header, e.g. {"userId":3,"role":"admin"}.
// Only what the Marketplace route files import is provided. The real module is covered by its own tests.
import type { NextFunction, Request, Response } from "express";

export interface AuthUser { userId: number; role: string; username?: string; authType?: string }

function readUser(req: Request): AuthUser | null {
  const raw = req.headers["x-test-user"];
  if (typeof raw !== "string") return null;
  try {
    const u = JSON.parse(raw);
    return { userId: Number(u.userId), role: String(u.role ?? "user"), username: u.username ?? `user${u.userId}`, authType: "session" };
  } catch { return null; }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = readUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN" }); return; }
  (req as any).user = user;
  next();
}
export const requireSessionAuth = requireAuth;
export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as AuthUser | undefined;
    if (!user) { res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN" }); return; }
    if (!roles.includes(user.role)) { res.status(403).json({ error: "Forbidden", code: "NOT_ADMIN" }); return; }
    next();
  };
}
export const requireAdmin = requireRoles("admin");
export const requireDev = requireRoles("admin", "dev");
export const pepDecisionObserver = (): void => {};
export function getRequestUser(req: Request): AuthUser | null { return ((req as any).user as AuthUser | undefined) ?? null; }
export function getRequestUserId(req: Request): number | null { return getRequestUser(req)?.userId ?? null; }
