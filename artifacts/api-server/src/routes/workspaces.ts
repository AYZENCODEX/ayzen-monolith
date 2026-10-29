import { Router } from "express";
import { requireAuth, requireSessionAuth } from "../middlewares/auth";
import { requireWorkspaceAccess } from "../middlewares/workspace";
import { createWorkspace, listWorkspacesForUser } from "../lib/workspace-service";
import { beginIdempotentRequest, completeIdempotentRequest, failIdempotentRequest } from "../lib/idempotency-service";

const router = Router();

router.get("/workspaces", requireAuth, async (req, res): Promise<void> => {
  res.json(await listWorkspacesForUser(req.user!.userId));
});

router.post("/workspaces", requireSessionAuth, async (req, res): Promise<void> => {
  const { name, kind } = req.body as { name?: unknown; kind?: unknown };
  if (typeof name !== "string" || (kind !== "personal" && kind !== "organization")) {
    res.status(400).json({ error: "name and kind (personal|organization) are required", code: "INVALID_WORKSPACE_INPUT" });
    return;
  }
  const idempotencyKey = req.header("idempotency-key");
  if (!idempotencyKey) {
    res.status(400).json({ error: "Idempotency-Key is required for workspace creation", code: "IDEMPOTENCY_KEY_REQUIRED" });
    return;
  }
  const scope = `workspace:create:${req.user!.userId}`;
  const idempotency = await beginIdempotentRequest(scope, idempotencyKey, { name, kind });
  if (idempotency.kind === "replay") {
    res.status(idempotency.statusCode).json(idempotency.body);
    return;
  }
  if (idempotency.kind === "in-flight") {
    res.status(409).json({ error: "A request with this Idempotency-Key is already in progress", code: "IDEMPOTENCY_IN_FLIGHT" });
    return;
  }
  if (idempotency.kind === "conflict") {
    res.status(409).json({ error: "Idempotency-Key was already used with a different request", code: "IDEMPOTENCY_CONFLICT" });
    return;
  }
  try {
    const workspace = await createWorkspace({ userId: req.user!.userId, name, kind });
    await completeIdempotentRequest(scope, idempotency.key, 201, workspace as unknown as Record<string, unknown>);
    res.status(201).json(workspace);
  } catch (error) {
    await failIdempotentRequest(scope, idempotencyKey);
    const message = error instanceof Error ? error.message : "Unable to create workspace";
    res.status(message === "User not found" ? 404 : 400).json({ error: message, code: "WORKSPACE_CREATE_FAILED" });
  }
});

router.get("/workspaces/:id", requireAuth, requireWorkspaceAccess, (req, res): void => {
  res.json(req.workspace);
});

export default router;