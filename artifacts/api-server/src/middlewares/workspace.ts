import type { NextFunction, Request, Response } from "express";
import { getWorkspaceAccess } from "../lib/workspace-service";

function requestedWorkspaceId(req: Request): number | undefined {
  const routeValue = req.params.workspaceId ?? req.params.id;
  const headerValue = req.gatewayContext?.workspaceId;
  if (routeValue && /^[1-9]\d*$/.test(routeValue)) return Number(routeValue);
  return headerValue;
}

/**
 * Workspace context is explicit and server-authorized. A client may request a
 * workspace through the path/header, but membership is always resolved from
 * the database before req.workspace is populated.
 */
export async function requireWorkspaceAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.user?.userId;
  const workspaceId = requestedWorkspaceId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized", code: "NO_WORKSPACE_USER" });
    return;
  }
  if (!workspaceId || !Number.isSafeInteger(workspaceId)) {
    res.status(400).json({ error: "Workspace is required", code: "WORKSPACE_REQUIRED" });
    return;
  }

  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access || access.status !== "active") {
    res.status(403).json({ error: "Forbidden", code: "WORKSPACE_ACCESS_DENIED" });
    return;
  }
  req.workspace = access;
  next();
}